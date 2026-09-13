import {act, renderHook, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {useBgm} from '../src/bgm/use-bgm';
import {BgmPlayer, DEFAULT_BGM} from '../src/bgm/player';

beforeEach(() => { const data = new Map<string,string>(); vi.stubGlobal('localStorage', {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)}); });
afterEach(() => {vi.unstubAllGlobals(); Reflect.deleteProperty(navigator,'audioSession');});
function audioFixture() {
  const session = {type:'auto'};
  Object.defineProperty(navigator, 'audioSession', {configurable:true,value:session});
  let activated = false;
  const context = {state:'suspended',currentTime:0,destination:{},
    createGain:()=>({connect(){},gain:{cancelScheduledValues(){},setTargetAtTime(){},setValueAtTime(){}}}),
    createBufferSource:()=>({connect(){},start(){},stop(){},disconnect(){}}),
    decodeAudioData:async()=>({duration:60}),
    resume:async()=>{if(activated) context.state='running';},
    suspend:async()=>{context.state='suspended';},close:async()=>{},
  };
  return {session, context, activate:()=>{activated=true;}};
}
it('requires an explicit BGM action; unrelated touch and click never start saved music', async()=>{
  const f=audioFixture();
  vi.stubGlobal('AudioContext', function(){return f.context;});
  localStorage.setItem('zundamon:bgm:mobile',JSON.stringify({...DEFAULT_BGM,enabled:true}));
  const api={load:async()=>new ArrayBuffer(8)};
  const {result,unmount}=renderHook(()=>useBgm(api,'mobile',false));
  await waitFor(()=>expect(result.current.status).toBe('waiting'));
  act(()=>{f.activate();document.dispatchEvent(new Event('touchend'));});
  await act(async()=>{document.dispatchEvent(new Event('click'));await new Promise(r=>setTimeout(r,10));});
  expect(result.current.status).toBe('waiting');
  act(()=>result.current.update({volume:.2,track:'kaeru'}));
  expect(result.current.status).toBe('waiting');
  act(()=>result.current.retry());
  await waitFor(()=>expect(result.current.status).toBe('playing'));
  unmount();
});
it('uses media playback routing and releases it when paused for microphone input', async()=>{
  const f=audioFixture();f.activate();
  const player=new BgmPlayer({load:async()=>new ArrayBuffer(8)},()=>{},()=>f.context as unknown as AudioContext);
  player.configure({...DEFAULT_BGM,enabled:true},false);player.unlock();
  expect(f.session.type).toBe('playback');
  player.pause();expect(f.session.type).toBe('auto');player.dispose();
});
it('keeps playback routing while another audio player still needs it',()=>{
 const f=audioFixture();f.activate();
 const create=()=>new BgmPlayer({load:async()=>new ArrayBuffer(8)},()=>{},()=>f.context as unknown as AudioContext);
 const first=create(),second=create();
 for(const player of [first,second]){player.configure({...DEFAULT_BGM,enabled:true},false);player.unlock();}
 first.dispose();expect(f.session.type).toBe('playback');
 second.dispose();expect(f.session.type).toBe('auto');
});
