import * as fs from 'node:fs';
import * as path from 'node:path';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { hash160, targetHash, encodeAddress, atomicJson } from '../src/model.mjs';
const dir=path.resolve('runs/demo');
fs.mkdirSync(dir,{recursive:true});
// Public, deterministic fixture. Never use this seed or key for real funds.
const account=BIP32Factory(ecc).fromSeed(Buffer.alloc(32,42)).neutered();
fs.writeFileSync(path.join(dir,'wallet.xpub'),account.toBase58()+'\n');
const config={xpubFile:'wallet.xpub',branch:'1/*',network:'litecoin',addressType:'p2pkh'};
atomicJson(path.join(dir,'wallet.local.json'),config);
const branch=account.derive(1);
const rows=[7,42,99].map(index=>`${encodeAddress(targetHash(hash160(branch.derive(index).publicKey),config.addressType),config)}\t123456789`);
fs.writeFileSync(path.join(dir,'addresses.tsv'),'address\tbalance\n'+rows.join('\n')+'\n');
console.log('Synthetic demo created in runs/demo. Expected matching indices: 7, 42, 99.');
