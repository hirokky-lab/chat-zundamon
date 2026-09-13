import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
const script=readFileSync('public/wallpaper-bootstrap.js','utf8');
function restore(value:unknown, fail=false, systemDark=false){
 const properties:Record<string,string>={};let theme='';
 runInNewContext(script,{matchMedia:()=>({matches:systemDark}),document:{documentElement:{dataset:{},style:{setProperty:(k:string,v:string)=>{properties[k]=v;}}},querySelector:()=>({setAttribute:(_k:string,v:string)=>{theme=v;}})},localStorage:{getItem:()=>{if(fail)throw Error('denied');return typeof value==='string'?value:JSON.stringify(value);}}});
 return {properties,theme};
}
const wallpaper={background:'linear-gradient(rgb(48 45 77 / 20%), rgb(48 45 77 / 20%)), url("/backgrounds/edamame-lavender-night-v1.png")',position:'center',size:'auto 400px',repeat:'repeat',color:'rgb(48 45 77)'};
describe('early wallpaper restore',()=>{
 it('restores the selected wallpaper before React, including tint and tile size',()=>{
  const result=restore(wallpaper);expect(result.properties['--room-background']).toContain('edamame-sky-night-v2.png');expect(result.properties['--room-size']).toBe('auto 400px');expect(result.theme).toBe('#2e3a5e');
 });
 it('migrates retired room, milk-tea and uploaded wallpaper previews to green',()=>{
  for(const background of ['url("/backgrounds/room-night-v1.png")','url("/backgrounds/edamame-milktea-night-v1.png")','url("data:image/jpeg;base64,AAAA")']){
   expect(restore({...wallpaper,background}).properties['--room-background']).toContain('edamame-');
  }
 });
 it('does not load remote cached URLs and tolerates unavailable storage',()=>{
  expect(restore({...wallpaper,background:'url("https://example.test/image.png")'}).properties['--room-background']).toContain('edamame-sky-day');
  expect(restore('broken').properties['--room-background']).toContain('edamame-sky-day');expect(restore(null,true).properties['--room-background']).toContain('edamame-sky-day');
 });
});

it('selects the cached night wallpaper before React when system dark mode is enabled',()=>{
 const day={...wallpaper,background:'url("/backgrounds/edamame-day-v5.png")'};
 const value={mode:'system',day,night:wallpaper};
 expect(restore(value,false,true).properties['--room-background']).toContain('edamame-sky-night-v2.png');
 expect(restore(value,false,false).properties['--room-background']).toContain('edamame-sky-day-v2.png');
 expect(restore({...value,mode:'light'},false,true).properties['--room-background']).toContain('edamame-sky-day-v2.png');
});

it.each(['edamame', 'edamame-orange', 'edamame-sky'])('upgrades cached %s in both modes before React', (theme) => {
 for (const tone of ['day', 'night']) {
  const cached={...wallpaper, background:`url("/backgrounds/${theme}-${tone}-v1.png")`};
  expect(restore(cached).properties['--room-background']).toContain(`edamame-sky-${tone}-v2.png`);
 }
});
