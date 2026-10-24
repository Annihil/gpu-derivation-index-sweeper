import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import bs58check from 'bs58check';
import { fixture,bip32,fs,path,atomicJson } from './fixtures.mjs';
import { publicBranch,normalizeBranch,makeDeriver,hash160,encodeAddress,decodeAddress,targetHash,UNKNOWN_BALANCE } from '../src/model.mjs';
import { prepare,readDataset,buildTable,makeLookup } from '../src/dataset.mjs';
import { scanCpu } from '../src/cpu.mjs';

test('public-key versions, relative branch semantics, and private-key rejection',()=>{
  const account=bip32.fromSeed(Buffer.alloc(32,11)).neutered();
  for(const version of [0x0488b21e,0x043587cf,0x049d7cb2,0x04b24746,0x019da462,0x01b26ef6]) {
    const payload=Buffer.from(bs58check.decode(account.toBase58()));payload.writeUInt32BE(version);
    const actual=publicBranch({xpub:bs58check.encode(payload),branch:'0/3/*'});
    assert.deepEqual(actual.branch.publicKey,account.derive(0).derive(3).publicKey);
  }
  assert.equal(normalizeBranch('*'),'');assert.equal(normalizeBranch('1/*'),'1');
  for(const branch of ["m/44'/2'/0'", "0/1'",'-1','1//0','2147483648'])assert.throws(()=>normalizeBranch(branch));
  assert.throws(()=>publicBranch({xpub:bip32.fromSeed(Buffer.alloc(32,12)).toBase58()}),/public key/);
});

test('optimized derivation matches bip32 including the largest non-hardened index',()=>{
  const branch=bip32.fromSeed(Buffer.alloc(32,13)).neutered().derive(1);
  const derive=makeDeriver(branch.publicKey,branch.chainCode);
  const indices=[0,1,999,1000,65535,65536,0x7ffffffe,0x7fffffff];
  let state=123456789;
  for(let n=0;n<250;n++){state=(Math.imul(state,1664525)+1013904223)>>>0;indices.push(state&0x7fffffff);}
  for(const i of indices)assert.deepEqual(derive(i),hash160(branch.derive(i).publicKey));
  assert.throws(()=>derive(0x80000000));assert.throws(()=>derive(-1));
});

test('CPU matching across networks, script types, partitions and resume',async()=>{
  for(const network of ['litecoin','bitcoin','litecoin-testnet','bitcoin-testnet'])for(const addressType of ['p2pkh','p2wpkh','p2sh-p2wpkh']) {
    const f=await fixture({network,addressType,branch:'0/3/*'});
    const first=await scanCpu(f.options);
    assert.equal(first.complete,true);
    assert.deepEqual(first.matches.map(m=>m.index).sort((a,b)=>a-b),f.wanted);
    assert.ok(first.matches.every(m=>m.relativePath.startsWith('0/3/')));
    const state=JSON.parse(fs.readFileSync(f.options.checkpoint));
    for(const r of state.ranges)r.next=r.start+3;
    state.matches=state.matches.filter(m=>state.ranges.some(r=>m.index>=r.start&&m.index<r.next));
    atomicJson(f.options.checkpoint,state);
    const resumed=await scanCpu(f.options);
    assert.deepEqual(resumed.matches.map(m=>m.index).sort((a,b)=>a-b),f.wanted);
    await assert.rejects(scanCpu({...f.options,workers:2}),/different input/);
  }
});

test('range endpoints at zero and 2^31-1 are inclusive',async()=>{
  for(const [start,end] of [[0,2],[0x7ffffffd,0x7fffffff]]) {
    const f=await fixture({start,end,wanted:[start,end],branch:'',workers:2,batch:1});
    const result=await scanCpu(f.options);
    assert.deepEqual(result.matches.map(m=>m.index).sort((a,b)=>a-b),[start,end]);
  }
});

test('known-address input, exact membership and dataset identity checks',async()=>{
  const f=await fixture();
  const input=path.join(f.dir,'known.txt'),data=path.join(f.dir,'known.bin');
  const hash=targetHash(hash160(f.branch.derive(42).publicKey),'p2pkh');
  fs.writeFileSync(input,encodeAddress(hash,f.options)+'\n'+encodeAddress(hash,f.options)+'\n');
  await prepare({...f.options,input,output:data,format:'addresses'});
  const dataset=readDataset(data,f.options),built=buildTable(dataset),lookup=makeLookup(built.shared,built.capacity);
  assert.equal(built.duplicates,1);
  const slot=lookup.find(hash);assert.ok(slot>=0);
  assert.equal(lookup.bytes.readBigUInt64LE(slot*32+24),UNKNOWN_BALANCE);
  assert.throws(()=>readDataset(data,{network:'bitcoin',addressType:'p2pkh'}),/does not match/);
  assert.equal(decodeAddress(encodeAddress(hash,f.options),{network:'bitcoin',addressType:'p2pkh'}),null);
});

test('truncated gzip and malformed TSV do not produce datasets',async()=>{
  const f=await fixture();
  const gz=gzipSync('address\tbalance\n'),input=path.join(f.dir,'bad.gz'),output=path.join(f.dir,'bad.bin');
  fs.writeFileSync(input,gz.subarray(0,gz.length-5));await assert.rejects(prepare({...f.options,input,output}));assert.equal(fs.existsSync(output),false);
  fs.writeFileSync(input,gzipSync('address\tbalance\ninvalid\t1.25\n'));await assert.rejects(prepare({...f.options,input,output}),/Malformed/);
});
