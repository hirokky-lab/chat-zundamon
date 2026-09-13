// Original geometric fallback artwork; no character image is read or transformed.
// Refuse to replace locally installed artwork unless --replace is explicitly used.
import {deflateSync} from 'node:zlib';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=resolve(import.meta.dirname,'../apps/web/public');
const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const t=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([t,data])),8+data.length);return b;};
function png(w,h){
 const rows=Buffer.alloc((w*4+1)*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const nx=x/w,ny=y/h;const inside=nx>.19&&nx<.81&&ny>.32&&ny<.65;
  const tail=ny>=.65&&ny<.75&&nx>.29&&nx<.29+(.75-ny);
  let c=inside||tail?[57,118,73,255]:[255,249,236,255];
  for(const dx of [.36,.5,.64]) if((nx-dx)**2+(ny-.49)**2<.025**2)c=[255,249,236,255];
  const at=y*(w*4+1)+1+x*4;rows.set(c,at);
 }
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const outputs=new Map();
for(const s of [16,32,48,180,192,512]) outputs.set(`icons/zundamon-${s}-v2.png`,png(s,s));
outputs.set('icons/zundamon-master-v2.png',png(1024,1024));
outputs.set('apple-touch-icon.png',outputs.get('icons/zundamon-180-v2.png'));
for(const n of ['sakamoto-ahiru','sakamoto-ahiru-welcome','name-jaw-tilt'])outputs.set(`characters/zundamon/${n}.png`,png(500,650));
const entries=[16,32,48].map(size=>({size,data:outputs.get(`icons/zundamon-${size}-v2.png`)}));
const header=Buffer.alloc(54);header.writeUInt16LE(1,2);header.writeUInt16LE(3,4);let offset=54;
entries.forEach(({size,data},i)=>{let a=6+i*16;header[a]=size;header[a+1]=size;header.writeUInt16LE(1,a+4);header.writeUInt16LE(32,a+6);header.writeUInt32LE(data.length,a+8);header.writeUInt32LE(offset,a+12);offset+=data.length;});
outputs.set('favicon.ico',Buffer.concat([header,...entries.map(e=>e.data)]));
outputs.set('zundamon-placeholder.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 650"><rect width="500" height="650" rx="40" fill="#fff9ec"/><path d="M95 208h310v215H190l-45 65v-65H95z" fill="#397649"/><g fill="#fff9ec"><circle cx="180" cy="320" r="13"/><circle cx="250" cy="320" r="13"/><circle cx="320" cy="320" r="13"/></g></svg>'));
for(const [name,data] of outputs){const path=resolve(root,name);if(existsSync(path)&&!readFileSync(path).equals(data)&&!process.argv.includes('--replace'))throw new Error(`Refusing to replace artwork: ${name}`);}
for(const [name,data] of outputs){const path=resolve(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data);}
console.log(`Prepared ${outputs.size} original fallback files`);
