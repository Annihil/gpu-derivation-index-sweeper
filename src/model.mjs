import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import * as ecc from 'tiny-secp256k1';
import { BIP32Factory } from 'bip32';

export const MAX_INDEX = 0x7fffffff;
export const UNKNOWN_BALANCE = 0xffffffffffffffffn;
export const NETWORKS = {
  litecoin: { ...bitcoin.networks.bitcoin, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0, bech32: 'ltc' },
  bitcoin: bitcoin.networks.bitcoin,
  'bitcoin-testnet': bitcoin.networks.testnet,
  'litecoin-testnet': { ...bitcoin.networks.testnet, pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef, bech32: 'tltc' },
};
export const ADDRESS_TYPES = ['p2pkh', 'p2wpkh', 'p2sh-p2wpkh'];
const bip32 = BIP32Factory(ecc);
const PUBLIC_VERSIONS = new Set([0x0488b21e, 0x043587cf, 0x049d7cb2, 0x04b24746, 0x044a5262, 0x045f1cf6, 0x019da462, 0x01b26ef6]);

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export const sha256 = (data) => createHash('sha256').update(data).digest();
export const hash160 = (data) => createHash('ripemd160').update(sha256(data)).digest();
export const log = (event, details = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));

export function profile(options) {
  if (!Object.hasOwn(NETWORKS, options.network)) throw new Error('Choose --network litecoin, bitcoin, litecoin-testnet, or bitcoin-testnet.');
  const addressType = options.addressType ?? 'p2pkh';
  if (!ADDRESS_TYPES.includes(addressType)) throw new Error('Unsupported address type. Choose p2pkh, p2wpkh, or p2sh-p2wpkh.');
  return { network: options.network, addressType };
}

export function normalizeBranch(value = '') {
  if (typeof value !== 'string') throw new Error('Branch must be a relative path string.');
  if (value === '*') value = '';
  else if (value.endsWith('/*')) value = value.slice(0, -2);
  if (!value) return '';
  const parts = value.split('/');
  if (parts.some((part) => !/^(0|[1-9]\d*)$/.test(part) || Number(part) > MAX_INDEX)) throw new Error('Branch must be relative and non-hardened, e.g. 0/7 or 1/*.');
  return parts.map(Number).join('/');
}

export function publicBranch(options) {
  const branchPath = normalizeBranch(options.branch);
  if (Boolean(options.xpub) === Boolean(options.xpubFile)) throw new Error('Provide exactly one of --xpub-file or --xpub (or its config equivalent).');
  const text = options.xpubFile ? fs.readFileSync(options.xpubFile, 'utf8').trim() : String(options.xpub).trim();
  let account;
  try {
    const payload = Buffer.from(bs58check.decode(text));
    if (payload.length !== 78 || !PUBLIC_VERSIONS.has(payload.readUInt32BE(0)) || ![2, 3].includes(payload[45])) throw new Error();
    const normalized = Buffer.from(payload);
    normalized.writeUInt32BE(0x0488b21e, 0);
    account = bip32.fromBase58(bs58check.encode(normalized));
    if (!account.isNeutered()) throw new Error();
  } catch { throw new Error('Invalid or unsupported extended public key. Private keys are not accepted.'); }
  let branch = account;
  if (branchPath) for (const index of branchPath.split('/')) branch = branch.derive(Number(index));
  return { account, branch, branchPath, id: sha256(Buffer.concat([Buffer.from(branch.publicKey), Buffer.from(branch.chainCode), Buffer.from('/' + branchPath)])).toString('hex') };
}

export function makeDeriver(pubkey, chainCode) {
  const parent = Buffer.from(pubkey), chain = Buffer.from(chainCode), message = Buffer.alloc(37);
  parent.copy(message);
  const derive = (index) => {
    if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new Error('Invalid non-hardened index.');
    for (let actual = index; actual <= MAX_INDEX; actual++) {
      message.writeUInt32BE(actual, 33);
      const tweak = createHmac('sha512', chain).update(message).digest().subarray(0, 32);
      if (!ecc.isPrivate(tweak)) continue;
      const child = ecc.pointAddScalar(parent, tweak, true);
      if (!child) continue;
      derive.lastIndex = actual;
      return hash160(child);
    }
    throw new Error('Invalid child at the non-hardened/hardened boundary.');
  };
  return derive;
}

export function targetHash(pubkeyHash, addressType) {
  return addressType === 'p2sh-p2wpkh' ? hash160(Buffer.concat([Buffer.from([0, 20]), pubkeyHash])) : pubkeyHash;
}
export function encodeAddress(hash, options) {
  const p = profile(options), network = NETWORKS[p.network];
  return p.addressType === 'p2wpkh' ? bitcoin.address.toBech32(hash, 0, network.bech32) : bitcoin.address.toBase58Check(hash, p.addressType === 'p2pkh' ? network.pubKeyHash : network.scriptHash);
}
export function decodeAddress(address, options) {
  const p = profile(options), network = NETWORKS[p.network];
  try {
    if (p.addressType === 'p2wpkh') {
      const decoded = bitcoin.address.fromBech32(address);
      if (decoded.prefix === network.bech32 && decoded.version === 0 && decoded.data.length === 20) return Buffer.from(decoded.data);
    } else {
      const decoded = bitcoin.address.fromBase58Check(address);
      if (decoded.version === (p.addressType === 'p2pkh' ? network.pubKeyHash : network.scriptHash) && decoded.hash.length === 20) return Buffer.from(decoded.hash);
    }
  } catch {}
  return null;
}
export function matchRecord(index, actualIndex, hash, balance, options) {
  const branch = normalizeBranch(options.branch);
  return { index, actualChildIndex: actualIndex, relativePath: (branch ? branch + '/' : '') + index,
    address: encodeAddress(hash, options), network: options.network, addressType: options.addressType,
    balanceBaseUnits: balance === UNKNOWN_BALANCE ? null : balance.toString(), cpuVerified: true };
}
