// Checks the staged publication tree without printing file contents or credentials.
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const approved=JSON.parse(readFileSync('.public-assets.json','utf8'));
const problems=[];
for(const path of files){
 if (/(^|\/)(?:data|output|node_modules|dist|dist-connected|\.superpowers|\.vercel)(\/|$)/.test(path)||/(^|\/)\.env(?!\.example$)/.test(path)||/\.(?:key|pem|p12|enc|mp3|wav|mp4|psd|vrm|moc3|glb|zip|sqlite|db)$/.test(path)) problems.push(path+': excluded material or private data');
 if(lstatSync(path).isSymbolicLink())problems.push(path+': symbolic link');
 if(path.startsWith('apps/web/public/')&&/\.(?:png|jpg|jpeg|webp|ico|svg)$/.test(path)){
  const hash=createHash('sha256').update(readFileSync(path)).digest('hex');
  if(approved[path]!==hash)problems.push(path+': asset needs a publication review');
 }
}
if(problems.length){console.error(problems.join('\n'));process.exit(1);}
console.log(`Public-source boundary verified: ${files.length} files. Run a secret scanner separately before publishing.`);
