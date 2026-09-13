import {AsyncLocalStorage} from 'node:async_hooks';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import OpenAI from 'openai';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';

const keySchema=z.string().trim().min(20).max(512).regex(/^sk-[A-Za-z0-9_-]+$/);
type Saved={key:string|null;checkedAt:string|null};
export type AIStatus={configured:boolean;source:'server'|'personal'|'none';checkedAt:string|null;model:string};
export const AI_MODEL='gpt-5.6-luna';
/** One private server, one allowed login. Ciphertext is additionally bound to auth user ID. */
export class AIKeyStore {
 constructor(private directory:string,private fallback?:string){}
 private file(owner:string){return join(this.directory,createHash('sha256').update(owner).digest('hex')+'.json');}
 private master(create=false){
  if(create){mkdirSync(this.directory,{recursive:true,mode:0o700});if(lstatSync(this.directory).isSymbolicLink())throw Error('unsafe_secret_path');}
  const path=join(this.directory,'master.key');
  if(create&&!existsSync(path)){try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}
  if(lstatSync(path).isSymbolicLink())throw Error('unsafe_secret_path');
  const key=readFileSync(path);if(key.length!==32)throw Error('invalid_secret_key');return key;
 }
 private read(owner:string):Saved|undefined{
  const path=this.file(owner);if(!existsSync(path))return undefined;
  if(lstatSync(path).isSymbolicLink())throw Error('unsafe_secret_path');
  const data=JSON.parse(readFileSync(path,'utf8')) as {iv:string;tag:string;ciphertext:string};
  const decipher=createDecipheriv('aes-256-gcm',this.master(),Buffer.from(data.iv,'base64'));
  decipher.setAAD(Buffer.from(owner));decipher.setAuthTag(Buffer.from(data.tag,'base64'));
  return z.object({key:z.string().nullable(),checkedAt:z.string().nullable()}).parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext,'base64')),decipher.final()]).toString()));
 }
 key(owner:string){const saved=this.read(owner);return saved===undefined?this.fallback:saved.key??undefined;}
 status(owner:string):AIStatus{const saved=this.read(owner);return {configured:!!(saved===undefined?this.fallback:saved.key),source:saved===undefined?(this.fallback?'server':'none'):saved.key?'personal':'none',checkedAt:saved?.checkedAt??null,model:AI_MODEL};}
 save(owner:string,key:string|null,checkedAt:string|null){
  const master=this.master(true),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from(owner));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify({key,checkedAt})),cipher.final()]);
  const temp=this.file(owner)+'.'+randomBytes(8).toString('hex')+'.tmp';
  writeFileSync(temp,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}),{mode:0o600,flag:'wx'});renameSync(temp,this.file(owner));
 }
}
export function createDynamicAI(store:AIKeyStore){
 const context=new AsyncLocalStorage<string>();
 return {context, gateway<T extends object>(factory:(key:string)=>T):T{
  return new Proxy({} as T,{get(_target,property){return (...args:unknown[])=>{
   const owner=context.getStore();if(!owner)throw Error('ai_owner_required');const key=store.key(owner);if(!key)throw Error('ai_connection_required');
   const gateway=factory(key);const method=Reflect.get(gateway,property);if(typeof method!=='function')throw Error('invalid_ai_gateway_method');return Reflect.apply(method,gateway,args);
  };}});
 }};
}
export async function testOpenAIKey(key:string){
 const client=new OpenAI({apiKey:key,maxRetries:0,timeout:15000,logLevel:'off'});
 await client.responses.create({model:AI_MODEL,store:false,input:'Reply with OK.',max_output_tokens:16});
}
export function registerAIConnection(app:FastifyInstance,options:{store:AIKeyStore;allowedOrigin:string;test?:(key:string)=>Promise<void>}){
 const busy=new Set<string>(),check=options.test??testOpenAIKey;
 app.get('/api/ai-connection',async(request,reply)=>{reply.header('Cache-Control','no-store');try{return options.store.status(request.yuiUser.userId);}catch{return reply.code(503).send({error:'storage_unavailable'});}});
 for(const method of ['POST','PUT','DELETE'] as const)app.route({method,url:'/api/ai-connection',bodyLimit:2048,handler:async(request,reply)=>{
  reply.header('Cache-Control','no-store');
  if(request.headers.origin!==options.allowedOrigin)return reply.code(403).send({error:'origin_not_allowed'});
  const owner=request.yuiUser.userId;if(busy.has(owner))return reply.code(409).send({error:'check_in_progress'});busy.add(owner);
  try{
   if(method==='DELETE'){options.store.save(owner,null,null);return options.store.status(owner);}
   const body=z.object({key:keySchema.optional()}).strict().safeParse(request.body??{});
   if(!body.success||method==='PUT'&&!body.data.key)return reply.code(400).send({error:'invalid_key'});
   const key=body.data.key??options.store.key(owner);if(!key)return reply.code(409).send({error:'key_required'});
   try{await check(key);}catch(e){const status=(e as {status?:number})?.status;return reply.code(422).send({error:status===401||status===403?'key_rejected':status===429?'quota_or_rate_limit':'connection_failed'});}
   if(method==='PUT')options.store.save(owner,key,new Date().toISOString());
   return {...options.store.status(owner),tested:true};
  }catch{return reply.code(503).send({error:'storage_unavailable'});}finally{busy.delete(owner);}
 }});
}
