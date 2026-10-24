import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as ecc from 'tiny-secp256k1';
import { atomicJson, log, profile, publicBranch, hash160, sha256, targetHash, matchRecord, normalizeBranch } from './model.mjs';
import { readDataset, buildTable, makeLookup } from './dataset.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_GPU = path.join(ROOT, 'build', 'bin', 'index-scan-gpu' + (process.platform === 'win32' ? '.exe' : ''));
const digestFile = (file) => sha256(fs.readFileSync(file)).toString('hex');

function inputFiles(options, dir) {
  const { branch, id } = publicBranch(options);
  fs.mkdirSync(dir, { recursive: true });
  const branchFile = path.join(dir, 'recovery-branch-' + id.slice(0, 16) + '.bin');
  const pub = Buffer.from(branch.publicKey);
  const uncompressed = Buffer.from(ecc.pointCompress(pub, false));
  fs.writeFileSync(branchFile, Buffer.concat([pub, Buffer.from(branch.chainCode), uncompressed.subarray(1)]));
  const generatorFile = path.join(dir, 'recovery-generator-table.bin');
  const table = Buffer.alloc(32 * 255 * 64);
  for (let w = 0; w < 32; w++) {
    const scalar = Buffer.alloc(32);
    for (let digit = 1; digit <= 255; digit++) {
      scalar[31 - w] = digit;
      const point = ecc.pointFromScalar(scalar, false);
      if (!point) throw new Error('Cannot construct generator table.');
      Buffer.from(point).copy(table, (w * 255 + digit - 1) * 64, 1);
    }
  }
  if (!fs.existsSync(generatorFile) || !fs.readFileSync(generatorFile).equals(table)) fs.writeFileSync(generatorFile, table);
  return { branch, id, branchFile, generatorFile };
}


