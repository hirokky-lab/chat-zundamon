import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
const script=readFileSync('public/wallpaper-viewport.js','utf8');
function viewport(standalone:boolean) {
 const values:Record<string,string>={},events:Record<string,()=>void>={};
 const window={innerWidth:393,innerHeight:793,screen:{width:393,height:852},matchMedia:()=>({matches:standalone}),addEventListener:(name:string,fn:()=>void)=>{events[name]=fn;}};
 runInNewContext(script,{window,navigator:{standalone},document:{documentElement:{style:{setProperty:(k:string,v:string)=>{values[k]=v;}}}}});
 return {window,values,resize:()=>events.resize()};
}
it('covers the missing status-bar height in a standalone iPhone window',()=>{
 const f=viewport(true);expect(f.values['--wallpaper-height']).toBe('852px');
 f.window.innerHeight=410;f.resize();expect(f.values['--wallpaper-height']).toBe('852px');
});
it('handles landscape screen axes without using the portrait height',()=>{
 const f=viewport(true);f.window.innerWidth=852;f.window.innerHeight=372;f.resize();expect(f.values['--wallpaper-height']).toBe('393px');
});
it('does not use physical screen height for ordinary browser windows',()=>{
 const f=viewport(false);expect(f.values['--wallpaper-height']).toBe('793px');
});
