import {speechSegments} from './speech-segments';
import type {SpeechPlayer,SpeechPreparer} from './sakura-speech';
export type AvatarSpeechPlayer = {play: SpeechPlayer; prepare?: SpeechPreparer; resume?(): Promise<void>; close(): void};
export function createAvatarSpeech(createPlayer:()=>AvatarSpeechPlayer,onError:(error?:unknown)=>void,onRecovered?:()=>void){
 let player:AvatarSpeechPlayer|undefined;let controller:AbortController|undefined;let generation=0;
 const stop=()=>{generation++;controller?.abort();controller=undefined;};
 return {
  cancel:stop,
  enable(){try{if(!player)player=createPlayer();const current=player;void current.resume?.().catch(error=>{if(player===current)onError(error);});}catch(error){onError(error);}},
  disable(){stop();player?.close();player=undefined;},
  begin(){stop();const current=generation;return async(text:string,onStart?:(chunk:string)=>void)=>{
   if(current!==generation||!player||!text.trim())return;
   const active=new AbortController();controller=active;
   try{
    // Share natural phrase boundaries with the stage, revealing each at actual playback start.
    const chunks: string[] = [];
    for (const segment of speechSegments(text)) {
     let rest=segment;
     while(rest) {
      // A single very long token can exceed the synthesis service limit.
      let length=Math.min(rest.length,240);if(length<rest.length&&/[\uD800-\uDBFF]/.test(rest[length-1]))length--;
      chunks.push(rest.slice(0,length));rest=rest.slice(length);
     }
    }
    type Prepared = {run:()=>Promise<void>} | {error:unknown};
    let next: Promise<Prepared> | undefined;
    const started=(index:number)=>()=>{
     if(current!==generation||active.signal.aborted)return;
     onRecovered?.();
     onStart?.(chunks[index]);
     // Prepare only the next phrase while the current one is audible, to avoid a new wait.
     if(player?.prepare && index+1<chunks.length) {
      next=player.prepare(chunks[index+1],active.signal,started(index+1))
       .then(run=>({run}),error=>({error}));
     }
    };
    for(let index=0;index<chunks.length && current===generation && !active.signal.aborted;index++) {
     const ready=next;next=undefined;
     if(ready) {
      const result=await ready;
      if(current!==generation||active.signal.aborted)break;
      if('error' in result)throw result.error;
      await result.run();
     } else await player.play(chunks[index],active.signal,started(index));
    }
   }catch(error){if(current===generation&&!active.signal.aborted)onError(error);}
   finally{if(controller===active)controller=undefined;}
  };},
 };
}
