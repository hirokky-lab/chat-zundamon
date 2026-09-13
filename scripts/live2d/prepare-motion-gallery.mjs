import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** Run after the official archive checks in prepare-zundamon.mjs. */
export async function prepareMotionGallery(root, runtime, output) {
  const model = JSON.parse(await readFile(resolve(runtime, 'zundamon.model3.json'), 'utf8'));
  const groups = { angry:'怒る', laugh:'笑う', no:'首を振る', point:'指して説明する', think:'考える', tremble:'震える', wave:'手を振る', yes:'うなずく', sad:'悲しむ', shy:'照れる', surprise:'驚く', talk:'話す', smile:'にっこり', sleep:'眠そう' };
  const poses = { Jaw:'あごに手を添える', Middle:'両手を広げる', Middle2:'片手を広げる', Middle3:'片手を広げて腰に手', Upper:'両手を上げる', Upper2:'片手を上げる', Upper3:'片手を上げて腰に手', Waist:'両手を腰に', Waist2:'片手を腰に', chop:'チョップ', cross:'腕を組む', mouth:'両手を口元に', mouth2:'片手を口元に' };
  const pack = { motions:{}, expressions:{} }, entries=[];
  for (const item of Object.values(model.FileReferences.Motions).flat()) {
    const id=item.File.split('/').pop().replace('.motion3.json','');
    const data=JSON.parse(await readFile(resolve(runtime,item.File),'utf8'));
    pack.motions[id]=data;
    const [,part,word,variant] = id.match(/^mtn(Body|Face)_([a-z]+)(\d*)$/);
    entries.push({id,kind:'motion',label:`${part==='Face'?'顔：':''}${groups[word] ?? word}${variant ? ` ${variant}` : ''}`,duration:data.Meta.Duration});
  }
  for (const {Name:id,File:file} of model.FileReferences.Expressions) {
    pack.expressions[id]=JSON.parse(await readFile(resolve(runtime,file),'utf8'));
    const pose=id.startsWith('pose_');
    const name=id.replace(/^(pose|exp)_/,'');
    const [,word,variant] = name.match(/^([a-z]*)(\d*)$/i);
    entries.push({id,kind:pose?'pose':'expression',label:pose?poses[name]:groups[word]?`${groups[word]}${variant?` ${variant}`:''}`:`表情セット ${Number(variant)}`});
  }
  const bytes=Buffer.from(JSON.stringify(pack));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(output,'zundamon/motion-gallery.json'),bytes);
  const descriptor={path:'motion-gallery.json',url:'/live2d/zundamon/motion-gallery.json',sha256,maxBytes:bytes.length};
  await writeFile(resolve(root,'apps/web/src/live2d/motion-gallery-catalog.ts'),`// Generated from the verified official model by scripts/live2d/prepare-zundamon.mjs.\nexport const MOTION_GALLERY_ASSET = ${JSON.stringify(descriptor,null,2)} as const;\nexport const MOTION_GALLERY = ${JSON.stringify(entries,null,2)} as const;\n`);
}
