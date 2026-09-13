export type DriveFile={id:string;name:string;mimeType:string;modifiedTime?:string};
export type DriveResults={files:DriveFile[];nextPageToken?:string};
export type DriveContent={file:DriveFile;text:string;truncated:boolean};
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max;
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
function file(v:unknown):v is DriveFile{return obj(v)&&keys(v,['id','name','mimeType','modifiedTime'])&&str(v.id,256)&&/^[\w-]+$/.test(v.id)&&str(v.name,1024)&&str(v.mimeType,200)&&(v.modifiedTime===undefined||str(v.modifiedTime,64));}
function results(v:unknown):v is DriveResults{return obj(v)&&keys(v,['files','nextPageToken'])&&Array.isArray(v.files)&&v.files.length<=100&&v.files.every(file)&&(v.nextPageToken===undefined||str(v.nextPageToken,2048));}
function content(v:unknown):v is DriveContent{return obj(v)&&keys(v,['file','text','truncated'])&&file(v.file)&&str(v.text,20000)&&typeof v.truncated==='boolean';}
function validator<T>(valid:(v:unknown)=>v is T){return {parse(v:unknown):T{if(!valid(v))throw Error('Invalid Drive response');return v;},safeParse(v:unknown):{success:boolean}{return {success:valid(v)};}};}
export const driveResultsSchema=validator(results),driveContentSchema=validator(content);
