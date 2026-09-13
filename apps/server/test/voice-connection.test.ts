import {it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import Fastify from 'fastify';
import {createVoiceConnection} from '../src/voice-connection';
it('persists owner selection and never falls back on provider failure',async()=>{const directory=mkdtempSync(join(tmpdir(),'voice-'));let owner='a';const ttsquest={speak:vi.fn(async()=>Buffer.from('tts'))},sakura={speak:vi.fn(async()=>{throw Error('speech_rate_limited');})};const options={directory,owner:()=>owner,ttsquest,sakura,origin:'https://app.example'};const service=createVoiceConnection(options),app=Fastify();app.decorateRequest('yuiUser');app.addHook('onRequest',async req=>{req.yuiUser={userId:owner,email:'owner@example.com',accessToken:'test'};});service.register(app);try{expect((await service.gateway.speak('test')).toString()).toBe('tts');expect((await app.inject({url:'/api/voice-connection',method:'PUT',payload:{provider:'sakura'}})).statusCode).toBe(403);expect((await app.inject({url:'/api/voice-connection',method:'PUT',headers:{origin:options.origin},payload:{provider:'sakura'}})).statusCode).toBe(200);await expect(createVoiceConnection(options).gateway.speak('test')).rejects.toThrow('speech_rate_limited');expect(ttsquest.speak).toHaveBeenCalledTimes(1);owner='b';expect((await service.gateway.speak('test')).toString()).toBe('tts');}finally{await app.close();rmSync(directory,{recursive:true,force:true});}});
it('uses the installer default only until the owner chooses a provider',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'voice-'));
 const options={directory,owner:()=> 'owner',origin:'https://app.example',defaultProvider:'sakura' as const,ttsquest:{speak:vi.fn(async()=>Buffer.from('tts'))},sakura:{speak:vi.fn(async()=>Buffer.from('sakura'))}};
 const service=createVoiceConnection(options),app=Fastify();app.decorateRequest('yuiUser');app.addHook('onRequest',async req=>{req.yuiUser={userId:'owner',email:'owner@example.com',accessToken:'test'};});service.register(app);
 try{expect((await service.gateway.speak('test')).toString()).toBe('sakura');await app.inject({url:'/api/voice-connection',method:'PUT',headers:{origin:options.origin},payload:{provider:'ttsquest'}});expect((await createVoiceConnection(options).gateway.speak('test')).toString()).toBe('tts');}finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
it('persists bounded Sakura speed per owner and passes it to synthesis',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'voice-speed-'));let owner='a';const speak=vi.fn(async()=>Buffer.from('audio'));
 const options={directory,owner:()=>owner,origin:'https://app.example',ttsquest:{speak},sakura:{speak}};
 const service=createVoiceConnection(options),app=Fastify();app.decorateRequest('yuiUser');app.addHook('onRequest',async req=>{req.yuiUser={userId:owner,email:'test@example.com',accessToken:'test'};});service.register(app);
 try{
 for(const speed of [0,9,'fast'])expect((await app.inject({method:'PUT',url:'/api/voice-connection',headers:{origin:options.origin},payload:{provider:'sakura',speed}})).statusCode).toBe(400);
 expect((await app.inject({method:'PUT',url:'/api/voice-connection',headers:{origin:options.origin},payload:{provider:'sakura',speed:1.2}})).json().speed).toBe(1.2);
 await createVoiceConnection(options).gateway.speak('test');expect(speak).toHaveBeenLastCalledWith('test',undefined,1.2);
 owner='b';expect((await app.inject('/api/voice-connection')).json().speed).toBe(1);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
