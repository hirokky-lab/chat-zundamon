// @vitest-environment node
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
import {expect,it} from 'vitest';
it('restores the selected wallpaper from the initial HTML even before external scripts arrive',async()=>{
 const server=await createServer({server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
 try {
  const html=await server.transformIndexHtml('/',await readFile('index.html','utf8'));
  const dom=new JSDOM(html,{url:'https://app.example/',runScripts:'dangerously',beforeParse(window){
   window.localStorage.setItem('zundamon-ai.wallpaper-bootstrap.v1',JSON.stringify({background:'url("/backgrounds/edamame-pink-day-v1.png")',position:'center',size:'auto 400px',repeat:'repeat',color:'rgb(255 251 240)'}));
  }});
  expect(dom.window.document.documentElement.style.getPropertyValue('--room-background')).toContain('edamame-pink-day-v2.png');
  expect(dom.window.document.documentElement.style.getPropertyValue('--wallpaper-height')).toBe(`${dom.window.innerHeight}px`);
  dom.window.close();
 } finally {await server.close();}
},20_000);
