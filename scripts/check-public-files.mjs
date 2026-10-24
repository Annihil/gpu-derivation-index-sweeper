import { execFileSync } from 'node:child_process';

// Check the Git index, not ignored working files. Never print the matched key.
const files=execFileSync('git',['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw new Error('No tracked/staged files to check.');
const problems=[];
for(const file of files) {
  if(/^(?:build|node_modules|runs|data|secrets|\.cache|\.tools)\//.test(file)||/\.(?:xpub|bin|gz|log|exe|obj|pdb|lib|exp|tmp)$/.test(file)||/\.local\.json$/.test(file)) {
    problems.push({file,reason:'generated or local-data artifact'});continue;
  }
  const text=execFileSync('git',['show',':'+file],{maxBuffer:20*1024*1024}).toString('utf8');
  if(/\b(?:[xtyzuv]pub|[xtyzuv]prv|Ltub|Mtub|Ltpv|Mtpv)[1-9A-HJ-NP-Za-km-z]{90,120}\b/.test(text))problems.push({file,reason:'literal extended key'});
}
if(problems.length){console.error(JSON.stringify({publicFileCheck:'failed',problems},null,2));process.exitCode=1;}
else console.log(JSON.stringify({publicFileCheck:'passed',files:files.length}));
