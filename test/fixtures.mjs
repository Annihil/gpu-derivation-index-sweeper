import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { gzipSync } from 'node:zlib';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { hash160, targetHash, encodeAddress, atomicJson } from '../src/model.mjs';
import { prepare } from '../src/dataset.mjs';

export const bip32=BIP32Factory(ecc);
export async function fixture(overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'index-sweep-test-'));
  const options={network:'litecoin',addressType:'p2pkh',branch:'1/*',start:1000,end:1099,workers:3,batch:7,...overrides};
  const account=bip32.fromSeed(Buffer.alloc(32,42)).neutered();
  let branch=account;
  const normalized=options.branch.replace(/\/\*$/,'');
  if(normalized)for(const part of normalized.split('/'))branch=branch.derive(Number(part));
  const wanted=overrides.wanted??[1000,1017,1033,1066,1099];
  const rows=wanted.map((index,n)=>encodeAddress(targetHash(hash160(branch.derive(index).publicKey),options.addressType),options)+'\t'+String((n+1)*123456789));
  options.xpubFile=path.join(dir,'wallet.xpub');fs.writeFileSync(options.xpubFile,account.toBase58());
  options.input=path.join(dir,'targets.tsv.gz');fs.writeFileSync(options.input,gzipSync('address\tbalance\r\n'+rows.join('\r\n')+'\r\n'));
  options.data=path.join(dir,'targets.bin');await prepare({...options,output:options.data});
  options.checkpoint=path.join(dir,'state.json');options.matches=path.join(dir,'matches.json');options.status=path.join(dir,'status.json');
  return {dir,options,account,branch,wanted};
}
export {fs,path,atomicJson};
