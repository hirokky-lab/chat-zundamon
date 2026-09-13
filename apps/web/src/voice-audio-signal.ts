import type {AvatarAudioSignal} from './live2d/avatar-contract';
const silent:AvatarAudioSignal={speechState:'silent',volume:0};
let reader:(()=>AvatarAudioSignal)|undefined;
export function readVoiceAudioSignal():AvatarAudioSignal{return reader?.()??silent;}
export function attachVoiceAudioReader(next:()=>AvatarAudioSignal){reader=next;return ()=>{if(reader===next)reader=undefined;};}
