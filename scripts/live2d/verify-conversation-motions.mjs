import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
const base = process.env.GALLERY_VERIFY_URL ?? 'http://127.0.0.1:4386';
const destination = 'output/conversation-motion-verification';
await mkdir(destination, {recursive:true});
const browser = await chromium.launch({channel:'chrome', headless:true});
try {
  const page = await browser.newPage({viewport:{width:800,height:800}});
  await page.goto(base);
  const report = await page.evaluate(async () => {
    const {createZundamonModelManifest} = await import('/src/live2d/zundamon-model-manifest.ts');
    const {CONVERSATION_MOTIONS} = await import('/src/live2d/conversation-motion.ts');
    const {loadVerifiedAvatarRenderer} = await import('/src/live2d/avatar-loader.ts');
    const {sha256} = await fetch('/live2d/zundamon/local-bridge.json').then(r=>r.json());
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const renderer = await loadVerifiedAvatarRenderer({canvas,manifest:createZundamonModelManifest(sha256),signal:new AbortController().signal});
    renderer.resize(512,640,1);
    let time = 0, key = 0;
    const frame = (expression, speechState='silent', mouthOpen=0) => {
      time += 100;
      renderer.setInput({elapsedMs:time,expression,expressionKey:String(key),idle:.5,eyeOpenLeft:1,eyeOpenRight:1,mouthOpen,speechState,volume:mouthOpen});
      return canvas.toDataURL();
    };
    const rows = [];
    try {
      frame('neutral');
      for(const [expression, ids] of Object.entries(CONVERSATION_MOTIONS)) {
        for(const id of ids) {
          key++;
          const pictures = new Set();
          let sample;
          for(let i=0;i<85;i++) {
            const picture = frame(expression);
            if(i<40) pictures.add(picture);
            if(i===14) sample=picture;
          }
          if(pictures.size<5) throw Error('No animated frames: '+id);
          key++;for(let i=0;i<60;i++)frame('neutral');
          rows.push({id,expression,distinctFrames:pictures.size,sample});
        }
      }
      key++;frame('shy','speaking',0);
      const closed=frame('shy','speaking',0), open=frame('shy','speaking',.9);
      if(closed===open)throw Error('No speech mouth change');
      return rows;
    } finally {renderer.dispose();canvas.remove();}
  });
  for(const {id,sample} of report) await writeFile(`${destination}/${id}.png`,Buffer.from(sample.split(',')[1],'base64'));
  await writeFile(`${destination}/report.json`,JSON.stringify(report.map(({sample,...row})=>row),null,2));
  console.log('Rendered conversation cues through the real SDK',report.map(r=>r.id));
} finally {await browser.close();}
