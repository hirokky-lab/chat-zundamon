import {Worker} from 'node:worker_threads';
export function extractPdfText(bytes:Uint8Array):Promise<{text:string;truncated:boolean}>{
 if(bytes.length>10000000)return Promise.reject(Error('drive_file_too_large'));
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./pdf-text-worker.mjs',import.meta.url),{workerData:bytes,resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32}});
  let done=false;
  const finish=(error?:Error,result?:{text:string;truncated:boolean})=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate();if(error)reject(error);else resolve(result!);};
  const timer=setTimeout(()=>finish(Error('drive_pdf_unavailable')),15000);
  worker.on('message',result=>{if(result.error)return finish(Error(result.error));if(typeof result.text!=='string'||typeof result.truncated!=='boolean')return finish(Error('drive_pdf_unavailable'));if(!result.text.trim())return finish(Error('drive_pdf_no_text'));finish(undefined,result);});
  worker.on('error',()=>finish(Error('drive_pdf_unavailable')));worker.on('exit',()=>{if(!done)finish(Error('drive_pdf_unavailable'));});
 });
}
