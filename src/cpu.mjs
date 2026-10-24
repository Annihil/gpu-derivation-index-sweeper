import * as fs from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { atomicJson, log, profile, publicBranch, makeDeriver, targetHash, matchRecord, normalizeBranch, MAX_INDEX } from './model.mjs';
import { readDataset, buildTable, makeLookup } from './dataset.mjs';

function workerLoop() {
  const derive = makeDeriver(workerData.pubkey, workerData.chainCode);
  const table = makeLookup(workerData.shared, workerData.capacity);
  parentPort.on('message', (task) => {
    if (task === null) { parentPort.close(); return; }
    try {
      const matches = [];
      for (let index = task.start; index < task.end; index++) {
        const hash = targetHash(derive(index), workerData.addressType);
        const slot = table.find(hash);
        if (slot >= 0) matches.push(matchRecord(index, derive.lastIndex, hash, table.bytes.readBigUInt64LE(slot * 32 + 24), workerData));
      }
      parentPort.postMessage({ end: task.end, matches });
    } catch (error) { throw error; }
  });
}

export async function scanCpu(options = {}) {
  const opt = { start: 0, end: MAX_INDEX, workers: Math.min(16, availableParallelism()), batch: 10000, ...options, ...profile(options) };
  if (!Number.isInteger(opt.start) || !Number.isInteger(opt.end) || opt.start < 0 || opt.start > opt.end || opt.end > MAX_INDEX) throw new Error('Invalid scan index range.');
  if (!Number.isInteger(opt.workers) || opt.workers < 1 || opt.workers > 64 || !Number.isInteger(opt.batch) || opt.batch < 1) throw new Error('Invalid workers/batch setting.');
  const { branch, id: branchId } = publicBranch(opt);
  const dataset = readDataset(opt.data, opt);
  const { shared, capacity } = buildTable(dataset);
  const identity = { branchId, datasetId: dataset.id, start: opt.start, end: opt.end, workers: opt.workers, network: opt.network, addressType: opt.addressType, branch: normalizeBranch(opt.branch) };
  let state;
  if (fs.existsSync(opt.checkpoint)) {
    state = JSON.parse(fs.readFileSync(opt.checkpoint, 'utf8'));
    if (JSON.stringify(state.identity) !== JSON.stringify(identity)) throw new Error('Existing checkpoint belongs to different input/range/workers.');
    if (!Array.isArray(state.ranges) || state.ranges.length !== opt.workers || !Array.isArray(state.matches)) throw new Error('Malformed checkpoint.');
  } else {
    const total = opt.end - opt.start + 1;
    state = { version: 1, identity, ranges: [], matches: [], startedAt: new Date().toISOString() };
    for (let i = 0; i < opt.workers; i++) {
      const start = opt.start + Math.floor(total * i / opt.workers);
      const end = opt.start + Math.floor(total * (i + 1) / opt.workers);
      state.ranges.push({ start, end, next: start });
    }
  }
  // Validate ranges so a damaged checkpoint cannot silently skip candidates.
  let expectedStart = opt.start;
  for (const range of state.ranges) {
    if (range.start !== expectedStart || !Number.isInteger(range.end) || !Number.isInteger(range.next) || range.next < range.start || range.next > range.end || range.end < range.start) throw new Error('Invalid checkpoint ranges.');
    expectedStart = range.end;
  }
  if (expectedStart !== opt.end + 1) throw new Error('Incomplete checkpoint range coverage.');
  const initialChecked = state.ranges.reduce((n, r) => n + r.next - r.start, 0);
  const startTime = performance.now();
  let stopping = false, failure;
  const seen = new Set(state.matches.map((m) => m.index));
  const save = (phase = 'scanning') => {
    state.updatedAt = new Date().toISOString();
    atomicJson(opt.checkpoint, state);
    atomicJson(opt.matches, state.matches);
    const checked = state.ranges.reduce((n, r) => n + r.next - r.start, 0);
    const seconds = (performance.now() - startTime) / 1000;
    const rate = seconds > 0 ? (checked - initialChecked) / seconds : 0;
    const status = { phase, engine: 'cpu', pid: process.pid, ...identity, checked, total: opt.end - opt.start + 1, matches: state.matches.length, addressesPerSecond: rate, estimatedSecondsRemaining: rate > 0 ? (opt.end - opt.start + 1 - checked) / rate : null, updatedAt: state.updatedAt };
    atomicJson(opt.status, status);
    return status;
  };
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  save();
  log('scan-started', { ...identity, targetRecords: dataset.count, resumedChecked: initialChecked, tableMiB: shared.byteLength / 2 ** 20 });
  const progress = setInterval(() => { try { log('progress', save()); } catch (error) { failure = error; stopping = true; } }, 10000);
  const threads = [];
  try {
    await Promise.all(state.ranges.map((range) => new Promise((resolve, reject) => {
      const thread = new Worker(new URL(import.meta.url), { execArgv: [], workerData: { role: 'scan', pubkey: branch.publicKey, chainCode: branch.chainCode, shared, capacity, network: opt.network, addressType: opt.addressType, branch: opt.branch } });
      threads.push(thread);
      let outstanding;
      const next = () => {
        if (stopping || range.next >= range.end) { thread.postMessage(null); return; }
        outstanding = { start: range.next, end: Math.min(range.next + opt.batch, range.end) };
        thread.postMessage(outstanding);
      };
      thread.on('message', (result) => {
        try {
          if (result.end !== outstanding.end) throw new Error('Worker returned unexpected range.');
          range.next = result.end;
          for (const match of result.matches) {
            if (!seen.has(match.index)) { seen.add(match.index); state.matches.push(match); log('match', match); }
          }
          if (result.matches.length) save();
          next();
        } catch (error) { reject(error); }
      });
      thread.on('error', reject);
      thread.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Worker exited with code ' + code)));
      next();
    })));
    if (failure) throw failure;
    const complete = state.ranges.every((r) => r.next === r.end);
    log(complete ? 'scan-complete' : 'scan-stopped', save(complete ? 'complete' : 'stopped'));
    return { complete, matches: state.matches };
  } catch (error) {
    save('error');
    throw error;
  } finally {
    clearInterval(progress);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    for (const thread of threads) await thread.terminate();
  }
}


if (!isMainThread && workerData?.role === 'scan') workerLoop();
