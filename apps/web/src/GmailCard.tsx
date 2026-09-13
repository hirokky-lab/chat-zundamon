import {GoogleWriteEditor} from './GoogleWriteEditor';
import type {WritesApi} from './google-writes';
import {useEffect,useState} from 'react';
import type {LifeCard,GmailMessage} from '@yui/domain';
import type {GmailApi} from './gmail';
type MailCard=Extract<LifeCard,{kind:'gmail-results'|'gmail-content'|'gmail-draft'}>;
const link=(message:GmailMessage)=>`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId)}`;
export function GmailCard({card,api,busy,run,replace,writesApi}:{card:MailCard;writesApi?:WritesApi;api?:GmailApi;busy:boolean;run:(fn:()=>Promise<void>)=>Promise<void>;replace:(card:LifeCard)=>Promise<void>}){
 const [body,setBody]=useState(card.kind==='gmail-draft'?card.body:''),[copied,setCopied]=useState(false);
 useEffect(()=>{setBody(card.kind==='gmail-draft'?card.body:'');},[card]);
 if(card.kind==='gmail-results')return <><ul>{card.result.messages.map(message=><li key={message.id}><a href={link(message)} target="_blank" rel="noopener noreferrer">{message.subject||'件名なし'} ↗</a><small>{message.from}</small><button disabled={busy||!api} onClick={()=>void run(async()=>replace({kind:'gmail-content',content:await api!.read(message.id)}))}>内容を読む</button></li>)}</ul>{card.result.nextPageToken&&<button disabled={busy||!api} onClick={()=>void run(async()=>replace({...card,result:await api!.search(card.query,card.result.nextPageToken)}))}>続きを見る</button>}</>;
 return <><strong>{card.content.message.subject||'件名なし'}</strong><small>{card.content.message.from}</small>{card.kind==='gmail-content'?<><p className="gmail-body">{card.content.text||'本文を読み取れませんでした。Gmailで確認してください。'}</p>{card.content.truncated&&<small>長いメールのため一部を表示しています。</small>}</>:<><p>返信の下書き・未送信</p><textarea aria-label="返信の下書き" value={body} maxLength={4000} onChange={e=>{setBody(e.target.value);setCopied(false);}} onBlur={()=>{if(body!==card.body)void run(async()=>replace({...card,body}));}}/><button disabled={!body} onClick={()=>{void navigator.clipboard.writeText(body).then(()=>setCopied(true)).catch(()=>setCopied(false));}}>下書きをコピー</button>{copied&&<small role="status">コピーしました</small>}<GoogleWriteEditor api={writesApi} label="送信内容を確認" initial={{kind:"gmail",to:card.content.message.from.match(/<([^<>]+)>/)?.[1]??card.content.message.from,title:/^re:/i.test(card.content.message.subject)?card.content.message.subject:"Re: "+card.content.message.subject,body,replyId:card.content.message.id}}/></>}<a href={link(card.content.message)} target="_blank" rel="noopener noreferrer">Gmailで開く ↗</a></>;
}
