import {describe, expect, it, vi} from 'vitest';
import {BgmPlayer, DEFAULT_BGM, parseBgmSettings} from '../src/bgm/player';
const flush = async () => {for(let i=0;i<12;i++) await Promise.resolve();};
function fixture(load = vi.fn().mockResolvedValue(new ArrayBuffer(8))) {
  const gain = {gain:{cancelScheduledValues:vi.fn(),setTargetAtTime:vi.fn(),setValueAtTime:vi.fn()},connect:vi.fn()};
  const sources: Array<{start:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}> = [];
  const context = {state:'suspended', currentTime:0, destination:{}, createGain:()=>gain,
    createBufferSource:()=>{const source={start:vi.fn(),stop:vi.fn(),disconnect:vi.fn(),connect:vi.fn(),loop:false,buffer:null};sources.push(source);return source;},
    resume:vi.fn(async()=>{context.state='running';}),suspend:vi.fn(async()=>{context.state='suspended';}),close:vi.fn(async()=>{}), decodeAudioData:vi.fn(async()=>({duration:60}))};
  const notify = vi.fn(), makeContext = vi.fn(()=>context as unknown as AudioContext);
  const player = new BgmPlayer({load}, notify, makeContext);
  return {player, load, notify, context, makeContext, sources, gain};
}
describe('background music lifecycle', () => {
  it('defaults off and does not create audio or download until an enabled user gesture', async () => {
    const f=fixture();f.player.configure(DEFAULT_BGM,false);f.player.unlock();await flush();
    expect(f.makeContext).not.toHaveBeenCalled();expect(f.load).not.toHaveBeenCalled();
    f.player.configure({...DEFAULT_BGM,enabled:true},false);await flush();expect(f.load).not.toHaveBeenCalled();
    f.player.unlock();await flush();expect(f.load).toHaveBeenCalledWith('hiru',expect.any(AbortSignal));expect(f.sources[0].start).toHaveBeenCalledOnce();f.player.dispose();
  });
  it('ducks speech, pauses for microphone and resumes without downloading the track again',async()=>{
    const f=fixture(), settings={...DEFAULT_BGM,enabled:true};f.player.configure(settings,false);f.player.unlock();await flush();
    f.player.duck(true);expect(f.gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(.03,0,.08);
    f.player.duck(false);expect(f.gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(.12,0,.35);
    f.player.pause();expect(f.sources[0].stop).toHaveBeenCalledOnce();
    f.player.configure(settings,true);await flush();expect(f.sources).toHaveLength(1);
    f.player.configure(settings,false);await flush();expect(f.sources).toHaveLength(2);expect(f.load).toHaveBeenCalledOnce();f.player.dispose();
  });
  it('ignores a late download after OFF and disposes its context',async()=>{
    let resolve!:(value:ArrayBuffer)=>void;
    const f=fixture(vi.fn(()=>new Promise<ArrayBuffer>(r=>{resolve=r;})));
    f.player.configure({...DEFAULT_BGM,enabled:true},false);f.player.unlock();await flush();
    f.player.configure(DEFAULT_BGM,false);expect(f.load.mock.calls[0][1].aborted).toBe(true);
    resolve(new ArrayBuffer(8));await flush();expect(f.sources).toHaveLength(0);f.player.dispose();expect(f.context.close).toHaveBeenCalledOnce();
  });
  it('exposes unavailable files without claiming playback',async()=>{
    const f=fixture(vi.fn().mockRejectedValue(Error('音源未準備')));
    f.player.configure({...DEFAULT_BGM,enabled:true},false);f.player.unlock();await flush();
    expect(f.load).toHaveBeenCalledWith('hiru',expect.any(AbortSignal));expect(f.notify).toHaveBeenLastCalledWith('error','音源未準備');expect(f.sources).toHaveLength(0);f.player.dispose();
  });
  it('switches all catalog tracks and stops the previous loop',async()=>{
    const f=fixture();
    f.player.configure({...DEFAULT_BGM,enabled:true},false);f.player.unlock();await flush();
    f.player.configure({...DEFAULT_BGM,enabled:true,track:'kaeru'},false);await flush();
    expect(f.sources[0].stop).toHaveBeenCalledOnce();
    f.player.configure({...DEFAULT_BGM,enabled:true,track:'jitaku'},false);await flush();
    expect(f.sources[1].stop).toHaveBeenCalledOnce();
    expect(f.load.mock.calls.map(call=>call[0])).toEqual(['hiru','kaeru','jitaku']);
    expect(f.sources).toHaveLength(3);f.player.dispose();
  });
  it('validates persisted settings',()=>{
    expect(parseBgmSettings(null)).toEqual(DEFAULT_BGM);expect(parseBgmSettings({volume:Infinity,track:'foreign',enabled:'true'})).toEqual(DEFAULT_BGM);
    expect(parseBgmSettings({volume:9,track:'hiru',enabled:true})).toEqual({volume:.5,track:'hiru',enabled:true});
  });
  it('explains decoder failures in Japanese and can recover by selecting another track',async()=>{
    const f=fixture();
    f.context.decodeAudioData.mockRejectedValueOnce(new DOMException('Decoding failed','EncodingError'));
    f.player.configure({...DEFAULT_BGM,enabled:true,track:'kaeru'},false);f.player.unlock();await flush();
    expect(f.notify).toHaveBeenLastCalledWith('error','この音源を再生できませんでした。別の曲を選ぶか、もう一度お試しください。');
    expect(f.sources).toHaveLength(0);
    f.player.configure({...DEFAULT_BGM,enabled:true,track:'hiru'},false);await flush();
    expect(f.sources).toHaveLength(1);f.player.dispose();
  });
});
