import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startSetup} from './initial-setup.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
if(!existsSync(new URL('../.env.connection.local',import.meta.url))){
 const {server,url}=await startSetup();
 console.log(`最初の設定を行ってください: ${url}\n保存後、Ctrl+Cで終了して、もう一度起動してください。`);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
}else{
 const child=spawn('pnpm',['--filter','@yui/server','exec','vite-node','src/connected-server.ts'],{cwd:root,stdio:'inherit'});
 child.on('error',()=>{console.error('アプリを起動できませんでした。pnpmのインストールを確認してください。');process.exitCode=1;});
 child.on('exit',code=>{process.exitCode=code??1;});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
}
