import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import type {GmailService} from './gmail.js';
import type {DriveService} from './google-drive.js';
import type {RequestUser} from './request-user.js';
import {readBoundedJson} from './google-oauth-runtime.js';
const singleLine=z.string().trim().min(1).max(200).regex(/^[^\r\n\x00-\x1f]+$/);
export const writeInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('gmail'),to:z.email().max(254).regex(/^[\x21-\x7e]+$/),title:singleLine,body:z.string().trim().min(1).max(20000),replyId:z.string().regex(/^[a-f0-9]{1,64}$/).optional()}).strict(),
 z.object({kind:z.literal('drive'),folderId:z.string().regex(/^[\w-]{1,256}$/),title:singleLine,body:z.string().trim().min(1).max(20000)}).strict()
]);
export type GoogleWriteInput=z.infer<typeof writeInput>;
export type WriteRpc=(owner:string,operation:string,args:Record<string,unknown>)=>Promise<any>;
export function encodeMail(input:{to:string;from:string;title:string;body:string;reference?:string}){
 const title=Array.from(input.title).reduce<string[]>((parts,char)=>{if(Buffer.byteLength((parts.at(-1)??'')+char)>36)parts.push(char);else parts[parts.length-1]+=char;return parts;},['']).map(p=>'=?UTF-8?B?'+Buffer.from(p).toString('base64')+'?=').join('\r\n ');
 const headers=[`From: ${input.from}`,`To: ${input.to}`,`Subject: ${title}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'];
 if(input.reference)headers.push(`In-Reply-To: ${input.reference}`,`References: ${input.reference}`);
 return Buffer.from(headers.join('\r\n')+'\r\n\r\n'+(Buffer.from(input.body).toString('base64').match(/.{1,76}/g)??[]).join('\r\n')).toString('base64url');
}
export function createGoogleWrites(config:{gmail?:GmailService;drive?:DriveService;rpc:WriteRpc;key:Buffer;fetch?:typeof fetch}){
 const http=config.fetch??fetch;
 function encrypt(v:any,owner:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',config.key,iv);c.setAAD(Buffer.from('google-write:'+owner));const bytes=Buffer.concat([c.update(JSON.stringify(v)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]).toString('base64');}
 function decrypt(v:string,owner:string){const b=Buffer.from(v,'base64'),d=createDecipheriv('aes-256-gcm',config.key,b.subarray(0,12));d.setAAD(Buffer.from('google-write:'+owner));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
 async function access(owner:RequestUser,kind:string){const p=kind==='gmail'?config.gmail:config.drive;if(!p?.writeAccess)throw Error('write_permission_required');return p.writeAccess(owner);}
 async function get(url:string,token:string){const r=await http(url,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('source_unavailable');return readBoundedJson(r,64000) as Promise<any>;}
 function view(row:any,owner:string){if(!row)throw Error('not_found');const p=decrypt(row.payload,owner);return {id:row.id,state:row.state,expiresAt:row.expiresAt,input:p.input,location:p.location,from:p.from??null,result:row.result??null};}
 return {
 async prepare(owner:RequestUser,raw:unknown){const input=writeInput.parse(raw),ctx=await access(owner,input.kind);let extra:any={};
 if(input.kind==='drive'){const folder=await get('https://www.googleapis.com/drive/v3/files/'+input.folderId+'?fields=id,name,mimeType,trashed,capabilities(canAddChildren)',ctx.token);if(folder.trashed||folder.mimeType!=='application/vnd.google-apps.folder'||!folder.capabilities?.canAddChildren)throw Error('folder_unavailable');extra.location=folder.name;}
 else{const profile=await get('https://gmail.googleapis.com/gmail/v1/users/me/profile',ctx.token);extra.from=z.email().parse(profile.emailAddress);extra.location=input.to;
 if(input.replyId){const m=await get('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+input.replyId+'?format=metadata&fields=threadId,payload(headers)',ctx.token);const reference=m.payload?.headers?.find((h:any)=>h.name.toLowerCase()==='message-id')?.value;if(typeof reference==='string'&&/^<[^<>\s\r\n]{1,240}>$/.test(reference)){extra.reference=reference;extra.threadId=z.string().regex(/^[a-f0-9]+$/).parse(m.threadId);}}}
 const id=randomUUID(),expiresAt=new Date(Date.now()+300000).toISOString();const row=await config.rpc(owner.userId,'prepare',{id,expiresAt,payload:encrypt({input,generation:ctx.generation,subject:ctx.subject,...extra},owner.userId)});return view(row,owner.userId);},
 async status(owner:RequestUser,id:string){return view(await config.rpc(owner.userId,'get',{id}),owner.userId);},
 async cancel(owner:RequestUser,id:string){return view(await config.rpc(owner.userId,'cancel',{id}),owner.userId);},
 async confirm(owner:RequestUser,id:string){const before=await config.rpc(owner.userId,'get',{id});if(!before)throw Error('not_found');if(before.state!=='prepared')return view(before,owner.userId);const p=decrypt(before.payload,owner.userId),input=writeInput.parse(p.input),ctx=await access(owner,input.kind);if(ctx.generation!==p.generation||ctx.subject!==p.subject)throw Error('connection_changed');
 const claimed=await config.rpc(owner.userId,'claim',{id});if(!claimed)return this.status(owner,id);
 let result:any=null;let state='unknown';try{let r:Response;
 if(input.kind==='gmail'){r=await http('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:'Bearer '+ctx.token,'Content-Type':'application/json'},body:JSON.stringify({raw:encodeMail({...input,from:p.from,reference:p.reference}),...(p.threadId?{threadId:p.threadId}:{})}),redirect:'error',signal:AbortSignal.timeout(20000)});if(r.ok){const d:any=await readBoundedJson(r,16000);result={id:z.string().regex(/^[a-f0-9]+$/).parse(d.id)};state='succeeded';}}
 else{const boundary='zundamon_'+randomBytes(16).toString('hex');const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name:input.title,mimeType:'text/plain',parents:[input.folderId]})}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.body}\r\n--${boundary}--`;r=await http('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{Authorization:'Bearer '+ctx.token,'Content-Type':'multipart/related; boundary='+boundary},body,redirect:'error',signal:AbortSignal.timeout(20000)});if(r.ok){const d:any=await readBoundedJson(r,16000);result={id:z.string().regex(/^[\w-]+$/).parse(d.id)};state='succeeded';}}
 }catch{/* Never automatically retry a request whose external outcome is uncertain. */}
 await config.rpc(owner.userId,'finish',{id,state,result});return this.status(owner,id);
 }
 };
}
export type GoogleWrites=ReturnType<typeof createGoogleWrites>;
export function registerGoogleWrites(app:FastifyInstance,service?:GoogleWrites){for(const action of ['prepare','status','cancel','confirm'] as const)app.post('/api/google-writes/'+action,async(req,reply)=>{reply.header('cache-control','no-store');if(!req.yuiUser)return reply.code(401).send();if(!service)return reply.code(503).send({error:'unavailable'});try{if(action==='prepare')return await service.prepare(req.yuiUser,req.body);const {id}=z.object({id:z.uuid()}).strict().parse(req.body);return await service[action](req.yuiUser,id);}catch{return reply.code(409).send({error:'write_unavailable'});}});}
