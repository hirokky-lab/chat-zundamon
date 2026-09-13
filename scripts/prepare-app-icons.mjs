// Export the approved master without redrawing it. macOS sips is used for PNG resizing.
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../apps/web/public/',import.meta.url));
for(const size of [16,32,48,180,192,512]) {
  execFileSync('sips',['-z',String(size),String(size),root+'icons/zundamon-master-v2.png','--out',root+`icons/zundamon-${size}-v2.png`],{stdio:'ignore'});
}
copyFileSync(root+'icons/zundamon-180-v2.png',root+'apple-touch-icon.png');
// Modern ICO supports PNG entries; retain 16/32/48 px for browser/desktop shortcuts.
const entries=[16,32,48].map(size=>({size,data:readFileSync(root+`icons/zundamon-${size}-v2.png`)}));
const header=Buffer.alloc(6+entries.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(entries.length,4);
let offset=header.length;
entries.forEach(({size,data},index)=>{const at=6+index*16;header[at]=size;header[at+1]=size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(data.length,at+8);header.writeUInt32LE(offset,at+12);offset+=data.length;});
writeFileSync(root+'favicon.ico',Buffer.concat([header,...entries.map(e=>e.data)]));
