import {test,expect} from 'playwright/test';
test.use({serviceWorkers:'block'});
test('browser decodes WAV, completes playback, then interrupts and releases audio',async({page})=>{
 const wav=Buffer.alloc(44+19200);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(19200,40);for(let i=0;i<9600;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/24000)*2000),44+i*2);
 await page.route('**/api/**',r=>r.request().url().endsWith('/realtime/speech')?r.fulfill({contentType:'audio/wav',body:wav}):r.fulfill({status:401,contentType:'application/json',body:'{}'}));
 await page.goto('/');
 await page.evaluate(async()=>{
  // Browser test only: exercise the production player without a real microphone.
  const modulePath='/src/sakura-speech.ts';const {createBrowserSpeechPlayer}=await import(modulePath);
  const signalPath='/src/voice-audio-signal.ts';const {readVoiceAudioSignal}=await import(signalPath);
  const button=document.createElement('button');button.textContent='fixture voice';document.body.append(button);
  button.onclick=async()=>{const player=createBrowserSpeechPlayer(fetch);try{const c=new AbortController();const playback=player.play('テスト。',c.signal);let observed=false;const timer=setInterval(()=>{if(readVoiceAudioSignal().volume>0)observed=true;},10);await playback;clearInterval(timer);if(!observed)throw new Error('no output amplitude');c.abort();await player.play('取消済み。',c.signal);button.textContent='playback passed';}catch(error){button.textContent='playback failed: '+String(error);}finally{player.close();if(readVoiceAudioSignal().volume!==0)button.textContent='cleanup failed';}};
 });
 await page.getByRole('button',{name:'fixture voice'}).click();
 await expect(page.getByRole('button',{name:'playback passed'})).toBeVisible();
});
