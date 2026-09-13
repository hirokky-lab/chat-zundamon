import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
const version='20260913-chat-zundamon-name-2';
function pngDimensions(path: string) {
  const bytes=readFileSync(path);
  expect(bytes.subarray(1,4).toString('ascii')).toBe('PNG');
  return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}
describe('Zundamon app icon delivery',()=>{
  it.each([16,32,48,180,192,512])('exports a %i px PNG from the Zundamon master',size=>{
    expect(pngDimensions(`public/icons/zundamon-${size}-v2.png`)).toEqual({width:size,height:size});
  });
  it('advertises the existing app identity with PNG install icons and an explicit Apple icon',()=>{
    const html=readFileSync('index.html','utf8');
    const manifest=JSON.parse(readFileSync('public/manifest.webmanifest','utf8'));
    expect(html).toContain('<title>Chatずんだもん</title>');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Chatずんだもん"');
    expect(html).toContain('/icons/zundamon-32-v2.png');
    expect(html).toContain('/icons/zundamon-16-v2.png');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/icons/zundamon-180-v2.png"');
    expect(html).not.toMatch(/yui-icon|zundamon-placeholder/);
    expect(manifest).toMatchObject({id:'/zundamon-ai',name:'Chatずんだもん',short_name:'Chatずんだもん',display:'standalone'});
    expect(manifest.icons).toEqual([192,512].map(size=>({src:`/icons/zundamon-${size}-v2.png`,sizes:`${size}x${size}`,type:'image/png',purpose:'any'})));
    for(const icon of manifest.icons) expect(pngDimensions('public'+icon.src).width).toBe(Number(icon.sizes.split('x')[0]));
  });
  it('replaces the legacy Apple fallback and provides all favicon ICO entries',()=>{
    expect(readFileSync('public/apple-touch-icon.png')).toEqual(readFileSync('public/icons/zundamon-180-v2.png'));
    const ico=readFileSync('public/favicon.ico');
    expect(ico.readUInt16LE(2)).toBe(1);expect(ico.readUInt16LE(4)).toBe(3);
    [16,32,48].forEach((size,index)=>{
      const at=6+index*16, length=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);
      expect(ico[at]).toBe(size);
      expect(ico.subarray(offset,offset+length)).toEqual(readFileSync(`public/icons/zundamon-${size}-v2.png`));
    });
  });
  it('versions the HTML manifest link and worker registration together',()=>{
    expect(readFileSync('index.html','utf8')).toContain(`/manifest.webmanifest?v=${version}`);
    expect(readFileSync('src/pwa.ts','utf8')).toContain(`const PWA_VERSION = "${version}"`);
    expect(readFileSync('public/sw.js','utf8')).toContain(`const ZUNDAMON_PWA_VERSION = "${version}"`);
  });
});
