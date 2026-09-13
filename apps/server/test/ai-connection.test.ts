import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,readdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {AIKeyStore,createDynamicAI,registerAIConnection} from '../src/ai-connection';
const dirs:string[]=[];function store(fallback?:string){const dir=mkdtempSync(join(tmpdir(),'zundamon-ai-'));dirs.push(dir);return {dir,vault:new AIKeyStore(dir,fallback)};}
afterEach(()=>{dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
describe('AI connection',()=>{
 it('encrypts and binds stored keys, persists replacement and suppresses fallback after removal',()=>{
  const {dir,vault}=store('existing-server-key');expect(vault.key('a')).toBe('existing-server-key');vault.save('a','private-test-key','date');
  expect(readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>readFileSync(join(dir,f),'utf8')).join('')).not.toContain('private-test-key');
  expect(new AIKeyStore(dir).key('a')).toBe('private-test-key');expect(vault.key('b')).toBe('existing-server-key');
  const path=(u:string)=>join(dir,createHash('sha256').update(u).digest('hex')+'.json');copyFileSync(path('a'),path('b'));expect(()=>vault.key('b')).toThrow();
  vault.save('a',null,null);expect(new AIKeyStore(dir,'existing-server-key').key('a')).toBeUndefined();
 });
 it('resolves the correct owner for overlapping requests and picks up new settings',async()=>{
  const {vault}=store();vault.save('a','key-a',null);vault.save('b','key-b',null);const ai=createDynamicAI(vault);
  const gateway=ai.gateway(key=>({async call(){await new Promise(r=>setTimeout(r,5));return key;}}));
  expect(await Promise.all(['a','b'].map(id=>ai.context.run(id,()=>gateway.call())))).toEqual(['key-a','key-b']);
  vault.save('a','replacement',null);expect(await ai.context.run('a',()=>gateway.call())).toBe('replacement');expect(()=>gateway.call()).toThrow('ai_owner_required');
 });
 it('never saves invalid credentials or returns them, protects mutation origin, preserves existing connection on failure',async()=>{
  const {vault}=store('existing');const app=Fastify();app.decorateRequest('yuiUser');app.addHook('onRequest',async(req,reply)=>{if(req.headers.authorization!=='Bearer test')return reply.code(401).send({});req.yuiUser={userId:'owner',email:'owner@example.com',accessToken:'test'};});
  registerAIConnection(app,{store:vault,allowedOrigin:'https://app.example',test:async key=>{if(key.includes('bad'))throw {status:401,message:key};}});
  const headers={authorization:'Bearer test',origin:'https://app.example'};
  try{
   expect((await app.inject('/api/ai-connection')).statusCode).toBe(401);
   expect((await app.inject({method:'DELETE',url:'/api/ai-connection',headers:{authorization:'Bearer test'}})).statusCode).toBe(403);
   const bad=await app.inject({method:'PUT',url:'/api/ai-connection',headers,payload:{key:'sk-bad01234567890123456789'}});expect(bad.statusCode).toBe(422);expect(bad.body).not.toContain('sk-');expect(vault.key('owner')).toBe('existing'); // gitleaks:allow -- synthetic unit-test fixture, never a real credential
   const good='sk-good01234567890123456789';const saved=await app.inject({method:'PUT',url:'/api/ai-connection',headers,payload:{key:good}});expect(saved.statusCode).toBe(200);expect(saved.json().configured).toBe(true);expect(saved.body).not.toContain(good);expect(vault.key('owner')).toBe(good);
   expect((await app.inject({method:'DELETE',url:'/api/ai-connection',headers})).json().configured).toBe(false);expect(vault.key('owner')).toBeUndefined();
  }finally{await app.close();}
 });
});
