import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture,fs,path,atomicJson } from './fixtures.mjs';
const cli=fileURLToPath(new URL('../bin/sweep.mjs',import.meta.url));
const run=(args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true});

test('CLI config paths are relative to the config, results resume, and invalid options fail',async()=>{
  const f=await fixture();
  const configDir=path.join(f.dir,'config folder');fs.mkdirSync(configDir);
  const config=path.join(configDir,'wallet.local.json');
  atomicJson(config,{xpubFile:'../wallet.xpub',branch:'1/*',network:'litecoin',addressType:'p2pkh'});
  const out=path.join(f.dir,'run folder');
  const args=['scan','--config',config,'--data',f.options.data,'--start','1000','--end','1099','--workers','2','--out-dir',out];
  for(let i=0;i<2;i++){const result=run(args);assert.equal(result.status,0,result.stdout+result.stderr);}
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'status.json'))).checked,100);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'matches.json'))).length,5);
  assert.equal(run(['status','--out-dir',out]).status,0);
  assert.notEqual(run([...args,'--end','10']).status,0);
  assert.notEqual(run(['scan','--unknown','value']).status,0);
  assert.notEqual(run([...args,'--engine','gpu']).status,0);
  assert.notEqual(run(['scan','--xpub','invalid','--network','litecoin','--data',f.options.data,'--out-dir',path.join(f.dir,'bad')]).status,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'status.json'))).phase,'complete');
});
