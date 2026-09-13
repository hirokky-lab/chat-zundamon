import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/__stack-check',route=>route.fulfill({contentType:'text/html',body:`<div id="root"></div><script type="module">
 import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
 import {Chat} from '/src/screens/Chat.tsx';import {initialChatState} from '/src/chat-controller.ts';import '/src/styles.css';import '/src/zundamon.css';import '/src/desktop-conversation.css';
 const root=ReactDOM.createRoot(document.getElementById('root'));
 const avatar=React.createElement('div',{className:'talk-avatar'},React.createElement('figure',{className:'live2d-avatar-stage'},React.createElement('img',{className:'live2d-avatar-fallback',src:'/live2d/zundamon/poster.png'})));
 window.show=(text,thinking=false)=>root.render(React.createElement(Chat,{avatarMode:true,avatar,spokenStageText:text,waitingForSpeech:thinking,state:initialChatState,hydrating:false,persistenceWarning:false,onSend:()=>{},onRetry:()=>{},onOpenSettings:()=>{},delayedGreetingReplyGroupId:null,onGreetingRevealed:()=>{},suppressComposerAutofocus:true}));window.show('',true);
 </script>`}));
 await page.goto('http://127.0.0.1:4386/__stack-check');
 await page.waitForFunction(()=>typeof window.show==='function');
 const parts=['おはようなのだ。今日は窓を開けて、気持ちよく一日を始めよう。','朝ごはんを食べたら、少し外を歩いてみるのもいいのだ。慌てずゆっくりで大丈夫だよ。','近くの公園で、季節の花を探してみるのも楽しそうなのだ。','帰ったら温かいお茶を飲んで、のんびり過ごそうね。'];
 for(const width of [320,390,768,892,959,960,1280,1920]){
 await page.setViewportSize({width,height:844});await page.evaluate(()=>window.show('',true));
 for(let n=1;n<=4;n++){
 await page.evaluate(text=>window.show(text),parts.slice(0,n).join('\n\n'));
 await page.waitForTimeout(380);
 const g=await page.evaluate(()=>{
 const pane=document.querySelector('.stage-speech-viewport');const r=pane.getBoundingClientRect();
 const bubbles=[...document.querySelectorAll('.stage-speech-bubble')];
 const shown=bubbles.filter(e=>{const b=e.getBoundingClientRect();return b.bottom>r.top+1&&b.top<r.bottom-1;});
 return {count:shown.length,total:bubbles.length,bottom:pane.scrollHeight-pane.scrollTop-pane.clientHeight,overlap:r.bottom>document.querySelector('.chat-composer').getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth};
 });
 if(g.count!==Math.min(n,2)||g.total!==n||g.bottom>1||g.overlap||g.overflow)throw Error(JSON.stringify({width,n,...g}));
 }
 const pane=page.locator('.stage-speech-viewport');
 await pane.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll',{bubbles:true}));});
 await page.evaluate(text=>window.show(text),parts.concat('続きも、ゆっくり考えていいのだ。').join('\n\n'));
 await page.waitForTimeout(380);
 if(await pane.evaluate(e=>e.scrollTop)!==0)throw Error('Reading position lost '+width);
 const layout=await page.evaluate(()=>{
 const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,bottom:r.bottom};};
 return {header:rect('.header-trailing-actions'),dialogue:rect('.desktop-stage-dialogue'),composer:rect('.chat-composer'),bubble:rect('.stage-speech-bubble p'),input:rect('.composer-shell'),shell:getComputedStyle(document.querySelector('.composer-shell')).backgroundColor,avatar:getComputedStyle(document.querySelector('.live2d-avatar-fallback')).transform};
 });
 for(const element of [layout.header,layout.dialogue,layout.composer])if(Math.abs(element.x+element.width/2-width/2)>1)throw Error('Off center '+width+JSON.stringify(layout));
 if(Math.abs(layout.bubble.x-layout.input.x)>1||Math.abs(layout.bubble.width-layout.input.width)>1)throw Error('Bubble and input edges differ');
 if(Math.abs(layout.dialogue.width-Math.min(924,width-36))>1||Math.abs(layout.dialogue.width-layout.composer.width)>1||Math.abs(layout.composer.bottom-(844-24))>1||layout.shell!=='rgba(255, 255, 255, 0.66)'||layout.avatar!=='matrix(1.2, 0, 0, 1.2, 64, 0)')throw Error('Layout mismatch '+width+JSON.stringify(layout));
 await page.screenshot({path:'/tmp/unified-stage-'+width+'.png'});
 await pane.evaluate(e=>{e.scrollTop=e.scrollHeight;e.dispatchEvent(new Event('scroll',{bubbles:true}));});
 await page.evaluate(text=>window.show(text),parts.concat('続きも、ゆっくり考えていいのだ。','また一緒に話そうね。').join('\n\n'));
 await page.waitForTimeout(380);
 if(await pane.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)>1)throw Error('Did not resume following '+width);
 await page.evaluate(()=>window.show('',true));
 if(await pane.count())throw Error('Old speech remains during new request');
 await page.evaluate(()=>window.show('次の返答なのだ。'));await page.waitForTimeout(380);
 if(await page.locator('.stage-speech-bubble').count()!==1)throw Error('Old turn leaked');
 console.log('Verified two-bubble viewport, review/append, resume, new turn',width);
 }
 await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>window.show('新しい返答なのだ。'));
 await page.waitForTimeout(50);if(await page.evaluate(()=>document.getAnimations().length))throw Error('motion during reduced motion');
 if(errors.length)throw Error(errors.join('\n'));
}finally{await browser.close();}
