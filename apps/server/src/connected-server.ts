import { createServer } from 'node:http';
import { proxyApi } from './proxy-api.js';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { buildSyncApp, loadSyncConfig } from './sync-app.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
loadEnvFile(resolve(root,'.env.connection.local'));
// Separate loopback ports allow an isolated startup check while the personal app stays running.
const port = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!/^\d{4,5}$/.test(value) || Number(value) > 65535 || Number(value) < 1024) throw Error('Invalid local port');
  return Number(value);
};
const apiPort = port(process.env.ZUNDAMON_API_PORT, 4384);
const httpPort = port(process.env.ZUNDAMON_HTTP_PORT, 4393);
const app = buildSyncApp(loadSyncConfig());
await app.listen({host:'127.0.0.1',port:apiPort});
const publicRoot = await realpath(resolve(root,'apps/web/dist-connected'));
const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.wasm':'application/wasm','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url??'/','http://localhost');
  if(url.pathname.startsWith('/api/')) {
    proxyApi(req,res,apiPort);return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  try {
    const pathname=decodeURIComponent(url.pathname);
    const file=await realpath(resolve(publicRoot,'.'+(pathname==='/'?'/index.html':pathname)));
    if(!file.startsWith(publicRoot+sep)){res.writeHead(404);res.end();return;}
    const info=await stat(file);
    if(!info.isFile()){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }catch {res.writeHead(404);res.end();}
});
server.listen(httpPort,'127.0.0.1');
for(const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,()=>{server.close();void app.close().then(()=>process.exit(0));});
