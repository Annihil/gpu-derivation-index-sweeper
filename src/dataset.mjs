import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { atomicJson, profile, decodeAddress, UNKNOWN_BALANCE, sha256, log } from './model.mjs';

export const HEADER = 128, RECORD = 28;
const MAGIC = Buffer.from('IDXSET02');

export async function prepare(options) {
  const p = profile(options), { input, output } = options;
  const format = options.format ?? 'tsv';
  if (!input || !output || !['tsv', 'addresses'].includes(format)) throw new Error('prepare requires --input, --output, and --format tsv|addresses.');
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new output filename.');
  const before = fs.statSync(input), peek = fs.openSync(input, 'r'), signature = Buffer.alloc(2);
  fs.readSync(peek, signature, 0, 2, 0); fs.closeSync(peek);
  const gzip = signature[0] === 31 && signature[1] === 139;
  const temporary = output + '.' + process.pid + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  let closed = false, first = true, rows = 0, count = 0, skipped = 0, tail = '', used = 0, contentError;
  const digest = createHash('sha256'), buffer = Buffer.alloc(RECORD * 32768);
  const flush = () => { if (used) fs.writeSync(fd, buffer, 0, used); used = 0; };
  const consume = (raw) => {
    const line = raw.replace(/\r$/, '');
    if (first) {
      first = false;
      if (format === 'tsv') {
        if (line.replace(/^\uFEFF/, '') !== 'address\tbalance') throw new Error('Expected address<TAB>balance header, with integer smallest-unit balances.');
        return;
      }
    }
    if (!line.trim() || (format === 'addresses' && line.startsWith('#'))) return;
    rows++;
    let address = line.trim(), balance = UNKNOWN_BALANCE;
    if (format === 'tsv') {
      const parts = line.split('\t');
      if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw new Error('Malformed TSV row ' + rows);
      address = parts[0]; balance = BigInt(parts[1]);
      if (balance >= UNKNOWN_BALANCE) throw new Error('Balance out of range at row ' + rows);
      if (!balance) { skipped++; return; }
    }
    const hash = decodeAddress(address, p);
    if (!hash) { skipped++; return; }
    hash.copy(buffer, used); buffer.writeBigUInt64LE(balance, used + 20);
    used += RECORD; count++;
    if (used === buffer.length) flush();
  };
  // Node versions can surface an iterator-teardown AbortError before the sink's
  // parsing exception. Retain the original diagnostic for the caller.
  const consumeLine = (line) => {
    try { consume(line); }
    catch (error) { contentError = error; throw error; }
  };
  try {
    fs.writeSync(fd, Buffer.alloc(HEADER));
    const raw = fs.createReadStream(input); raw.on('data', (chunk) => digest.update(chunk));
    await pipeline(raw, gzip ? createGunzip({ chunkSize: 1024 * 1024 }) : new PassThrough(), async (chunks) => {
      for await (const chunk of chunks) {
        const text = tail + chunk.toString('utf8');
        let start = 0, end;
        while ((end = text.indexOf('\n', start)) !== -1) { consumeLine(text.slice(start, end)); start = end + 1; }
        tail = text.slice(start);
        if (tail.length > 1024 * 1024) throw new Error('Unexpectedly long input line.');
      }
    });
    if (tail) consumeLine(tail);
    if (!count) throw new Error('No matching addresses: check network, address type, input format, and positive balances.');
    const after = fs.statSync(input);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Input changed during preparation.');
    flush();
    const header = Buffer.alloc(HEADER); MAGIC.copy(header); header.writeUInt32LE(2, 8); header.writeUInt32LE(RECORD, 12);
    header.writeBigUInt64LE(BigInt(count), 16); header.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 24);
    const sourceSha256 = digest.digest(); sourceSha256.copy(header, 32);
    header.write(p.network, 64, 16, 'ascii'); header.write(p.addressType, 80, 16, 'ascii');
    fs.writeSync(fd, header, 0, HEADER, 0); fs.fsyncSync(fd); fs.closeSync(fd); closed = true;
    fs.renameSync(temporary, output);
    const metadata = { ...p, inputBytes: before.size, sourceSha256: sourceSha256.toString('hex'), rows, targetRecords: count, skippedRows: skipped, format, gzipValidated: gzip, preparedAt: new Date().toISOString() };
    atomicJson(output + '.json', metadata); log('prepared', metadata); return metadata;
  } catch (error) { if (!closed) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); throw contentError ?? error; }
}

export function readDataset(filename, expected) {
  const raw = fs.readFileSync(filename);
  if (raw.length < HEADER || !raw.subarray(0, 8).equals(MAGIC) || raw.readUInt32LE(8) !== 2 || raw.readUInt32LE(12) !== RECORD) throw new Error('Invalid dataset header.');
  const count = Number(raw.readBigUInt64LE(16));
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000000 || raw.length !== HEADER + count * RECORD) throw new Error('Invalid dataset count/length.');
  const p = profile({ network: raw.toString('ascii', 64, 80).replace(/\0.*$/, ''), addressType: raw.toString('ascii', 80, 96).replace(/\0.*$/, '') });
  if (expected && (p.network !== expected.network || p.addressType !== expected.addressType)) throw new Error('Dataset network/address type does not match scan configuration.');
  return { ...p, raw, count, id: sha256(raw).toString('hex') };
}

function bucket(a, b, c, d, e, mask) {
  let h = 2166136261;
  for (const word of [a,b,c,d,e]) h = Math.imul(h ^ word, 16777619);
  return (h ^ (h >>> 16)) & mask;
}
export function makeLookup(shared, capacity) {
  const words = new Uint32Array(shared), bytes = Buffer.from(shared), mask = capacity - 1;
  const find = (hash) => {
    const a = hash.readUInt32LE(0), b = hash.readUInt32LE(4), c = hash.readUInt32LE(8), d = hash.readUInt32LE(12), e = hash.readUInt32LE(16);
    let slot = bucket(a,b,c,d,e,mask);
    for (let attempts=0; attempts<capacity; attempts++, slot=(slot+1)&mask) {
      const i=slot*8;
      if (!words[i+5]) return -1;
      if (words[i]===a && words[i+1]===b && words[i+2]===c && words[i+3]===d && words[i+4]===e) return slot;
    }
    throw new Error('Target table unexpectedly full.');
  };
  return { words, bytes, find };
}
export function buildTable(dataset) {
  let capacity=16;
  while (capacity<dataset.count/0.65) capacity*=2;
  const shared=new SharedArrayBuffer(capacity*32), table=makeLookup(shared,capacity), mask=capacity-1;
  let duplicates=0;
  for (let n=0;n<dataset.count;n++) {
    const off=HEADER+n*RECORD, hash=dataset.raw.subarray(off,off+20);
    let slot=bucket(hash.readUInt32LE(0),hash.readUInt32LE(4),hash.readUInt32LE(8),hash.readUInt32LE(12),hash.readUInt32LE(16),mask);
    let duplicate=false;
    while(table.words[slot*8+5]) {
      if(table.bytes.subarray(slot*32,slot*32+20).equals(hash)) {
        if(table.bytes.readBigUInt64LE(slot*32+24)!==dataset.raw.readBigUInt64LE(off+20)) throw new Error('Duplicate address has conflicting balances.');
        duplicate=true; duplicates++; break;
      }
      slot=(slot+1)&mask;
    }
    if(duplicate)continue;
    hash.copy(table.bytes,slot*32);table.words[slot*8+5]=1;dataset.raw.copy(table.bytes,slot*32+24,off+20,off+RECORD);
  }
  return { shared, capacity, duplicates };
}
