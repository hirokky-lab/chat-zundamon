import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.GALLERY_VERIFY_URL??'http://127.0.0.1:4386';
const destination='output/motion-gallery-verification';
await mkdir(destination,{recursive:true});
// The intercepted fixture document otherwise trips Chrome's local-network check.
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-features=LocalNetworkAccessChecks']});
try {
 const context=await browser.newContext();
 const errors=[];
 const page=await context.newPage();
 page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
 page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
 // A test-only page mounts the real menu and gallery against the real verified SDK.
 await page.route('**/__motion-gallery-check',route=>route.fulfill({contentType:'text/html',body:`<div id="root"></div><script type="module">
 import React from '/node_modules/.vite/deps/react.js';
 import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
 const {createRoot}=ReactDOM;
 import {AppMenu} from '/src/screens/AppMenu.tsx';
 import {createZundamonModelManifest} from '/src/live2d/zundamon-model-manifest.ts';
 import '/src/styles.css';
 import {loadVerifiedAvatarRenderer} from '/src/live2d/avatar-loader.ts';
 const loadRenderer=async(canvas,manifest,signal)=>{const renderer=await loadVerifiedAvatarRenderer({canvas,manifest,signal}).catch(e=>{console.error(e.stack);throw e;});return {...renderer,setInput(input){try{return renderer.setInput(input);}catch(e){console.error(e.stack);throw e;}}};};
 const hash=await fetch('/live2d/zundamon/local-bridge.json').then(r=>r.json());
 const manifest=createZundamonModelManifest(hash.sha256);
 createRoot(document.getElementById('root')).render(React.createElement(AppMenu,{motionGallery:{manifest,loadRenderer},onClose:()=>{},onOpenSettings:()=>{},onOpenConnections:()=>{},onOpenHomeEdit:()=>{}}));
 </script>`}));
 await page.goto(base+'/__motion-gallery-check');
 for(const width of [1280,390,320]) {
  await page.setViewportSize({width,height:844});
  await page.getByRole('button',{name:'モーション見本帳',exact:true}).click();
  await page.waitForSelector('.live2d-avatar-stage[data-state="ready"]',{timeout:25000}).catch(async error=>{await page.screenshot({path:destination+'/failure.png'});console.log(await page.locator('body').innerText());throw error;});
  await page.getByRole('button',{name:/^手を振る 2/}).click();
  await page.waitForTimeout(750);
  await page.screenshot({path:`${destination}/motion-${width}.png`});
  await page.getByRole('button',{name:/^表情/}).click();
  await page.getByRole('button',{name:'にっこり',exact:true}).click();
  await page.getByRole('button',{name:/^ポーズ/}).click();
  await page.getByRole('button',{name:'両手を上げる',exact:true}).click();
  await page.getByRole('button',{name:'停止',exact:true}).click();
  await page.waitForTimeout(200);
  const geometry=await page.locator('.motion-gallery-stage').evaluate(e=>({stage:e.getBoundingClientRect().height,canvas:e.querySelector('canvas').getBoundingClientRect().height}));
  if(geometry.canvas>geometry.stage+1)throw Error('Canvas extends beyond preview '+width);
  await page.screenshot({path:`${destination}/pose-${width}.png`});
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('.motion-gallery, .motion-gallery-controls, .menu-page')].some(e=>e.scrollWidth>e.clientWidth+1));
  if(overflow)throw Error('overflow '+width);
  await page.getByRole('button',{name:'リセット',exact:true}).click();
  await page.getByRole('button',{name:/^動き/}).click();
  await page.getByRole('button',{name:/^うなずく/}).click();
  await page.getByText('停止中：うなずく',{exact:true}).waitFor({timeout:15000});
  await page.getByRole('button',{name:'メニューへ戻る',exact:true}).click();
  await page.getByRole('heading',{name:'メニュー',exact:true}).waitFor();
  console.log('UI verified',width,'play/completion/combination/reset/back/reopen');
 }
 const assetReport = await page.evaluate(async () => {
  const {createZundamonModelManifest}=await import('/src/live2d/zundamon-model-manifest.ts');
  const {MOTION_GALLERY,MOTION_GALLERY_ASSET}=await import('/src/live2d/motion-gallery-catalog.ts');
  const {loadVerifiedAvatarRenderer}=await import('/src/live2d/avatar-loader.ts');
  const {sha256}=await fetch('/live2d/zundamon/local-bridge.json').then(r=>r.json());
  const manifest=createZundamonModelManifest(sha256);
  manifest.assets=[...manifest.assets.filter(asset=>asset.path!==MOTION_GALLERY_ASSET.path),MOTION_GALLERY_ASSET];
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const renderer=await loadVerifiedAvatarRenderer({canvas,manifest,signal:new AbortController().signal});
  renderer.resize(640,640,1);
  let elapsedMs=0,requestId=0;
  const input={speechState:'silent',volume:0,idle:.5,eyeOpenLeft:1,eyeOpenRight:1,mouthOpen:0};
  const frame=(preview)=>{elapsedMs+=100;renderer.setInput({...input,elapsedMs,preview});return canvas.toDataURL();};
  const baseline=frame({requestId:requestId++,loop:false});
  const report=[];
  try {
   for(const item of MOTION_GALLERY){
    const preview={requestId:requestId++,loop:false,[item.kind==='motion'?'motion':item.kind]:item.id};
    const pictures=new Set();
    for(let i=0;i<(item.kind==='motion'?25:2);i++)pictures.add(frame(preview));
    const changed=[...pictures].some(picture=>picture!==baseline);
    if(!changed || (item.kind==='motion' && pictures.size<2))throw Error('No rendered change: '+item.id);
    report.push({id:item.id,changed,distinctFrames:pictures.size});
    const reset=frame({requestId:requestId++,loop:false});
    if(reset!==baseline)throw Error('Parameters did not reset: '+item.id);
   }
  } finally {renderer.dispose();canvas.remove();}
  return report;
 });
 await writeFile(destination+'/assets.json',JSON.stringify(assetReport,null,2));
 console.log('All official assets rendered and reset',assetReport.length);
 if(errors.length)throw Error(errors.join('\n'));
 await context.close();
} finally {await browser.close();}
