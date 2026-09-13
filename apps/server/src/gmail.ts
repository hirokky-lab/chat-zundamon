import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {convert} from 'html-to-text';
import type {FastifyInstance} from 'fastify';
import type {RequestUser} from './request-user.js';
import {verifyGoogleIdToken,readBoundedJson} from './google-oauth-runtime.js';
import {gmailResultsSchema,gmailContentSchema,type GmailMessage,type GmailResults,type GmailContent} from '@yui/domain';
export const GMAIL_SCOPES=['openid','https://www.googleapis.com/auth/gmail.readonly'] as const;
export type GmailRpc=(owner:string,operation:string,args:Record<string,unknown>)=>Promise<any>;
export type GmailService={status(owner:RequestUser):Promise<{connected:boolean;writeEnabled?:boolean}>;writeAccess?(owner:RequestUser):Promise<{token:string;generation:string;subject:string}>;begin(owner:RequestUser,write?:boolean):Promise<string>;complete(code:string,state:string):Promise<boolean>;disconnect(owner:RequestUser):Promise<void>;search(owner:RequestUser,query:string,pageToken?:string):Promise<GmailResults>;read(owner:RequestUser,id:string):Promise<GmailContent>};
const id=z.string().regex(/^[a-f0-9]+$/).max(64);
const header=z.object({name:z.string().max(200),value:z.string().max(16000)});
const metadata=z.object({id,threadId:id,payload:z.object({headers:z.array(header).max(200).optional()}).optional()});
function visible(raw:unknown):GmailMessage {const m=metadata.parse(raw);const value=(name:string,max:number)=>m.payload?.headers?.find(h=>h.name.toLowerCase()===name)?.value.slice(0,max)??'';return {id:m.id,threadId:m.threadId,subject:value('subject',1024),from:value('from',1024),date:value('date',200)};}
export function gmailBody(raw:unknown):{text:string;truncated:boolean}{
 const plain:string[]=[],html:string[]=[];let count=0,bytes=0,oversize=false;
 function walk(part:any,depth:number){if(!part||typeof part!=='object')return;if(depth>12||++count>100){oversize=true;return;}if(part.filename)return;
  if(typeof part.body?.data==='string'&&['text/plain','text/html'].includes(part.mimeType)){
   if(part.body.data.length>1400000)throw Error('gmail_message_too_large');const data=Buffer.from(part.body.data,'base64url');bytes+=data.length;if(bytes>1000000)throw Error('gmail_message_too_large');
   const contentType=Array.isArray(part.headers)?part.headers.find((h:any)=>typeof h?.name==='string'&&h.name.toLowerCase()==='content-type')?.value:'';
   const charset=typeof contentType==='string'?/charset\s*=\s*[\"']?([^;\s\"']+)/i.exec(contentType)?.[1]:'utf-8';
   let decoded:string;try{decoded=new TextDecoder(charset||'utf-8',{fatal:true}).decode(data);}catch{throw Error('gmail_encoding_unavailable');}
   (part.mimeType==='text/plain'?plain:html).push(decoded);
  } else if(part.body?.attachmentId&&['text/plain','text/html'].includes(part.mimeType)){oversize=true;}
  if(Array.isArray(part.parts))for(const child of part.parts)walk(child,depth+1);
 }
 walk(raw,0);const text=plain.length?plain.join('\n'):convert(html.join('\n'),{wordwrap:false,selectors:[{selector:'img',format:'skip'},{selector:'a',options:{ignoreHref:true}},{selector:'script',format:'skip'},{selector:'style',format:'skip'}]});
 return {text:text.slice(0,20000),truncated:oversize||text.length>20000};
}
export const GMAIL_WRITE_SCOPE='https://www.googleapis.com/auth/gmail.send';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function createGmailService(config:{clientId:string;clientSecret:string;redirectUri:string;key:Buffer;rpc:GmailRpc;fetch?:typeof fetch;now?:()=>number}):GmailService {
 if(config.key.length!==32)throw Error('invalid_key');
 const http=config.fetch??fetch,now=config.now??Date.now;
 function seal(value:unknown,owner:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',config.key,iv);cipher.setAAD(Buffer.from('zundamon-gmail:'+owner));const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');}
 function open(value:string,owner:string){const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',config.key,bytes.subarray(0,12));decipher.setAAD(Buffer.from('zundamon-gmail:'+owner));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());}
 async function token(body:Record<string,string>){const response=await http('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),body:new URLSearchParams({...body,client_id:config.clientId,client_secret:config.clientSecret})});if(!response.ok)throw Error('gmail_token_unavailable');return await readBoundedJson(response,16384) as Record<string,unknown>;}
 function scopes(value:unknown){return typeof value==='string'&&GMAIL_SCOPES.every(scope=>value.split(' ').includes(scope));}
 async function connection(owner:RequestUser){const row=await config.rpc(owner.userId,'get',{});if(!row?.payload)throw Error('gmail_not_connected');return {row,value:open(row.payload,owner.userId)};}
 async function access(owner:RequestUser,expectedGeneration?:string){const {row,value}=await connection(owner);if(expectedGeneration&&row.generation!==expectedGeneration)throw Error('connection_changed');const result=await token({grant_type:'refresh_token',refresh_token:value.refreshToken});if(typeof result.access_token!=='string'||result.token_type!=='Bearer'||result.scope!==undefined&&!scopes(result.scope))throw Error('gmail_token_unavailable');if(expectedGeneration&&result.scope!==undefined&&!(typeof result.scope==='string'&&result.scope.split(' ').includes(GMAIL_WRITE_SCOPE)))throw Error('write_permission_required');const current=await config.rpc(owner.userId,'get',{});if(current?.generation!==row.generation||!current?.payload)throw Error('gmail_disconnected');return result.access_token;}
 async function api(owner:RequestUser,path:string,params:Record<string,string>){const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+path);for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);const response=await http(url,{headers:{Authorization:'Bearer '+await access(owner)},redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('gmail_unavailable');return response;}
 const service:GmailService={
 async status(owner){const row=await config.rpc(owner.userId,'get',{});return {connected:!!row?.payload,writeEnabled:!!row?.payload&&open(row.payload,owner.userId).scopes?.includes(GMAIL_WRITE_SCOPE)===true};},
 async writeAccess(owner){const {row,value}=await connection(owner);if(!value.scopes?.includes(GMAIL_WRITE_SCOPE))throw Error('write_permission_required');return {token:await access(owner,row.generation),generation:row.generation,subject:value.subject};},
 async begin(owner,write=false){const state='gmail.'+randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');await config.rpc(owner.userId,'begin',{stateHash:hash(state),payload:seal({nonce,verifier,write},owner.userId),expiresAt:new Date(now()+300000).toISOString()});const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');for(const [k,v]of Object.entries({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:[...GMAIL_SCOPES,...(write?[GMAIL_WRITE_SCOPE]:[])].join(' '),state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'consent',include_granted_scopes:'false'}))url.searchParams.set(k,v);return url.toString();},
 async complete(code,state){let stage='state';if(!/^gmail\.[\w-]{43}$/.test(state)||!code||code.length>4096)return false;try{stage='consume';const attempt=await config.rpc('','consume',{stateHash:hash(state)});if(!attempt||Date.parse(attempt.expiresAt)<=now()){console.warn('gmail_callback:attempt_missing_or_expired');return false;}stage='decrypt';const saved=open(attempt.payload,attempt.ownerId);stage='token';const result=await token({grant_type:'authorization_code',code,redirect_uri:config.redirectUri,code_verifier:saved.verifier});if(typeof result.id_token!=='string'||typeof result.refresh_token!=='string'||!result.refresh_token||!scopes(result.scope)||saved.write&&!(result.scope as string).split(' ').includes(GMAIL_WRITE_SCOPE)){console.warn('gmail_callback:token_fields_invalid');return false;}stage='identity';
 const transport={get:async({url,signal}:{url:string;signal:AbortSignal})=>{const r=await http(url,{redirect:'error',signal});return {status:r.status,readJson:(max:number)=>readBoundedJson(r,max)};},post:async()=>{throw Error('unused');}};
 const claims=await verifyGoogleIdToken(transport,result.id_token,{nonceDigest:'sha256:'+hash(saved.nonce),audience:config.clientId,issuer:'https://accounts.google.com',signal:AbortSignal.timeout(15000),now:()=>new Date(now())});
 stage='save';await config.rpc(attempt.ownerId,'save',{generation:attempt.generation,payload:seal({refreshToken:result.refresh_token,subject:claims.subject,scopes:(result.scope as string).split(' ')},attempt.ownerId)});return true;}catch{console.warn('gmail_callback:'+stage);return false;}},
 async disconnect(owner){await config.rpc(owner.userId,'disconnect',{});},
 async search(owner,query,pageToken){
  query=z.string().trim().min(1).max(500).parse(query);if(pageToken)z.string().max(2048).parse(pageToken);
  const list=z.object({messages:z.array(z.object({id,threadId:id})).max(10).optional(),nextPageToken:z.string().max(2048).optional()}).parse(await readBoundedJson(await api(owner,'messages',{q:query,maxResults:'10',includeSpamTrash:'false',...(pageToken?{pageToken}:{})}),32000));
  const messages:GmailMessage[]=[];for(const item of list.messages??[])messages.push(visible(await readBoundedJson(await api(owner,'messages/'+item.id,{format:'metadata',fields:'id,threadId,payload(headers)'}),64000)));
  return gmailResultsSchema.parse({messages,...(list.nextPageToken?{nextPageToken:list.nextPageToken}:{})});
 },
 async read(owner,messageId){id.parse(messageId);const raw=await readBoundedJson(await api(owner,'messages/'+messageId,{format:'full',fields:'id,threadId,payload'}),1600000) as any;return gmailContentSchema.parse({message:visible(raw),...gmailBody(raw.payload)});}
 };return service;
}
export function registerGmailRoutes(app:FastifyInstance,gmail?:GmailService){
 app.addHook('onRequest',async(req,reply)=>{const url=new URL(req.url,'http://localhost');if(req.method!=='GET'||url.pathname!=='/api/google-calendar-tasks/callback'||!url.searchParams.get('state')?.startsWith('gmail.'))return;const ok=gmail&&await gmail.complete(url.searchParams.get('code')??'',url.searchParams.get('state')??'');return reply.header('cache-control','no-store').header('Referrer-Policy','no-referrer').redirect('/?gmail='+(ok?'connected':'failed'),303);});
 app.get('/api/gmail/status',async(req,reply)=>{reply.header('cache-control','no-store');if(!req.yuiUser)return reply.code(401).send();if(!gmail)return {connected:false,available:false};try{return {...await gmail.status(req.yuiUser),available:true};}catch{return reply.code(503).send({error:'gmail_unavailable'});}});
 const route=(path:string,fn:(owner:RequestUser,body:any)=>Promise<unknown>)=>app.post('/api/gmail/'+path,async(req,reply)=>{reply.header('cache-control','no-store');if(!req.yuiUser)return reply.code(401).send();if(!gmail)return reply.code(503).send({error:'gmail_unavailable'});try{return await fn(req.yuiUser,req.body);}catch{return reply.code(409).send({error:'gmail_unavailable'});}});
 route('connect',async(owner,body)=>({authorizationUrl:await gmail!.begin(owner,z.object({write:z.boolean().optional()}).strict().parse(body??{}).write)}));route('disconnect',async owner=>{await gmail!.disconnect(owner);return {connected:false};});
 route('search',async(owner,body)=>{const b=z.object({query:z.string(),pageToken:z.string().optional()}).strict().parse(body);return gmail!.search(owner,b.query,b.pageToken);});
 route('read',async(owner,body)=>{const b=z.object({id:z.string()}).strict().parse(body);return gmail!.read(owner,b.id);});
}
