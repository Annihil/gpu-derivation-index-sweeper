import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,fs,atomicJson } from './fixtures.mjs';
import { scanGpu,DEFAULT_GPU } from '../src/gpu.mjs';

test('CUDA derivation, exact membership, type conversion and resume',async()=>{
  assert.ok(fs.existsSync(DEFAULT_GPU),'Build the CUDA engine before running npm run test:gpu.');
  for(const [network,addressType,branch] of [['litecoin','p2pkh','1/*'],['bitcoin','p2wpkh','0/3/*'],['litecoin','p2sh-p2wpkh','']]) {
    const wanted=[1000,1001,17383,17384,33767,33768,40999];
    const f=await fixture({network,addressType,branch,start:1000,end:40999,wanted,batch:16384});
    let state=await scanGpu(f.options);
    assert.deepEqual(state.matches.map(m=>m.index).sort((a,b)=>a-b),wanted);
    state.nextIndex=17384;state.matches=state.matches.filter(m=>m.index<17384);atomicJson(f.options.checkpoint,state);
    state=await scanGpu(f.options);
    assert.deepEqual(state.matches.map(m=>m.index).sort((a,b)=>a-b),wanted);
  }
  const f=await fixture({start:0x7ffffffe,end:0x7fffffff,wanted:[0x7ffffffe,0x7fffffff],branch:'7/*',batch:16384});
  const result=await scanGpu(f.options);assert.equal(result.matches.length,2);
});
