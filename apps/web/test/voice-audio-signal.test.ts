import {it,expect} from 'vitest';
import {attachVoiceAudioReader,readVoiceAudioSignal} from '../src/voice-audio-signal';
it('exposes only output state and old cleanup cannot clear a new call',()=>{
 const first=attachVoiceAudioReader(()=>({speechState:'speaking',volume:.3}));
 expect(readVoiceAudioSignal().volume).toBe(.3);
 const second=attachVoiceAudioReader(()=>({speechState:'speaking',volume:.7}));first();expect(readVoiceAudioSignal().volume).toBe(.7);
 second();expect(readVoiceAudioSignal()).toEqual({speechState:'silent',volume:0});
});
