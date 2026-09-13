import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import type {SakuraSpeechGateway} from './sakura-speech.js';
export type VoiceProvider='ttsquest'|'sakura';
export function createVoiceConnection(options:{directory:string;owner:()=>string|undefined;ttsquest:SakuraSpeechGateway;sakura?:SakuraSpeechGateway;origin:string;defaultProvider?:VoiceProvider}){
 const path=(owner:string)=>join(options.directory,createHash('sha256').update(owner).digest('hex')+'.json');
 const selected=(owner:string):VoiceProvider=>{if(!existsSync(path(owner)))return options.defaultProvider??'ttsquest';const data=JSON.parse(readFileSync(path(owner),'utf8'));if(data.provider!=='ttsquest'&&data.provider!=='sakura')throw Error('invalid_voice_settings');return data.provider;};
 const speedFor=(owner:string):number=>{if(!existsSync(path(owner)))return 1;const speed=JSON.parse(readFileSync(path(owner),'utf8')).speed;return typeof speed==='number'&&Number.isFinite(speed)&&speed>=0.8&&speed<=1.3?speed:1;};
 const status=(owner:string)=>{const provider=selected(owner);return {provider,speed:provider==='sakura'?speedFor(owner):1,available:provider==='ttsquest'||!!options.sakura,sakuraConfigured:!!options.sakura};};
 const gateway:SakuraSpeechGateway={speak(text,signal){const owner=options.owner();if(!owner)throw Error('owner_required');const service=selected(owner)==='ttsquest'?options.ttsquest:options.sakura;if(!service)throw Error('speech_unavailable');return selected(owner)==='sakura'?service.speak(text,signal,speedFor(owner)):service.speak(text,signal);}};
 return {gateway,register(app:FastifyInstance){
  app.get('/api/voice-connection',async(req,reply)=>{reply.header('Cache-Control','no-store');try{return status(req.yuiUser.userId);}catch{return reply.code(503).send({error:'voice_settings_unavailable'});}});
  app.put('/api/voice-connection',{bodyLimit:512},async(req,reply)=>{reply.header('Cache-Control','no-store');if(req.headers.origin!==options.origin)return reply.code(403).send({error:'origin_not_allowed'});const provider=(req.body as {provider?:unknown})?.provider;const speed=(req.body as {speed?:unknown})?.speed;if(speed!==undefined&&(typeof speed!=='number'||!Number.isFinite(speed)||speed<0.8||speed>1.3))return reply.code(400).send({error:'invalid_speed'});if(provider!=='ttsquest'&&provider!=='sakura')return reply.code(400).send({error:'invalid_provider'});if(provider==='sakura'&&!options.sakura)return reply.code(409).send({error:'sakura_not_configured'});try{mkdirSync(options.directory,{recursive:true,mode:0o700});const target=path(req.yuiUser.userId),temp=target+'.'+randomBytes(6).toString('hex');writeFileSync(temp,JSON.stringify({provider,speed:speed??speedFor(req.yuiUser.userId)}),{flag:'wx',mode:0o600});renameSync(temp,target);return status(req.yuiUser.userId);}catch{return reply.code(503).send({error:'voice_settings_unavailable'});}});
 }};
}
