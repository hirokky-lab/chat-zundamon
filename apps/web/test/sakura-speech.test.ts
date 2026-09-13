import {it,expect,vi} from 'vitest';
import {createSpeechQueue} from '../src/sakura-speech';
it('rejects suspended playback instead of silently reporting success, and releases the source',async()=>{
 const {createBrowserSpeechPlayer}=await import('../src/sakura-speech');
 const disconnect=vi.fn(),start=vi.fn();
 vi.stubGlobal('AudioContext',class{state='suspended';destination={};resume=async()=>{};close=async()=>{};decodeAudioData=async()=>({});createAnalyser(){return {fftSize:256,connect(){},disconnect(){}};}createBufferSource(){return {connect(){},disconnect,start,stop(){},onended:null};}});
 try {
  const player=createBrowserSpeechPlayer(vi.fn(async()=>new Response(new Uint8Array([1]))));
  const onStart=vi.fn();await expect(player.play('こんにちは',new AbortController().signal,onStart)).rejects.toThrow('音声');
  expect(start).not.toHaveBeenCalled();expect(onStart).not.toHaveBeenCalled();expect(disconnect).toHaveBeenCalledTimes(1);player.close();
 }finally{vi.unstubAllGlobals();}
});
it('starts at sentence boundary and preserves playback order',async()=>{
 const spoken:string[]=[];const q=createSpeechQueue(async text=>{spoken.push(text);});
 q.push('こんにちは');await Promise.resolve();expect(spoken).toEqual([]);
 q.push('。元気？');await q.finish();expect(spoken).toEqual(['こんにちは。','元気？']);
});
it('aborts in-flight playback and drops pending text on interruption',async()=>{
 const spoken:string[]=[];let signal:AbortSignal|undefined;
 const q=createSpeechQueue(async(text,s)=>{spoken.push(text);signal=s;await new Promise<void>(r=>s.addEventListener('abort',()=>r()));});
 q.push('最初。次。');await Promise.resolve();q.cancel();await q.finish();
 expect(signal?.aborted).toBe(true);expect(spoken).toEqual(['最初。']);
});
it('propagates failure without retrying subsequent chunks',async()=>{
 const play=vi.fn(async()=>{throw new Error('unavailable')});const q=createSpeechQueue(play);
 q.push('最初。次。');await expect(q.finish()).rejects.toThrow('unavailable');expect(play).toHaveBeenCalledTimes(1);
});

it('prepares at most one sentence ahead while current audio plays',async()=>{
 const started:string[]=[];const played:string[]=[];let release!:()=>void;
 const prepare=async(text:string)=>{started.push(text);return async()=>{played.push(text);if(text==='一。')await new Promise<void>(r=>release=r);};};
 const q=createSpeechQueue(async()=>{},prepare);q.push('一。二。三。');
 await new Promise(r=>setTimeout(r,0));expect(started).toEqual(['一。','二。']);expect(played).toEqual(['一。']);
 release();await q.finish();expect(played).toEqual(['一。','二。','三。']);
});
it('cancels prefetched audio without playing it',async()=>{
 let release!:()=>void;const played:string[]=[];
 const q=createSpeechQueue(async()=>{},async text=>async()=>{played.push(text);await new Promise<void>(r=>release=r);});
 q.push('一。二。');await new Promise(r=>setTimeout(r,0));q.cancel();release();await q.finish();expect(played).toEqual(['一。']);
});
it('overlaps synthesis with playback in a controlled latency comparison',async()=>{
 vi.useFakeTimers();try{
  const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
  const measure=async(prefetch:boolean)=>{const start=Date.now();const play=async()=>{await delay(100);await delay(200);};const prepare=async()=>{await delay(100);return ()=>delay(200);};const q=createSpeechQueue(play,prefetch?prepare:undefined);q.push('一。二。三。');const done=q.finish();await vi.runAllTimersAsync();await done;return Date.now()-start;};
  expect(await measure(false)).toBe(900);expect(await measure(true)).toBe(700);
 }finally{vi.useRealTimers();}
});

it('reports service limits without decoding audio or retrying the request',async()=>{
 const {createBrowserSpeechPlayer}=await import('../src/sakura-speech');
 vi.stubGlobal('AudioContext',class{destination={};resume=async()=>{};close=async()=>{};createAnalyser(){return {fftSize:256,connect(){},disconnect(){}};}});
 try{const fetch=vi.fn(async()=>new Response('{}',{status:429}));const player=createBrowserSpeechPlayer(fetch);
 await expect(player.play('こんにちは',new AbortController().signal)).rejects.toThrow('利用制限');expect(fetch).toHaveBeenCalledTimes(1);player.close();}finally{vi.unstubAllGlobals();}
});

it('uses a media session for TTS and restores it on close without changing live calls',async()=>{
 const {createBrowserSpeechPlayer}=await import('../src/sakura-speech');
 const session={type:'auto'};
 vi.stubGlobal('navigator',{audioSession:session});
 vi.stubGlobal('AudioContext',class{destination={};resume=async()=>{};close=async()=>{};createAnalyser(){return {fftSize:256,connect(){},disconnect(){}};}});
 try {
  const call=createBrowserSpeechPlayer(vi.fn());expect(session.type).toBe('auto');call.close();
  const speech=createBrowserSpeechPlayer(vi.fn(),{playbackOnly:true});expect(session.type).toBe('playback');
  session.type='auto';await speech.resume();expect(session.type).toBe('playback');
  speech.close();expect(session.type).toBe('auto');
 } finally {vi.unstubAllGlobals();}
});
