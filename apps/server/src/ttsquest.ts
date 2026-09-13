import {setTimeout as delay} from 'node:timers/promises';
import {containsForbiddenSecret} from '../../../packages/domain/src/secret.js';
import type {SakuraSpeechGateway} from './sakura-speech.js';
export function createTtsQuestGateway(fetcher:typeof fetch=fetch):SakuraSpeechGateway{
 let retryAt=0;let tail:Promise<unknown>=Promise.resolve();
 async function limited(r:Response,max:number){if(!r.ok){await r.body?.cancel();throw Error(r.status===429?'speech_rate_limited':'speech_unavailable');}const reader=r.body?.getReader();if(!reader)throw Error('speech_unavailable');const chunks:Uint8Array[]=[];let n=0;for(;;){const c=await reader.read();if(c.done)break;n+=c.value.length;if(n>max){await reader.cancel();throw Error('speech_unavailable');}chunks.push(c.value);}return Buffer.concat(chunks);}
 function audioUrl(raw:unknown,suffix:string){if(typeof raw!=='string')throw Error('speech_unavailable');const url=new URL(raw);if(url.protocol!=='https:'||!/^audio[1-9]\.tts\.quest$/.test(url.hostname)||url.port||url.username||url.password||url.search||url.hash||!new RegExp('^/v1/data/[a-f0-9]{64}/'+suffix+'$').test(url.pathname))throw Error('speech_unavailable');return url.href;}
 async function speak(text:string,signal?:AbortSignal){
  if(!text.trim()||text.length>240||containsForbiddenSecret(text))throw Error('invalid_input');signal?.throwIfAborted();
  if(Date.now()<retryAt)throw Error('speech_rate_limited');
  const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
  const response=await fetcher('https://api.tts.quest/v3/voicevox/synthesis?speaker=3',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({text}).toString(),signal:deadline,redirect:'error'});
  if(response.status===429){retryAt=Date.now()+60000;await response.body?.cancel();throw Error('speech_rate_limited');}
  const data=JSON.parse((await limited(response,16000)).toString());
  if(!data.success){if(Number.isFinite(data.retryAfter)&&data.retryAfter>0){retryAt=Date.now()+Math.min(data.retryAfter,86400)*1000;throw Error('speech_rate_limited');}throw Error('speech_unavailable');}
  const statusUrl=audioUrl(data.audioStatusUrl,'status\\.json'),wavUrl=audioUrl(data.wavDownloadUrl,'audio\\.wav');
  for(;;){const status=JSON.parse((await limited(await fetcher(statusUrl,{signal:deadline,redirect:'error'}),8000)).toString());if(status.isAudioError)throw Error('speech_unavailable');if(status.isAudioReady)break;await delay(700,undefined,{signal:deadline});}
  const wav=await limited(await fetcher(wavUrl,{signal:deadline,redirect:'error'}),4_000_000);if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('speech_unavailable');return wav;
 }
 return {speak(text,signal){const result=tail.then(()=>speak(text,signal));tail=result.catch(()=>undefined);return result;}};
}
