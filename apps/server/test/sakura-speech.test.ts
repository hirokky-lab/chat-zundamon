import {describe,it,expect,vi} from 'vitest';
import {createSakuraSpeechGateway} from '../src/sakura-speech.js';
import {ZUNDAMON_CHARACTER} from '@yui/domain';

describe('Sakura speech boundary',()=>{
  it('uses the accepted video profile after obtaining pronunciation from Sakura',async()=>{
    const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
    const query={accent_phrases:[],speedScale:1,intonationScale:1,pauseLengthScale:1};
    const fetch=vi.fn().mockResolvedValueOnce(Response.json(query)).mockResolvedValueOnce(new Response(wav));
    expect(await createSakuraSpeechGateway({apiKey:'private-fixture',fetch}).speak('こんにちは。')).toEqual(wav);
    const [url,init]=fetch.mock.calls[0] as [string,RequestInit];
    expect(new URL(url).pathname).toBe('/tts/v1/audio_query');
    expect(new URL(url).searchParams.get('text')).toBe('こんにちは。');
    expect(new URL(url).searchParams.get('speaker')).toBe('3');
    const [synthesisUrl,synthesisInit]=fetch.mock.calls[1] as [string,RequestInit];
    expect(synthesisUrl).toBe('https://api.ai.sakura.ad.jp/tts/v1/synthesis?speaker=3');
    expect(JSON.parse(synthesisInit.body as string)).toMatchObject({accent_phrases:[],speedScale:1.1,intonationScale:1.04,pauseLengthScale:0.75,prePhonemeLength:0.08,postPhonemeLength:0.1,outputSamplingRate:24000});
    expect(synthesisInit.signal).toBe(init.signal);
    expect(init.redirect).toBe('error');expect(synthesisInit.redirect).toBe('error');
  });
  it('takes its speaker and synthesis controls from an injected character voice',async()=>{
    const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({accent_phrases:[]})).mockResolvedValueOnce(new Response(wav));
    const voice={...ZUNDAMON_CHARACTER.voice,speaker:9,speedScale:0.9,intonationScale:1.2,pauseLengthScale:0.6};
    await createSakuraSpeechGateway({apiKey:'private-fixture',fetch,voice}).speak('こんにちは。');
    expect(new URL(fetch.mock.calls[0]![0] as string).searchParams.get('speaker')).toBe('9');
    const [synthesisUrl,synthesisInit]=fetch.mock.calls[1] as [string,RequestInit];
    expect(new URL(synthesisUrl).searchParams.get('speaker')).toBe('9');
    expect(JSON.parse(synthesisInit.body as string)).toMatchObject({speedScale:0.9,intonationScale:1.2,pauseLengthScale:0.6});
  });
  it('does not start synthesis if cancelled while the query is being prepared',async()=>{
    const controller=new AbortController();
    const fetch=vi.fn(async()=>{controller.abort();return Response.json({accent_phrases:[]});});
    await expect(createSakuraSpeechGateway({apiKey:'private-fixture',fetch}).speak('こんにちは',controller.signal)).rejects.toThrow('speech_unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects an invalid pronunciation query before synthesis',async()=>{
    const fetch=vi.fn(async()=>Response.json({accent_phrases:'invalid'}));
    await expect(createSakuraSpeechGateway({apiKey:'private-fixture',fetch}).speak('こんにちは')).rejects.toThrow('speech_unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sanitizes synthesis quota errors without retries',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({accent_phrases:[]})).mockResolvedValueOnce(new Response('private-fixture',{status:429}));
    await expect(createSakuraSpeechGateway({apiKey:'private-fixture',fetch}).speak('こんにちは')).rejects.toThrow('speech_rate_limited');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects oversized input before any external request',async()=>{
    const fetch=vi.fn();const g=createSakuraSpeechGateway({apiKey:'private-fixture',fetch});
    await expect(g.speak('あ'.repeat(241))).rejects.toThrow('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not retry or expose upstream bodies when quota is exhausted',async()=>{
    const fetch=vi.fn(async()=>new Response('private-fixture',{status:429}));
    await expect(createSakuraSpeechGateway({apiKey:'private-fixture',fetch}).speak('こんにちは')).rejects.toThrow('speech_rate_limited');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a successful HTML error body',async()=>{
    const fetch=vi.fn(async()=>new Response('<html>bad</html>'));
    await expect(createSakuraSpeechGateway({apiKey:'private-fixture',fetch}).speak('こんにちは')).rejects.toThrow('speech_unavailable');
  });
});

it('keeps the speech proxy behind owner authentication',async()=>{
 const {buildApp}=await import('../src/app.js');const speak=vi.fn(async()=>Buffer.alloc(44));
 const app=buildApp({extractor:{extract:async()=>({candidates:[]})},authVerifier:{verify:async()=>null},allowedOrigin:'https://yui.example',sakuraSpeechGateway:{speak}});
 const result=await app.inject({method:'POST',url:'/api/realtime/speech',payload:{text:'こんにちは。'}});
 expect(result.statusCode).toBe(401);expect(speak).not.toHaveBeenCalled();await app.close();
});

it.each([['speech_rate_limited',429],['speech_unavailable',502]])('returns a JSON error when synthesis fails with %s',async(message,status)=>{
 const {default:Fastify}=await import('fastify');const {registerSakuraSpeechRoutes}=await import('../src/sakura-speech.js');const app=Fastify();
 registerSakuraSpeechRoutes(app,{speak:async()=>{throw Error(String(message));}});
 const r=await app.inject({method:'POST',url:'/api/realtime/speech',payload:{text:'こんにちは。'}});
 expect(r.statusCode).toBe(status);expect(r.headers['content-type']).toContain('application/json');expect(r.json()).toEqual({error:'speech_unavailable'});await app.close();
});
