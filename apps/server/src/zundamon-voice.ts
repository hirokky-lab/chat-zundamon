import type {FastifyInstance} from 'fastify';
import {ZUNDAMON_CHARACTER} from '@yui/domain';
import type {SakuraSpeechGateway} from './sakura-speech.js';
import {containsForbiddenSecret} from '../../../packages/domain/src/secret.js';
/** Only the local engine is accepted; never proxy a browser-supplied host. */
export function createZundamonVoice(fetcher:typeof fetch=fetch){
 const base='http://127.0.0.1:50021';
 async function status(signal?:AbortSignal){try{const r=await fetcher(base+'/speakers',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000),redirect:'error'});if(!r.ok)throw Error();const speakers=await r.json() as Array<{name:string;styles:Array<{id:number}>}>;return speakers.some(s=>s.name==='ずんだもん'&&s.styles.some(v=>v.id===3));}catch{return false;}}
 const gateway:SakuraSpeechGateway={async speak(text,signal){
  if(!text.trim()||text.length>240||containsForbiddenSecret(text))throw Error('invalid_input');
  const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
  if(!await status(deadline))throw Error('voice_unavailable');
  const query=await fetcher(base+'/audio_query?'+new URLSearchParams({text,speaker:'3'}),{method:'POST',signal:deadline,redirect:'error'});if(!query.ok)throw Error('voice_unavailable');
  const settings=await query.json();
  const audio=await fetcher(base+'/synthesis?speaker=3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...settings,...ZUNDAMON_CHARACTER.voice,provider:undefined,speaker:undefined}),signal:deadline,redirect:'error'});if(!audio.ok)throw Error('voice_unavailable');
  const reader=audio.body?.getReader();if(!reader)throw Error('voice_unavailable');const parts:Uint8Array[]=[];let size=0;for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>4_000_000){await reader.cancel();throw Error('voice_unavailable');}parts.push(chunk.value);}
  const wav=Buffer.concat(parts);if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw Error('voice_unavailable');return wav;
 }};
 return {gateway,status};
}
export function registerVoiceStatus(app:FastifyInstance,status:()=>Promise<boolean>){app.get('/api/voice-connection',async(_request,reply)=>reply.header('Cache-Control','no-store').send({available:await status(),provider:'VOICEVOX',voice:'ずんだもん'}));}
