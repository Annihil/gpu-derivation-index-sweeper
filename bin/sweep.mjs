#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { prepare } from '../src/dataset.mjs';
import { scanCpu } from '../src/cpu.mjs';
import { scanGpu } from '../src/gpu.mjs';
import { atomicJson, log } from '../src/model.mjs';

const names = new Set(['config','network','address-type','xpub','xpub-file','branch','start','end','engine','workers','batch','input','output','format','data','out-dir','gpu-binary']);
const numbers = new Set(['start','end','workers','batch']);
const paths = new Set(['xpubFile','input','output','data','outDir','gpuBinary']);
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const configKeys = new Set([...names].filter((n) => n !== 'config').map(camel));

function optionsOf(args) {
  const cli = {};
  for (let i=0;i<args.length;i+=2) {
    const name=args[i].slice(2);
    if (!args[i].startsWith('--') || !names.has(name) || args[i+1]===undefined) throw new Error('Unknown option or missing value; run help.');
    if (Object.hasOwn(cli,camel(name))) throw new Error('Duplicate option: --'+name);
    if (numbers.has(name) && !/^(?:\d+|0x[0-9a-f]+)$/i.test(args[i+1])) throw new Error('Numeric options require a nonnegative integer.');
    cli[camel(name)] = numbers.has(name) ? Number(args[i+1]) : args[i+1];
  }
  let config = {};
  if (cli.config) {
    try { config=JSON.parse(fs.readFileSync(cli.config,'utf8')); } catch { throw new Error('Cannot read valid JSON configuration.'); }
    if (!config || Array.isArray(config) || typeof config !== 'object' || Object.keys(config).some((key)=>!configKeys.has(key))) throw new Error('Unknown configuration field.');
    for(const key of paths) if(config[key])config[key]=path.resolve(path.dirname(path.resolve(cli.config)),config[key]);
  }
  for(const key of paths) if(cli[key])cli[key]=path.resolve(cli[key]);
  delete cli.config;
  return {...config,...cli};
}

function help() {
  console.log(`GPU derivation index sweeper

Prepare an offline address lookup:
  node bin/sweep.mjs prepare --network litecoin --address-type p2pkh --input data/addresses.tsv.gz --output data/targets.bin

Scan a relative branch beneath your own public extended key:
  node bin/sweep.mjs scan --config wallet.local.json --data data/targets.bin --engine cpu --start 0 --end 999 --out-dir runs/example
  node bin/sweep.mjs scan --config wallet.local.json --data data/targets.bin --engine gpu --out-dir runs/full

Read progress:
  node bin/sweep.mjs status --out-dir runs/full

Configuration: xpub or xpubFile, branch (e.g. 1/*), network, addressType.
Networks: litecoin, bitcoin, litecoin-testnet, bitcoin-testnet.
Address types: p2pkh, p2wpkh, p2sh-p2wpkh.
Both endpoints are inclusive. Default range: 0 through 2147483647.
CPU workers default to at most 16. GPU batch default: 16384.
Prepare accepts --format tsv (address/balance columns) or addresses (one per line).
Balances are integer smallest units, never decimal coin amounts.
An identical scan command resumes its saved checkpoint automatically.
Use a separate output directory for a different job. See README.md for details.`);
}

async function withLock(dir, action) {
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'.scan.lock');
  const acquire=()=>fs.openSync(file,'wx',0o600);
  let fd;
  try { fd=acquire(); }
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    let prior;
    try { prior=JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw new Error('Unreadable run lock; inspect this output directory before reusing it.'); }
    if(!Number.isInteger(prior.pid)||prior.pid<1)throw new Error('Invalid run lock.');
    try { process.kill(prior.pid,0); throw new Error('Another scan is already using this output directory.'); }
    catch(error) { if(error.code!=='ESRCH')throw error; }
    fs.unlinkSync(file);fd=acquire();
  }
  try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);return await action(); }
  finally { fs.unlinkSync(file); }
}

let statusFile;
async function main() {
  const [command,...args]=process.argv.slice(2);
  if(!command||['help','--help','-h'].includes(command)){help();return;}
  const opt=optionsOf(args);
  if(command==='prepare') {
    if(!opt.output)throw new Error('prepare requires --output.');
    fs.mkdirSync(path.dirname(path.resolve(opt.output)),{recursive:true});
    await prepare(opt);return;
  }
  const dir=path.resolve(opt.outDir??'runs/default');
  if(command==='status'){console.log(fs.readFileSync(path.join(dir,'status.json'),'utf8'));return;}
  if(command!=='scan')throw new Error('Unknown command; run help.');
  if(!opt.data)throw new Error('scan requires --data.');
  const engine=opt.engine??'cpu';
  if(!['cpu','gpu'].includes(engine))throw new Error('Choose --engine cpu or gpu.');
  const paths={checkpoint:path.join(dir,engine+'-state.json'),matches:path.join(dir,'matches.json'),status:path.join(dir,'status.json')};
  await withLock(dir,async()=>{
    if(fs.existsSync(path.join(dir,(engine==='cpu'?'gpu':'cpu')+'-state.json')))throw new Error('Use a separate output directory when changing scan engines.');
    statusFile=paths.status;
    if(engine==='cpu')await scanCpu({...opt,...paths});
    else await scanGpu({...opt,...paths});
  });
  const status=JSON.parse(fs.readFileSync(paths.status,'utf8'));
  if(status.phase==='stopped')process.exitCode=130;
}

main().catch((error)=>{
  log('error',{message:error.message});
  if(statusFile)try{atomicJson(statusFile,{phase:'error',message:error.message,updatedAt:new Date().toISOString()});}catch{}
  process.exitCode=1;
});
