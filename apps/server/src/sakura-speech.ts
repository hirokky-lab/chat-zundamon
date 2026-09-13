import type { FastifyInstance } from 'fastify';
import {containsForbiddenSecret} from '../../../packages/domain/src/secret.js';
import {ZUNDAMON_CHARACTER, type CharacterVoice} from '@yui/domain';

export type SakuraSpeechGateway = {speak(text:string,signal?:AbortSignal,speed?:number):Promise<Buffer>};
async function readSpeechResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 429 ? 'speech_rate_limited' : 'speech_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('speech_unavailable');
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('speech_unavailable'); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export function createSakuraSpeechGateway(options: {apiKey: string; fetch?: typeof fetch; voice?: CharacterVoice}): SakuraSpeechGateway {
  const voice = options.voice ?? ZUNDAMON_CHARACTER.voice;
  return {async speak(text, signal, speed) {
    if (!text.trim() || text.length > 240 || containsForbiddenSecret(text)) throw new Error('invalid_input');
    try {
      // One shared deadline and cancellation signal across pronunciation and synthesis.
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const headers = {Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json'};
      requestSignal.throwIfAborted();
      const queryResponse = await (options.fetch ?? fetch)(
        `https://api.ai.sakura.ad.jp/tts/v1/audio_query?text=${encodeURIComponent(text)}&speaker=${voice.speaker}`,
        {method: 'POST', redirect: 'error', headers, body: '', signal: requestSignal},
      );
      const query = JSON.parse((await readSpeechResponse(queryResponse, 256_000)).toString('utf8'));
      if (!query || typeof query !== 'object' || !Array.isArray(query.accent_phrases)) throw new Error('speech_unavailable');
      requestSignal.throwIfAborted();
      const response = await (options.fetch ?? fetch)(`https://api.ai.sakura.ad.jp/tts/v1/synthesis?speaker=${voice.speaker}`, {
        method: 'POST', redirect: 'error', headers: {...headers, Accept: 'audio/wav'},
        body: JSON.stringify({accent_phrases: query.accent_phrases, kana: '', ...voice, ...(speed === undefined ? {} : {speedScale:speed}), provider: undefined, speaker: undefined}),
        signal: requestSignal,
      });
      const audio = await readSpeechResponse(response, 4_000_000);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('speech_unavailable');
      return audio;
    } catch (error) {
      throw new Error(error instanceof Error && error.message === 'speech_rate_limited' ? 'speech_rate_limited' : 'speech_unavailable');
    }
  }};
}

export function registerSakuraSpeechRoutes(app:FastifyInstance,gateway:SakuraSpeechGateway){
  app.post('/api/realtime/speech',{bodyLimit:2048},async(request,reply)=>{
    const text=(request.body as {text?:unknown}|null)?.text;
    if(typeof text!=='string'||!text.trim()||text.length>240||containsForbiddenSecret(text))return reply.code(400).send({error:'invalid_input'});
    const controller=new AbortController();const abort=()=>{if(!reply.raw.writableEnded)controller.abort();};
    reply.raw.on('close',abort);
    try{const audio=await gateway.speak(text,controller.signal);return reply.header('Cache-Control','no-store').type('audio/wav').send(audio);}
    catch(error){return reply.code(error instanceof Error&&error.message==='speech_rate_limited'?429:502).send({error:'speech_unavailable'});}
    finally{reply.raw.off('close',abort);}
  });
}
