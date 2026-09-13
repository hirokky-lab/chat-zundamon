export type GmailMessage={id:string;threadId:string;subject:string;from:string;date:string};
export type GmailResults={messages:GmailMessage[];nextPageToken?:string};
export type GmailContent={message:GmailMessage;text:string;truncated:boolean};
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max;
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const id=(v:unknown)=>str(v,64)&&/^[a-f0-9]+$/.test(v);
function message(v:unknown):v is GmailMessage{return obj(v)&&keys(v,['id','threadId','subject','from','date'])&&id(v.id)&&id(v.threadId)&&str(v.subject,1024)&&str(v.from,1024)&&str(v.date,200);}
function results(v:unknown):v is GmailResults{return obj(v)&&keys(v,['messages','nextPageToken'])&&Array.isArray(v.messages)&&v.messages.length<=10&&v.messages.every(message)&&(v.nextPageToken===undefined||str(v.nextPageToken,2048));}
function content(v:unknown):v is GmailContent{return obj(v)&&keys(v,['message','text','truncated'])&&message(v.message)&&str(v.text,20000)&&typeof v.truncated==='boolean';}
function validator<T>(valid:(v:unknown)=>v is T){return {parse(v:unknown):T{if(!valid(v))throw Error('Invalid Gmail response');return v;},safeParse(v:unknown){return {success:valid(v)};}};}
export const gmailResultsSchema=validator(results),gmailContentSchema=validator(content);
