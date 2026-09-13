import {parentPort,workerData} from 'node:worker_threads';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
let task;
try {
 task=getDocument({data:new Uint8Array(workerData),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,stopAtErrors:true,verbosity:0});
 const doc=await task.promise;let text='',processed=0;
 for(let i=1;i<=Math.min(doc.numPages,30);i++){const page=await doc.getPage(i);const content=await page.getTextContent();text+=content.items.filter(item=>'str' in item).map(item=>item.str+(item.hasEOL?'\n':' ')).join('')+'\n';processed=i;page.cleanup();if(text.length>20000)break;}
 parentPort.postMessage({text:text.slice(0,20000).trim(),truncated:processed<doc.numPages||text.length>20000});
}catch(error){parentPort.postMessage({error:error?.name==='PasswordException'?'drive_pdf_locked':'drive_pdf_unavailable'});}finally{await task?.destroy();}
