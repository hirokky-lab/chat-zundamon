import {acquirePlaybackAudioSession} from './playback-audio-session';
export const SPEECH_LIMIT_MESSAGE = "ずんだもんの音声は利用制限中です。文字での会話は続けられます。";
export class SpeechLimitError extends Error { constructor(){super(SPEECH_LIMIT_MESSAGE);this.name="SpeechLimitError";} }
export type SpeechFailureKind = "request" | "decode" | "playback";
const SPEECH_FAILURE_MESSAGES: Record<SpeechFailureKind, string> = {
 request: "音声を取得できませんでした。接続を確認して、もう一度お試しください。",
 decode: "取得した音声を読み込めませんでした。もう一度お試しください。",
 playback: "端末で音声を開始できませんでした。上の音声ボタンをOFF→ONにして再試行できます。",
};
export class SpeechPlaybackError extends Error {
 constructor(readonly kind: SpeechFailureKind) { super(SPEECH_FAILURE_MESSAGES[kind]); this.name="SpeechPlaybackError"; }
}
export function speechFailureMessage(error: unknown): string {
 return error instanceof SpeechLimitError || error instanceof SpeechPlaybackError
  ? error.message : "音声を再生できませんでした。もう一度お試しください。";
}
import {attachVoiceAudioReader} from "./voice-audio-signal";
export type SpeechPlayer=(text:string,signal:AbortSignal,onStart?:()=>void)=>Promise<void>;
export type SpeechPreparer=(text:string,signal:AbortSignal,onStart?:()=>void)=>Promise<()=>Promise<void>>;
export function createSpeechQueue(play:SpeechPlayer,prepare?:SpeechPreparer){
 const controller=new AbortController();let pending='';let chunks=0;let busy=false;let failure:unknown;let drain=Promise.resolve();
 const entries:Array<{text:string;ready?:Promise<()=>Promise<void>>}>=[];
 const prime=()=>{if(!prepare||controller.signal.aborted)return;for(const entry of entries.slice(0,2)){if(!entry.ready){entry.ready=prepare(entry.text,controller.signal);void entry.ready.catch(()=>undefined);}}};
 const run=()=>{
  prime();if(busy)return;busy=true;
  drain=(async()=>{try{while(entries.length&&!controller.signal.aborted){prime();const entry=entries[0];if(entry.ready){const ready=await entry.ready;if(!controller.signal.aborted)await ready();}else await play(entry.text,controller.signal);entries.shift();}}catch(error){if(!controller.signal.aborted){failure=error;controller.abort();}}finally{busy=false;if(controller.signal.aborted)entries.length=0;}})();
 };
 const enqueue=(text:string)=>{if(!text.trim()||controller.signal.aborted)return;if(++chunks>30){failure=new Error('speech_limit');controller.abort();return;}entries.push({text});run();};
 const flush=(all=false)=>{while(pending){const boundary=pending.search(/[。！？!?\n]/u);const limit=chunks===0?60:120;const n=boundary>=0?Math.min(boundary+1,limit):pending.length>=limit?limit:all?pending.length:0;if(!n)break;enqueue(pending.slice(0,n));pending=pending.slice(n);}};
 return {push(text:string){if(controller.signal.aborted)return;pending+=text;flush();},async finish(){flush(true);await drain;if(failure)throw failure;},cancel(){controller.abort();pending='';}};
}

export function createBrowserSpeechPlayer(fetchImpl:typeof fetch, options: { playbackOnly?: boolean } = {}){
 // iOS defaults Web Audio to an ambient session. Use media output for TTS;
 // leave the simultaneous microphone/live-call session unchanged.
 let audioSession: ReturnType<typeof acquirePlaybackAudioSession> | undefined;
 const configurePlayback = () => { if(options.playbackOnly) { audioSession ??= acquirePlaybackAudioSession(); audioSession.refresh(); } };
 configurePlayback();
 // Created/resumed synchronously from the user's call-start gesture for iOS.
 const context=new AudioContext();void context.resume().catch(()=>undefined);
 const analyser=context.createAnalyser();analyser.fftSize=256;analyser.connect(context.destination);
 const samples=new Float32Array(analyser.fftSize);let speaking=false;
 const detach=attachVoiceAudioReader(()=>{if(!speaking)return {speechState:"silent",volume:0};analyser.getFloatTimeDomainData(samples);const rms=Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length);return {speechState:"speaking",volume:Math.min(1,rms*5)};});
 const prepare = async(text:string,signal:AbortSignal,onStart?:()=>void)=>{
  if(signal.aborted)return async()=>{};
  let response:Response;
  try { response=await fetchImpl('/api/realtime/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),signal}); }
  catch(error) {if(signal.aborted)throw error;throw new SpeechPlaybackError('request');}
  if(response.status===429)throw new SpeechLimitError();
  if(!response.ok)throw new SpeechPlaybackError('request');
  let buffer:AudioBuffer;
  try { const data=await response.arrayBuffer();if(signal.aborted)return async()=>{};buffer=await context.decodeAudioData(data); }
  catch(error) {if(signal.aborted)throw error;throw new SpeechPlaybackError('decode');}
  if(signal.aborted)return async()=>{};
  return async()=>{if(signal.aborted)return;await new Promise<void>((resolve,reject)=>{
   const source=context.createBufferSource();source.buffer=buffer;source.connect(analyser);
   let finished=false;
   const settle=(error?:SpeechPlaybackError)=>{if(finished)return;finished=true;speaking=false;signal.removeEventListener('abort',abort);source.onended=null;source.disconnect();if(error)reject(error);else resolve();};
   const finish=()=>settle();
   const abort=()=>{try{source.stop();}catch{}finish();};
   source.onended=finish;signal.addEventListener('abort',abort,{once:true});
   if(signal.aborted)abort();else if(context.state!=='running')settle(new SpeechPlaybackError('playback'));
   else {try{source.start();speaking=true;}catch{settle(new SpeechPlaybackError('playback'));return;}onStart?.();}
  });};
 };
 const play:SpeechPlayer=async(text,signal,onStart)=>{await (await prepare(text,signal,onStart))();};
 return {play,prepare,resume:async()=>{configurePlayback();try{await context.resume();}catch{throw new SpeechPlaybackError('playback');}},close:()=>{
 audioSession?.release();audioSession=undefined;
 speaking=false;detach();analyser.disconnect();void context.close().catch(()=>undefined);}};
}
