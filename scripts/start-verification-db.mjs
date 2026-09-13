import {spawn} from 'node:child_process';
import {statfsSync} from 'node:fs';

// Called only by the disposable local DB verifier; never links to a cloud project.
const workdir=process.argv[2];
if(!workdir||!process.env.DOCKER_HOST?.startsWith('unix://'))throw Error('Local verification directory and Docker socket required');
const child=spawn('pnpm',['exec','supabase','db','start','--workdir',workdir],{stdio:'inherit',detached:true});
let stopped=false;
const stop=reason=>{
 if(stopped)return;stopped=true;console.error(reason);
 try{process.kill(-child.pid,'SIGTERM');}catch{}
};
const monitor=setInterval(()=>{
 const disk=statfsSync(process.cwd());
 if(disk.bavail*disk.bsize<3*1024**3)stop('Stopped DB startup to preserve 3 GiB of free host disk space.');
},5000);
const deadline=setTimeout(()=>stop('DB startup exceeded 10 minutes.'),600000);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop('Verification interrupted.'));
child.once('error',()=>{clearInterval(monitor);clearTimeout(deadline);process.exitCode=1;});
child.once('exit',code=>{clearInterval(monitor);clearTimeout(deadline);process.exitCode=stopped?2:code??1;});
