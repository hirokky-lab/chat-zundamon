import {extractPdfText} from './pdf-text.js';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import type {RequestUser} from './request-user.js';
import {verifyGoogleIdToken,readBoundedJson} from './google-oauth-runtime.js';

export const DRIVE_SCOPES=['openid','https://www.googleapis.com/auth/drive.readonly'] as const;
const fileSchema=z.object({id:z.string().regex(/^[\w-]+$/).max(256),name:z.string().max(1024),mimeType:z.string().max(200),modifiedTime:z.string().max(64).optional(),size:z.string().optional(),capabilities:z.object({canDownload:z.boolean().optional()}).optional(),trashed:z.boolean().optional()}).passthrough();
export type DriveFile={id:string;name:string;mimeType:string;modifiedTime?:string};
export type DriveResults={files:DriveFile[];nextPageToken?:string};
export type DriveContent={file:DriveFile;text:string;truncated:boolean};
export type DriveRpc=(owner:string,operation:string,args:Record<string,unknown>)=>Promise<any>;
export type DriveService={status(owner:RequestUser):Promise<{connected:boolean;writeEnabled?:boolean}>;writeAccess?(owner:RequestUser):Promise<{token:string;generation:string;subject:string}>;begin(owner:RequestUser,write?:boolean):Promise<string>;complete(code:string,state:string):Promise<boolean>;disconnect(owner:RequestUser):Promise<void>;search(owner:RequestUser,query:string,pageToken?:string,mediaType?:'video'|'image'):Promise<DriveResults>;read(owner:RequestUser,id:string):Promise<DriveContent>};
export const DRIVE_WRITE_SCOPE='https://www.googleapis.com/auth/drive';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function createGoogleDriveService(config:{clientId:string;clientSecret:string;redirectUri:string;key:Buffer;rpc:DriveRpc;fetch?:typeof fetch;now?:()=>number}):DriveService {
 if(config.key.length!==32)throw Error('invalid_key');
 const http=config.fetch??fetch,now=config.now??Date.now;
 function seal(value:unknown,owner:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',config.key,iv);cipher.setAAD(Buffer.from('zundamon-drive:'+owner));const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');}
 function open(value:string,owner:string){const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',config.key,bytes.subarray(0,12));decipher.setAAD(Buffer.from('zundamon-drive:'+owner));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());}
 async function token(body:Record<string,string>){const response=await http('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),body:new URLSearchParams({...body,client_id:config.clientId,client_secret:config.clientSecret})});if(!response.ok)throw Error('drive_token_unavailable');return await readBoundedJson(response,16384) as Record<string,unknown>;}
 function scopes(value:unknown){return typeof value==='string'&&DRIVE_SCOPES.every(scope=>value.split(' ').includes(scope));}
 async function connection(owner:RequestUser){const row=await config.rpc(owner.userId,'get',{});if(!row?.payload)throw Error('drive_not_connected');return {row,value:open(row.payload,owner.userId)};}
 async function access(owner:RequestUser,expectedGeneration?:string){const {row,value}=await connection(owner);if(expectedGeneration&&row.generation!==expectedGeneration)throw Error('connection_changed');const result=await token({grant_type:'refresh_token',refresh_token:value.refreshToken});if(typeof result.access_token!=='string'||result.token_type!=='Bearer'||result.scope!==undefined&&!scopes(result.scope))throw Error('drive_token_unavailable');if(expectedGeneration&&result.scope!==undefined&&!(typeof result.scope==='string'&&result.scope.split(' ').includes(DRIVE_WRITE_SCOPE)))throw Error('write_permission_required');const current=await config.rpc(owner.userId,'get',{});if(current?.generation!==row.generation||!current?.payload)throw Error('drive_disconnected');return result.access_token;}
 async function api(owner:RequestUser,path:string,params:Record<string,string>){const url=new URL('https://www.googleapis.com/drive/v3/'+path);for(const [k,v]of Object.entries(params))url.searchParams.set(k,v);const response=await http(url,{headers:{Authorization:'Bearer '+await access(owner)},redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('drive_unavailable');return response;}
 const visible=(f:z.infer<typeof fileSchema>):DriveFile=>({id:f.id,name:f.name,mimeType:f.mimeType,...(f.modifiedTime?{modifiedTime:f.modifiedTime}:{})});
 const service:DriveService={
 async status(owner){const row=await config.rpc(owner.userId,'get',{});return {connected:!!row?.payload,writeEnabled:!!row?.payload&&open(row.payload,owner.userId).scopes?.includes(DRIVE_WRITE_SCOPE)===true};},
 async writeAccess(owner){const {row,value}=await connection(owner);if(!value.scopes?.includes(DRIVE_WRITE_SCOPE))throw Error('write_permission_required');return {token:await access(owner,row.generation),generation:row.generation,subject:value.subject};},
 async begin(owner,write=false){const state='drive.'+randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');await config.rpc(owner.userId,'begin',{stateHash:hash(state),payload:seal({nonce,verifier,write},owner.userId),expiresAt:new Date(now()+300000).toISOString()});const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');for(const [k,v]of Object.entries({client_id:config.clientId,redirect_uri:config.redirectUri,response_type:'code',scope:[...DRIVE_SCOPES,...(write?[DRIVE_WRITE_SCOPE]:[])].join(' '),state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'consent',include_granted_scopes:'false'}))url.searchParams.set(k,v);return url.toString();},
 async complete(code,state){if(!/^drive\.[\w-]{43}$/.test(state)||!code||code.length>4096)return false;try{const attempt=await config.rpc('','consume',{stateHash:hash(state)});if(!attempt||Date.parse(attempt.expiresAt)<=now())return false;const saved=open(attempt.payload,attempt.ownerId);const result=await token({grant_type:'authorization_code',code,redirect_uri:config.redirectUri,code_verifier:saved.verifier});if(typeof result.id_token!=='string'||typeof result.refresh_token!=='string'||!result.refresh_token||!scopes(result.scope)||saved.write&&!(result.scope as string).split(' ').includes(DRIVE_WRITE_SCOPE))return false;
 const transport={get:async({url,signal}:{url:string;signal:AbortSignal})=>{const r=await http(url,{redirect:'error',signal});return {status:r.status,readJson:(max:number)=>readBoundedJson(r,max)};},post:async()=>{throw Error('unused');}};
 const claims=await verifyGoogleIdToken(transport,result.id_token,{nonceDigest:'sha256:'+hash(saved.nonce),audience:config.clientId,issuer:'https://accounts.google.com',signal:AbortSignal.timeout(15000),now:()=>new Date(now())});
 await config.rpc(attempt.ownerId,'save',{generation:attempt.generation,payload:seal({refreshToken:result.refresh_token,subject:claims.subject,scopes:(result.scope as string).split(' ')},attempt.ownerId)});return true;}catch{return false;}},
 async disconnect(owner){await config.rpc(owner.userId,'disconnect',{});},
 async search(owner,query,pageToken,mediaType){
  query=z.string().trim().min(1).max(200).parse(query);if(pageToken)z.string().max(2048).parse(pageToken);if(mediaType)z.enum(['video','image']).parse(mediaType);
  const escaped=query.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const schema=z.object({files:z.array(fileSchema).max(100),nextPageToken:z.string().max(2048).optional(),incompleteSearch:z.boolean().optional()});
  const list=async(q:string,token?:string)=>{const r=schema.parse(await readBoundedJson(await api(owner,'files',{q,fields:'files(id,name,mimeType,modifiedTime),nextPageToken,incompleteSearch',pageSize:'20',orderBy:'modifiedTime desc',spaces:'drive',...(token?{pageToken:token}:{})}),256000));if(r.incompleteSearch)throw Error('drive_incomplete_search');return r;};
  let match=`fullText contains '${escaped}'`;
  if(mediaType){
   const folders=await list(`trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escaped}'`);
   if(folders.nextPageToken)throw Error('drive_incomplete_search');
   match=[match,...folders.files.map(f=>`'${f.id}' in parents`)].join(' or ');
  }
  const result=await list(`trashed = false and (${match})${mediaType?` and mimeType contains '${mediaType}/'`:''}`,pageToken);
  return {files:result.files.map(visible),...(result.nextPageToken?{nextPageToken:result.nextPageToken}:{})};
 },
 async read(owner,id){z.string().regex(/^[\w-]+$/).max(256).parse(id);const metadata=fileSchema.parse(await readBoundedJson(await api(owner,'files/'+id,{fields:'id,name,mimeType,modifiedTime,size,capabilities(canDownload),trashed'}),16384));if(metadata.trashed||metadata.capabilities?.canDownload===false)throw Error('drive_unavailable');let response:Response;
 if(metadata.mimeType==='application/vnd.google-apps.document')response=await api(owner,'files/'+id+'/export',{mimeType:'text/plain'});
 else if(metadata.mimeType==='application/pdf'){if(Number(metadata.size)>10000000)throw Error('drive_file_too_large');response=await api(owner,'files/'+id,{alt:'media'});}
 else if(metadata.mimeType.startsWith('text/')||['application/json','application/xml'].includes(metadata.mimeType)){if(Number(metadata.size)>1000000)throw Error('drive_file_too_large');response=await api(owner,'files/'+id,{alt:'media'});}else throw Error('drive_unsupported_type');
 const reader=response.body?.getReader();if(!reader)throw Error('drive_unavailable');const chunks:Uint8Array[]=[];let length=0;try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>(metadata.mimeType==='application/pdf'?10000000:1000000)){await reader.cancel();throw Error('drive_file_too_large');}chunks.push(part.value);}}finally{reader.releaseLock();}if(metadata.mimeType==='application/pdf')return {file:visible(metadata),...await extractPdfText(Buffer.concat(chunks))};const text=Buffer.concat(chunks).toString('utf8');return {file:visible(metadata),text:text.slice(0,20000),truncated:text.length>20000};}
 };return service;
}
export function registerGoogleDriveRoutes(app:FastifyInstance,drive?:DriveService){
 // Reuse the already registered dedicated Google client's callback URL, with disjoint opaque state.
 app.addHook('onRequest',async(req,reply)=>{const url=new URL(req.url,'http://localhost');if(req.method!=='GET'||url.pathname!=='/api/google-calendar-tasks/callback'||!url.searchParams.get('state')?.startsWith('drive.'))return;const ok=drive&&await drive.complete(url.searchParams.get('code')??'',url.searchParams.get('state')??'');return reply.header('cache-control','no-store').header('Referrer-Policy','no-referrer').redirect('/?drive='+(ok?'connected':'failed'),303);});
 app.get('/api/google-drive/status',async(req,reply)=>{reply.header('cache-control','no-store');if(!req.yuiUser)return reply.code(401).send();if(!drive)return {connected:false,available:false};try{return {...await drive.status(req.yuiUser),available:true};}catch{return reply.code(503).send({error:'drive_unavailable'});}});
 app.get('/api/google-drive/callback',async(req,reply)=>{reply.header('cache-control','no-store').header('Referrer-Policy','no-referrer');const q=req.query as Record<string,unknown>;const ok=drive&&typeof q.code==='string'&&typeof q.state==='string'&&await drive.complete(q.code,q.state);return reply.redirect('/?drive='+ (ok?'connected':'failed'),303);});
 const route=(path:string,fn:(owner:RequestUser,body:any)=>Promise<unknown>,method:'POST'|'DELETE'='POST')=>app.route({method,url:path,handler:async(req,reply)=>{reply.header('cache-control','no-store');if(!req.yuiUser)return reply.code(401).send();if(!drive)return reply.code(503).send({error:'drive_unavailable'});try{return await fn(req.yuiUser,req.body);}catch(e){const code=e instanceof Error&&['drive_unsupported_type','drive_file_too_large','drive_not_connected','drive_pdf_no_text','drive_pdf_locked','drive_pdf_unavailable'].includes(e.message)?e.message:'drive_unavailable';return reply.code(409).send({error:code});}}});
 route('/api/google-drive/connect',async(owner,body)=>({authorizationUrl:await drive!.begin(owner,z.object({write:z.boolean().optional()}).strict().parse(body??{}).write)}));
 route('/api/google-drive/disconnect',async owner=>{await drive!.disconnect(owner);return {connected:false};});
 route('/api/google-drive/search',async(owner,body)=>{const b=z.object({query:z.string(),pageToken:z.string().optional(),mediaType:z.enum(['video','image']).optional()}).strict().parse(body);return drive!.search(owner,b.query,b.pageToken,b.mediaType);});
 route('/api/google-drive/read',async(owner,body)=>{const b=z.object({id:z.string()}).strict().parse(body);return drive!.read(owner,b.id);});
}
