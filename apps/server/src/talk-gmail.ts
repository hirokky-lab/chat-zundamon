import type {GmailContent,LifeCard} from '@yui/domain';
import type {GmailService} from './gmail.js';
import type {GmailAssistantGateway} from './gmail-assistant.js';
import type {TalkLifeIntent} from './talk-life-intent.js';
import {calendarWindow} from './talk-life-intent.js';
import type {RequestUser} from './request-user.js';
import type {ChatStateRepository} from './chat-state-routes.js';
import type {CostGuard} from './cost-guard.js';
export async function respondGmail(options:{gmail?:GmailService;gmailAssistant?:GmailAssistantGateway;chatState?:ChatStateRepository;costGuard:CostGuard;maximumUsd:number},input:{owner:RequestUser;text:string;clientMessageId:string;timeZone:string;signal?:AbortSignal},intent:TalkLifeIntent,now:Date):Promise<{text:string;card?:LifeCard}>{
 const gmail=options.gmail;if(!gmail)return {text:'メニューのGoogle連携からGmailを接続してね。'};
 if(!(await gmail.status(input.owner)).connected)return {text:'メニューのGoogle連携からGmailを接続してね。'};
 let query=intent.query??'in:inbox';
 if(intent.dateFrom){const window=calendarWindow(intent.dateFrom,intent.dateTo,now,input.timeZone);query+=` after:${Math.floor(Date.parse(window.timeMin)/1000)} before:${Math.floor(Date.parse(window.timeMax)/1000)}`;}
 if(intent.kind==='gmail_search'){const result=await gmail.search(input.owner,query);return {text:result.messages.length?'メールが見つかったのだ。':'該当するメールはなかったのだ。',...(result.messages.length?{card:{kind:'gmail-results' as const,query,result}}:{})};}
 const snapshot=await options.chatState?.get(input.owner);
 const recent=snapshot?.timeline.slice().reverse().find(item=>item.type==='message'&&item.role==='assistant'&&item.lifeCard?.kind.startsWith('gmail-'));
 const card=recent?.type==='message'&&recent.role==='assistant'?recent.lifeCard:undefined;
 let messages=card?.kind==='gmail-results'?card.result.messages:card?.kind==='gmail-content'||card?.kind==='gmail-draft'?[card.content.message]:[];
 if(intent.query){const found=await gmail.search(input.owner,query);messages=found.messages;if(messages.length!==1||found.nextPageToken)return {text:messages.length?'対象のメールを選んでね。':'該当するメールはなかったのだ。',...(messages.length?{card:{kind:'gmail-results' as const,query,result:found}}:{})};}
 if(messages.length!==1)return {text:'対象のメールの「内容を読む」を押してから、もう一度頼んでね。'};
 const content:GmailContent=await gmail.read(input.owner,messages[0]!.id);
 if(intent.kind==='gmail_read')return {text:'メールの本文はこちらなのだ。',card:{kind:'gmail-content',content}};
 if(!content.text.trim())return {text:'このメールには読み取れる本文がなかったのだ。',card:{kind:'gmail-content',content}};
 if(!options.gmailAssistant)return {text:'今はメールの要約を利用できません。',card:{kind:'gmail-content',content}};
 const reservation=await options.costGuard.reserve({user:input.owner,requestId:`gmail-ai:${input.clientMessageId}`,feature:'chat',maximumUsd:options.maximumUsd});
 try {
  if(intent.kind==='gmail_reply'){const body=await options.gmailAssistant.reply(content,intent.notes??input.text,input.signal);await reservation.settle(options.maximumUsd);return {text:'返信の下書きなのだ。内容を確認してね。まだ送信していないよ。'+(content.truncated?' 元メールの一部だけを参考にしています。':''),card:{kind:'gmail-draft',content,body}};}
  const summary=await options.gmailAssistant.summarize(content,input.signal);await reservation.settle(options.maximumUsd);return {text:summary+(content.truncated?'\n※本文の一部から要約しています。':''),card:{kind:'gmail-results',query:query,result:{messages:[content.message]}}};
 }catch{await reservation.hold();return {text:'メールの文章をまとめられなかったのだ。少し待って、もう一度試してね。'};}
}