function validateEngine(executable, inputs, start, count) {
  const file = inputs.branchFile + '.validation.bin';
  try {
    const result = spawnSync(executable, ['dump', inputs.branchFile, inputs.generatorFile, String(start), String(count), '64', file], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error('GPU validation failed: ' + (result.error?.message || result.stderr || 'build the CUDA engine first'));
    const bytes = fs.readFileSync(file);
    if (bytes.length !== count * 54) throw new Error('Invalid GPU validation output.');
    for (let i=0;i<count;i++) {
      const off=i*54, pub=Buffer.from(inputs.branch.derive(start+i).publicKey);
      if (bytes[off]!==0 || !bytes.subarray(off+1,off+34).equals(pub) || !bytes.subarray(off+34,off+54).equals(hash160(pub))) throw new Error('GPU/CPU validation mismatch.');
    }
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
}

export async function scanGpu(options = {}) {
  const opt = { start: 0, end: 0x7fffffff, batch: 16384, ...options, ...profile(options) };
  const executable = opt.gpuBinary ?? DEFAULT_GPU;
  const executableSha256 = digestFile(executable);
  const inputs = inputFiles(opt, path.join(path.dirname(opt.status), '.cache'));
  if (!Number.isInteger(opt.start) || !Number.isInteger(opt.end) || opt.start < 0 || opt.start > opt.end || opt.end > 0x7fffffff || !Number.isInteger(opt.batch) || opt.batch < 1 || opt.batch > 1048576) throw new Error('Invalid GPU range/batch.');
  const dataset = readDataset(opt.data, opt);
  validateEngine(executable, inputs, opt.start, Math.min(32, opt.end + 1 - opt.start));
  const built = buildTable(dataset);
  const lookup = makeLookup(built.shared, built.capacity);
  const identity = { branchId: inputs.id, datasetId: dataset.id, executableSha256, start: opt.start, end: opt.end, network: opt.network, addressType: opt.addressType, branch: normalizeBranch(opt.branch) };
  let state = { version: 1, identity, nextIndex: opt.start, matches: [], startedAt: new Date().toISOString() };
  if (fs.existsSync(opt.checkpoint)) {
    state = JSON.parse(fs.readFileSync(opt.checkpoint, 'utf8'));
    if (JSON.stringify(state.identity) !== JSON.stringify(identity)) throw new Error('GPU checkpoint does not match input/binary/range.');
    if (!Number.isInteger(state.nextIndex) || state.nextIndex < opt.start || state.nextIndex > opt.end + 1 || !Array.isArray(state.matches)) throw new Error('Malformed GPU checkpoint.');
  }
  const initial = state.nextIndex, began = performance.now();
  const seen = new Set(state.matches.map((m) => m.index));
  const save = (phase) => {
    const elapsed = (performance.now() - began) / 1000;
    const rate = elapsed > 0 ? (state.nextIndex - initial) / elapsed : 0;
    state.updatedAt = new Date().toISOString();
    atomicJson(opt.checkpoint, state);
    atomicJson(opt.matches, state.matches);
    const status = { phase, engine: 'gpu', pid: process.pid, ...identity, checked: state.nextIndex - opt.start, total: opt.end - opt.start + 1, nextIndex: state.nextIndex, matches: state.matches.length, addressesPerSecond: rate, estimatedSecondsRemaining: rate > 0 ? (opt.end + 1 - state.nextIndex) / rate : null, updatedAt: state.updatedAt };
    atomicJson(opt.status, status);
    return status;
  };
  if (state.nextIndex === opt.end + 1) { save('complete'); return state; }
  save('scanning');
  const args = ['scan', inputs.branchFile, inputs.generatorFile, opt.data, String(state.nextIndex), String(opt.end), String(opt.batch)];
  log('gpu-scan-started', { ...identity, nextIndex: state.nextIndex, targetRecords: dataset.count, batch: opt.batch });
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '', interrupted = false;
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-100000); });
  const exited = new Promise((resolve) => { child.on('error', (error) => resolve({ error })); child.on('exit', (code, signal) => resolve({ code, signal })); });
  const stop = () => { interrupted = true; child.kill(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let pending = [], invalid = [], lastSave = Date.now(), gpuComplete = false;
  const addMatch = (index, hash, reportedBalance) => {
    const cpuHash = targetHash(hash160(inputs.branch.derive(index).publicKey), opt.addressType);
    if (!hash.equals(cpuHash)) throw new Error('GPU hit disagrees with original derivation at ' + index);
    const slot = lookup.find(cpuHash);
    if (slot < 0) throw new Error('GPU hit is absent from the exact target table.');
    const balance = lookup.bytes.readBigUInt64LE(slot * 32 + 24).toString();
    if (reportedBalance !== undefined && balance !== reportedBalance) throw new Error('GPU balance differs from input.');
    if (!seen.has(index)) {
      const match = matchRecord(index, inputs.branch.derive(index).index, cpuHash, BigInt(balance), opt);
      seen.add(index); state.matches.push(match); log('match', match);
    }
  };
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.event === 'gpu-hit') pending.push(message);
      else if (message.event === 'gpu-invalid') invalid.push(message.index);
      else if (message.event === 'gpu-device') log('gpu-device', message);
      else if (message.event === 'gpu-batch') {
        const expectedNext = Math.min(state.nextIndex + opt.batch, opt.end + 1);
        if (message.nextIndex !== expectedNext || !Array.isArray(message.samples) || message.samples.length !== 16) throw new Error('GPU batch skipped indices or lacks validation samples.');
        const inBatch = (index) => Number.isInteger(index) && index >= state.nextIndex && index < expectedNext;
        for (const sample of message.samples) {
          if (!inBatch(sample.index)) throw new Error('Validation sample is outside current batch.');
          if (sample.status === 0) {
            const expected = hash160(inputs.branch.derive(sample.index).publicKey).toString('hex');
            if (sample.hash !== expected) throw new Error('GPU/CPU sample mismatch at index ' + sample.index);
          } else if (!invalid.includes(sample.index)) throw new Error('GPU invalid sample was not reported.');
        }
        if (message.samples[0].index !== state.nextIndex || message.samples[1].index !== expectedNext - 1) throw new Error('GPU validation samples omit batch boundaries.');
        for (const hit of pending) {
          if (!inBatch(hit.index) || !/^[0-9a-f]{40}$/.test(hit.hash)) throw new Error('Malformed GPU hit.');
          addMatch(hit.index, Buffer.from(hit.hash, 'hex'), hit.balanceBaseUnits);
        }
        // The original library retries invalid BIP32 children at the next index.
        for (const index of invalid) {
          if (!inBatch(index)) throw new Error('Invalid-child record is outside current batch.');
          const expected = targetHash(hash160(inputs.branch.derive(index).publicKey), opt.addressType);
          if (lookup.find(expected) >= 0) addMatch(index, expected);
        }
        const hadHits = pending.length || invalid.length;
        state.nextIndex = expectedNext;
        pending = []; invalid = [];
        if (hadHits || Date.now() - lastSave >= 10000) { log('progress', save('scanning')); lastSave = Date.now(); }
      } else if (message.event === 'gpu-complete') gpuComplete = true;
      else throw new Error('Unknown GPU event: ' + message.event);
    }
    const result = await exited;
    if (interrupted) { save('stopped'); return state; }
    if (result.error || result.code !== 0 || !gpuComplete || state.nextIndex !== opt.end + 1 || pending.length || invalid.length) throw new Error('GPU scan failed: ' + (result.error?.message || stderr || JSON.stringify(result)));
    log('scan-complete', save('complete'));
    return state;
  } catch (error) {
    child.kill(); await exited;
    save('error');
    throw error;
  } finally { lines.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
