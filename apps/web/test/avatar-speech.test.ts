import {it,expect,vi} from 'vitest';
import {createAvatarSpeech} from '../src/avatar-speech';
it('clears a previous failure only when current audio actually starts',async()=>{
 const recovered=vi.fn(),onError=vi.fn();let start:(()=>void)|undefined;
 const play=vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async(_t,_s,onStart)=>{start=onStart;});
 const speech=createAvatarSpeech(()=>({play,close(){}}),onError,recovered);
 speech.enable();await speech.begin()('最初');expect(onError).toHaveBeenCalledTimes(1);
 speech.enable();await speech.begin()('次');expect(recovered).not.toHaveBeenCalled();
 start?.();expect(recovered).toHaveBeenCalledTimes(1);
 speech.cancel();start?.();expect(recovered).toHaveBeenCalledTimes(1);
});
it('reads only the current reply, cancelling stale replies on exit and new sends',async()=>{
 const play=vi.fn(async()=>{});const close=vi.fn();const speech=createAvatarSpeech(()=>({play,close}),()=>{});
 speech.enable();const old=speech.begin();const current=speech.begin();await old('古い返信。');expect(play).not.toHaveBeenCalled();await current('こんにちは。');expect(play).toHaveBeenCalledTimes(1);
 const pending=speech.begin();speech.disable();await pending('終了後の返信。');expect(play).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
});
it('cancels ongoing output and handles unavailable audio without breaking chat',async()=>{
 const error=vi.fn();const speech=createAvatarSpeech(()=>{throw Error('unavailable');},error);
 speech.enable();await speech.begin()('こんにちは');expect(error).toHaveBeenCalled();
});
it('sends a short multi-sentence reply as one synthesis request',async()=>{
 const play=vi.fn(async()=>{}),prepare=vi.fn();const speech=createAvatarSpeech(()=>({play,prepare,close(){}}),()=>{});speech.enable();
 const text='こんにちは。今日はいい天気なのだ！どこに出かけるのだ？';await speech.begin()(text);expect(play).toHaveBeenCalledTimes(1);expect(play.mock.calls[0][0]).toBe(text);expect(prepare).not.toHaveBeenCalled();
});
it('uses bounded segments, preserves all text and does not prefetch',async()=>{
 const chunks:string[]=[];let release!:()=>void;const play=vi.fn(async(text:string)=>{chunks.push(text);if(chunks.length===1)await new Promise<void>(r=>{release=r;});});const speech=createAvatarSpeech(()=>({play,close(){}}),()=>{});speech.enable();const text='あ'.repeat(239)+'😀。'+'い'.repeat(50);const done=speech.begin()(text);expect(play).toHaveBeenCalledTimes(1);release();await done;expect(chunks.join('')).toBe(text);expect(chunks.every(s=>s.length<=240)).toBe(true);expect(chunks.some(chunk=>chunk.includes('😀'))).toBe(true);
 expect(chunks.every(chunk=>!/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
});
it('stops the remaining chunks after a rate limit instead of continuing requests',async()=>{
 const error=vi.fn(),play=vi.fn(async()=>{throw Error('limit');});const speech=createAvatarSpeech(()=>({play,close(){}}),error);speech.enable();await speech.begin()('あ'.repeat(500));expect(play).toHaveBeenCalledTimes(1);expect(error).toHaveBeenCalledTimes(1);
});

it('resumes an existing player on every send gesture after a mobile suspension',()=>{
 const resume=vi.fn(async()=>{}),create=vi.fn(()=>({play:vi.fn(async()=>{}),resume,close(){}}));
 const speech=createAvatarSpeech(create,vi.fn());speech.enable();speech.enable();
 expect(create).toHaveBeenCalledTimes(1);expect(resume).toHaveBeenCalledTimes(2);
});

it('reveals dialogue from the playback-start callback, not before synthesis is ready',async()=>{
 let start:(()=>void)|undefined;let finish!:()=>void;
 const speech=createAvatarSpeech(()=>({play:async(_text,_signal,onStart)=>{start=onStart;await new Promise<void>(resolve=>{finish=resolve;});},close(){}}),vi.fn());
 const reveal=vi.fn();speech.enable();const done=speech.begin()('返事',reveal);
 expect(reveal).not.toHaveBeenCalled();start?.();expect(reveal).toHaveBeenCalledTimes(1);finish();await done;
});

it('reveals each segment only when that audio starts and ignores cancelled callbacks',async()=>{
 const starts:Array<()=>void>=[];const finishes:Array<()=>void>=[];
 const speech=createAvatarSpeech(()=>({play:async(_text,_signal,onStart)=>{
  starts.push(()=>onStart?.());await new Promise<void>(resolve=>finishes.push(resolve));
 },close(){}}),vi.fn());
 speech.enable();const reveal=vi.fn();const done=speech.begin()('ひとつめ。\nふたつめ。',reveal);
 expect(reveal).not.toHaveBeenCalled();starts[0]();expect(reveal).toHaveBeenLastCalledWith('ひとつめ。');
 finishes[0]();await Promise.resolve();await Promise.resolve();
 expect(starts).toHaveLength(2);expect(reveal).toHaveBeenCalledTimes(1);
 starts[1]();expect(reveal).toHaveBeenLastCalledWith('ふたつめ。');
 speech.cancel();starts[1]();expect(reveal).toHaveBeenCalledTimes(2);finishes[1]();await done;
});

it('prepares only one following segment after playback starts, then reveals it when played',async()=>{
 let firstStart!:()=>void;let finishFirst!:()=>void;
 const prepare=vi.fn(async(_text:string,_signal:AbortSignal,onStart?:()=>void)=>async()=>{onStart?.();});
 const play=vi.fn(async(_text:string,_signal:AbortSignal,onStart?:()=>void)=>{
  firstStart=()=>onStart?.();await new Promise<void>(resolve=>{finishFirst=resolve;});
 });
 const speech=createAvatarSpeech(()=>({play,prepare,close(){}}),vi.fn());speech.enable();const reveal=vi.fn();
 const done=speech.begin()('ひとつめ。\nふたつめ。\nみっつめ。',reveal);
 expect(prepare).not.toHaveBeenCalled();firstStart();expect(prepare).toHaveBeenCalledTimes(1);
 expect(reveal.mock.calls.map(args=>args[0])).toEqual(['ひとつめ。']);
 finishFirst();await done;
 expect(reveal.mock.calls.map(args=>args[0])).toEqual(['ひとつめ。','ふたつめ。','みっつめ。']);
 expect(prepare).toHaveBeenCalledTimes(2);expect(play).toHaveBeenCalledTimes(1);
});
