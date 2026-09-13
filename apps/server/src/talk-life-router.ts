import {respondGmail} from './talk-gmail.js';
import type {GmailService} from './gmail.js';
import type {GmailAssistantGateway} from './gmail-assistant.js';
import type {DriveSummaryGateway} from './drive-summary.js';
import type {DriveService} from './google-drive.js';
import type { ChatReply } from '../../../packages/domain/src/chat.js';
import type { TranscriptTurn } from '../../../packages/domain/src/session.js';
import type { LifeCard } from '../../../packages/domain/src/life-card.js';
import type { GoogleAssistantChanges, GoogleAssistantItem } from '../../../packages/domain/src/google-assistant.js';
import type { GoogleAssistantService } from './google-assistant.js';
import type { LifeSettingsService } from './life-settings.js';
import type { LifeWeatherService } from './life-weather.js';
import type { RequestUser } from './request-user.js';
import type { GoogleCalendarTasksPreviewService } from './google-calendar-tasks-preview.js';
import type { ChatStateRepository } from './chat-state-routes.js';
import { calendarWindow, isLifeServiceRequest, type TalkLifeIntentGateway } from './talk-life-intent.js';
import type { CostGuard } from './cost-guard.js';

export type TalkLifeRouter = { respond(input:{owner:RequestUser;text:string;turns:TranscriptTurn[];clientMessageId:string;timeZone:string;signal?:AbortSignal}):Promise<ChatReply|null> };
export function createTalkLifeRouter(options:{
 intent:TalkLifeIntentGateway; settings:LifeSettingsService; weather:LifeWeatherService;
 gmail?:GmailService; gmailAssistant?:GmailAssistantGateway;
 drive?:DriveService; driveSummary?:DriveSummaryGateway; google?:GoogleAssistantService; sources?:GoogleCalendarTasksPreviewService; chatState?:ChatStateRepository;
 costGuard:CostGuard; maximumUsd:number; now?:()=>Date;
}):TalkLifeRouter {
 const now=options.now??(()=>new Date());
 return {async respond(input) {
  if(!isLifeServiceRequest(input.text)) return null;
  const replyGroupId=`${input.clientMessageId}:assistant`;
  const answer=(text:string,lifeCard?:LifeCard):ChatReply=>({replyGroupId,bubbles:[{id:`${replyGroupId}:0`,text,sequence:0,createdAt:now().toISOString(),flow:'external_context'}],...(lifeCard?{lifeCard}:{})});
  try {
   const reservation=await options.costGuard.reserve({user:input.owner,requestId:`life-intent:${input.clientMessageId}`,feature:'chat',maximumUsd:options.maximumUsd});
   let intent;
   try {
    const snapshot=await options.chatState?.get(input.owner);
    const latest=snapshot?.timeline.slice().reverse().find(item=>item.type==='message'&&item.role==='assistant'&&item.lifeCard);
    const kind=latest?.type==='message'&&latest.role==='assistant'?latest.lifeCard?.kind:undefined;
    const selectedSource=kind?.startsWith('gmail-')?'gmail':kind?.startsWith('drive-')?'drive':undefined;
    intent=await options.intent.classify({text:input.text,context:input.turns.slice(-4),now:now().toISOString(),timeZone:input.timeZone,selectedSource},input.signal);
    // Conservatively account the configured per-request ceiling; never invent model pricing.
    await reservation.settle(options.maximumUsd);
   } catch(error) {await reservation.hold();throw error;}
   input.signal?.throwIfAborted();
   if(intent.kind==='none')return null;
   if(intent.clarification)return answer(intent.clarification.slice(0,400));
   if(intent.kind.startsWith('gmail_')){const result=await respondGmail(options,input,intent,now());return answer(result.text,result.card);}
   if(intent.kind==='drive_search'||intent.kind==='drive_read'||intent.kind==='drive_summary') {
    if(!options.drive)return answer('Google Driveはまだ接続されていないのだ。メニューのGoogle連携を確認してね。');
    if(intent.kind==='drive_search') {
     if(!intent.query)return answer('探したいファイル名やキーワードを教えてね。');
     const result=await options.drive.search(input.owner,intent.query,undefined,intent.driveMediaType??undefined);
     if(!result.files.length)return answer('見つからなかったのだ。別のキーワードで探してみてね。');
     const pickOne=/(?:[1１一](?:つ|件|個|本)|ひとつ)/u.test(input.text)&&!/(?:[1１一](?:つ|件|個|本)|ひとつ)(?:ずつ|づつ)/u.test(input.text);
     return answer(pickOne?'1つ選んだのだ！':result.files.length===1?'見つかったのだ！':'こちらが見つかったのだ。',{kind:'drive-results',query:intent.query,...(intent.driveMediaType?{mediaType:intent.driveMediaType}:{}),result:pickOne?{files:result.files.slice(0,1)}:result});
    }
    const snapshot=await options.chatState?.get(input.owner);
    const recent=snapshot?.timeline.slice().reverse().find(i=>i.type==='message'&&i.role==='assistant'&&(i.lifeCard?.kind==='drive-results'||i.lifeCard?.kind==='drive-content'));
    const c=recent?.type==='message'&&recent.role==='assistant'?recent.lifeCard:undefined;
    const files=c?.kind==='drive-results'?c.result.files:c?.kind==='drive-content'?[c.content.file]:[];
    let targets=intent.query?files.filter(f=>f.name===intent.query):files;
    if(!targets.length&&intent.query&&intent.kind==='drive_summary') {
     const found=await options.drive.search(input.owner,intent.query);
     if(found.files.length!==1||found.nextPageToken)return answer(found.files.length?'要約する資料を選んでね。':'その資料は見つからなかったのだ。',found.files.length?{kind:'drive-results',query:intent.query,result:found}:undefined);
     targets=found.files;
    }
    if(targets.length!==1)return answer('まずDriveでファイルを検索して、対象の「内容を読む」を押してね。');
    const content=await options.drive.read(input.owner,targets[0]!.id);
    if(intent.kind==='drive_summary') {
     if(!content.text.trim())return answer('この資料には要約できる本文がなかったのだ。');
     if(!options.driveSummary)return answer('要約はまだ利用できないのだ。',{kind:'drive-results',query:content.file.name,result:{files:[content.file]}});
     const summaryReservation=await options.costGuard.reserve({user:input.owner,requestId:`drive-summary:${input.clientMessageId}`,feature:'chat',maximumUsd:options.maximumUsd});
     let summary:string;
     try {summary=await options.driveSummary.summarize(content,input.signal);await summaryReservation.settle(options.maximumUsd);}catch{await summaryReservation.hold();return answer('要約できなかったのだ。少し待って、もう一度試してね。');}
     return answer(`${summary}${content.truncated?'\n※長い資料のため、先頭の一部から要約しています。':''}`,{kind:'drive-results',query:content.file.name,result:{files:[content.file]}});
    }
    return answer('ファイルの本文を表示するのだ。',{kind:'drive-content',content});
   }
   const settings=await options.settings.get(input.owner);
   if(intent.kind==='home_set') {
    if(!intent.query)return answer('自宅の市区町村か最寄り駅を教えてね。正確な住所でなくても大丈夫。');
    const result=await options.weather.locations(input.owner,intent.query);
    return answer(result.candidates.length?'この地域を自宅として使う？候補を選んで保存できるよ。':'その地域の候補が見つからなかったよ。市区町村の名前で教えてね。',{kind:'home-candidates',query:intent.query,candidates:result.candidates,revision:settings.revision});
   }
   if(intent.kind==='maps') {
    if(!intent.destination)return answer('どこまでの道順を調べようか？');
    if(intent.origin!=='current'&&!settings.home)return answer('自宅の市区町村や最寄り駅を、メニューの「自宅・地域」で保存してね。');
    return answer(intent.origin==='current'?'Googleマップで現在地からの道順を確認できるよ。':`${settings.home!.label}周辺からの道順をGoogleマップで確認できるよ。`,{kind:'maps',origin:intent.origin==='current'?null:settings.home!.query,destination:intent.destination,travelMode:intent.travelMode??'driving'});
   }
   if(intent.kind==='weather') {
    if(!settings.home)return answer('天気を調べる地域を、メニューの「自宅・地域」で保存してね。市区町村でも大丈夫。');
    const forecast=await options.weather.forecast(input.owner,7);
    const from=intent.dateFrom??forecast.days[0]?.date;
    const to=intent.dateTo??from;
    const availableFrom=forecast.days[0]?.date,availableTo=forecast.days.at(-1)?.date;
    if((from&&availableFrom&&from<availableFrom)||(to&&availableTo&&to>availableTo)||(from&&to&&to<from))return answer('指定した期間全体の予報はまだ取得できないよ。今日から7日間の範囲で確認できる。');
    const days=forecast.days.filter(d=>(!from||d.date>=from)&&(!to||d.date<=to));
    if(!days.length)return answer('その日の予報はまだ取得できないよ。今日から7日間の範囲で確認できる。');
    const rain=days.some(d=>d.precipitationProbability>=50);
    return answer(`${forecast.home.label}の予報を確認したよ。${rain?'雨の可能性があるので、傘があると安心だね。':'気温と降水確率はこの予報を見てね。'}`,{kind:'weather',forecast:{...forecast,days}});
   }
   if(!options.google)return answer('Google連携がまだ使えない状態だよ。メニューの「Google連携」で確認してね。');
   const service=intent.kind==='calendar_read'?'calendar':intent.kind==='tasks_read'?'tasks':intent.service;
   if(!service)return answer('カレンダーの予定とタスク、どちらを変更する？');
   if(intent.kind==='calendar_read' && options.sources) {
    const sources=await options.sources.sources({owner:input.owner,service:'calendar',requestId:`life-sources:${input.clientMessageId}`,context:{conversationId:input.clientMessageId,channel:'chat',personaId:'yui',memoryScope:'shared'},signal:input.signal});
    if(sources.status!=='completed')return answer('カレンダーの一覧を取得できなかったのだ。メニューの「Google連携」で接続を確認してね。');
    const selected=intent.sourceName?sources.value.items.filter(s=>s.title===intent.sourceName):sources.value.items;
    if(intent.sourceName && selected.length!==1)return answer('カレンダーを一つに特定できなかったのだ。カレンダーの名前を教えてね。');
    const window=calendarWindow(intent.dateFrom,intent.dateTo,now(),input.timeZone);
    const events:{item:GoogleAssistantItem;calendar:string}[]=[];
    let truncated=false;
    for(const source of selected) {
     let pageToken:string|undefined;
     const seen=new Set<string>();
     for(let page=0;page<10;page++) {
      if(input.signal?.aborted)throw new Error('aborted');
      const result=await options.google.list({owner:input.owner,request:{service:'calendar',sourceId:source.id,...window,...(pageToken?{pageToken}:{})}});
      events.push(...result.items.map(item=>({item,calendar:source.title})));
      if(!result.nextPageToken)break;
      if(seen.has(result.nextPageToken))throw new Error('repeated_page');
      seen.add(result.nextPageToken);pageToken=result.nextPageToken;
      if(page===9)truncated=true;
     }
    }
    const stamp=(start:string|undefined)=>start?.length===10?Date.parse(calendarWindow(start,start,now(),input.timeZone).timeMin):Date.parse(start??'');
    events.sort((a,b)=>stamp(a.item.start)-stamp(b.item.start));
    if(!events.length)return answer('指定した期間には、読み取り可能なカレンダーの予定はなかったのだ。');
    const fmt=new Intl.DateTimeFormat('ja-JP',{timeZone:input.timeZone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
    const lines=events.slice(0,30).map(({item,calendar})=>{
     const when=item.start?.length===10?item.start+' 終日':item.start?fmt.format(new Date(item.start)):'時刻未設定';
     return `・${when}　${item.title||'タイトルなし'}（${calendar}）`;
    });
    return answer('予定を確認したのだ。\n'+lines.join('\n')+(truncated||events.length>30?'\n予定が多いため一部を表示しているのだ。期間を絞って聞いてね。':''));
   }
   let selection=settings[service]??{id:service==='calendar'?'primary':'@default',title:service==='calendar'?'メインカレンダー':'マイタスク'};
   if(intent.sourceName && intent.sourceName!==selection.title) {
    if(!options.sources)return answer('メニューの「Google連携」で対象の一覧を選んでね。');
    const result=await options.sources.sources({owner:input.owner,service,requestId:`life-sources:${input.clientMessageId}`,context:{conversationId:input.clientMessageId,channel:'chat',personaId:'yui',memoryScope:'shared'},signal:input.signal});
    if(result.status!=='completed')return answer('Googleの一覧を取得できなかったよ。メニューの「Google連携」で接続を確認してね。');
    const matches=result.value.items.filter(i=>i.title===intent.sourceName);
    if(matches.length!==1)return answer(`「${intent.sourceName.slice(0,100)}」を一つに特定できなかったよ。メニューの「Google連携」で一覧を選んでね。`);
    selection=matches[0]!;
   }
   const window:{timeMin?:string;timeMax?:string}=service==='calendar'?calendarWindow(intent.dateFrom,intent.dateTo,now(),input.timeZone):{};
   if(intent.kind==='calendar_read'||intent.kind==='tasks_read') {
    const result=await options.google.list({owner:input.owner,request:{service,sourceId:selection.id,...window}});
    return answer(result.items.length?`${selection.title}を確認したよ。${result.nextPageToken?'続きの項目もあるよ。':''}`:`${selection.title}には、この条件で表示できる${service==='calendar'?'予定':'未完了のタスク'}はなかったよ。`,{kind:'google-items',result,sourceTitle:selection.title});
   }
   const changes:GoogleAssistantChanges={};
   if(intent.title)changes.title=intent.title;
   if(intent.notes!==null&&intent.notes!==undefined)changes.notes=intent.notes;
   if(intent.start)changes.start=intent.start;
   if(intent.end)changes.end=intent.end;
   if(intent.due)changes.due=intent.due;
   if(typeof intent.completed==='boolean')changes.completed=intent.completed;
   if(intent.kind!=='google_delete'&&!Object.keys(changes).length)return answer('どう変更するか教えてね。変更前に内容を確認するよ。');
   if(intent.kind==='google_create') {
    if(!changes.title)return answer('追加する名前を教えてね。');
    if(service==='calendar'&&(!changes.start||!changes.end))return answer('予定の開始日時と終了日時を教えてね。');
    const operation=await options.google.prepare({owner:input.owner,request:{service,sourceId:selection.id,action:'create',changes}});
    return answer(`${selection.title}に、この内容で追加する？まだGoogleには追加していないのだ。`,{kind:'google-operation',operation});
   }
   let candidates:GoogleAssistantItem[]=[];
   if(options.chatState) {
    const snapshot=await options.chatState.get(input.owner);
    // Resolve a conversational reference by server-owned operation identity, not inferred dates.
    const refersToLast=/この|これ|それ|さっき|先ほど|直前/u.test(input.text);
    const explicitDate=/今日|明日|昨日|明後日|来週|今週|来月|今月|\d+\s*(?:月|日|[-/])|[月火水木金土日]曜/u.test(input.text);
    const recent=snapshot?.timeline.slice().reverse().find(i=>i.type==='message'&&i.role==='assistant'&&(i.lifeCard?.kind==='google-operation'||i.lifeCard?.kind==='google-items'&&i.lifeCard.result.items.length>0));
    if(refersToLast&&!explicitDate&&!(intent.sourceName&&input.text.includes(intent.sourceName))&&recent?.type==='message'&&recent.role==='assistant'&&recent.lifeCard?.kind==='google-operation') {
     const op=await options.google.status({owner:input.owner,operationId:recent.lifeCard.operation.operationId});
     if(op.request.service!==service)return answer('直前の操作とはサービスが違うのだ。対象の予定名を教えてね。');
     if(op.state!=='succeeded'||!op.result||op.request.action==='delete')return answer(op.state==='succeeded'&&op.request.action==='delete'?'その予定はすでに削除済みなのだ。':'直前の操作では登録・変更の完了を確認できていないのだ。対象の予定名と日付を教えてね。');
     candidates=[op.result];
     selection={id:op.result.sourceId,title:op.result.sourceId===selection.id?selection.title:'Googleカレンダー'};
    }
    const latest=!candidates.length?snapshot?.timeline.slice().reverse().find(i=>i.type==='message'&&i.role==='assistant'&&i.lifeCard?.kind==='google-items'):undefined;
    if(latest?.type==='message'&&latest.role==='assistant'&&latest.lifeCard?.kind==='google-items'&&latest.lifeCard.result.service===service
      && (latest.lifeCard.result.sourceId===selection.id || (!intent.sourceName && /この|これ|それ|さっき/u.test(input.text)))
      && (!intent.dateFrom || latest.lifeCard.result.timeMin===window.timeMin)
      && (!intent.dateTo || latest.lifeCard.result.timeMax===window.timeMax)) {
     candidates=latest.lifeCard.result.items;
     selection={id:latest.lifeCard.result.sourceId,title:latest.lifeCard.sourceTitle};
    }
   }
   if(!candidates.length)candidates=(await options.google.list({owner:input.owner,request:{service,sourceId:selection.id,...window}})).items;
   const targets=intent.targetTitle?candidates.filter(i=>i.title===intent.targetTitle):candidates;
   if(!targets.length)return answer('対象の予定が見つからなかったのだ。予定名と日付を教えてね。まだ変更していないよ。');
   if(targets.length>1)return answer(intent.kind==='google_delete'?'削除する予定の「削除の確認へ」を押してね。次の画面で内容を確認してから削除するのだ。':'変更する予定の「変更の下書き」を押してね。',{kind:'google-items',result:{service,sourceId:selection.id,fetchedAt:now().toISOString(),items:targets,...window},sourceTitle:selection.title});
   const target=targets[0]!;
   if(target.unsupported)return answer('この予定は参加者や繰り返しなどを含むため、Googleの画面で変更してね。');
   if(service==='calendar'&&changes.start&&!changes.end&&target.start&&target.end)changes.end=new Date(Date.parse(changes.start)+Date.parse(target.end)-Date.parse(target.start)).toISOString();
   const operation=await options.google.prepare({owner:input.owner,request:{service,sourceId:target.sourceId,itemId:target.id,version:target.version,action:intent.kind==='google_delete'?'delete':service==='tasks'&&Object.keys(changes).length===1&&changes.completed!==undefined?'complete':'update',changes:intent.kind==='google_delete'?{}:changes}});
   return answer(`${selection.title}の予定なのだ。\n`+(intent.kind==='google_delete'?'この予定を削除する？確認ボタンを押すまで削除しないのだ。':'この変更で合っている？確認ボタンを押すまで変更しないよ。'),{kind:'google-operation',operation});
  } catch {
   input.signal?.throwIfAborted();
   return answer('今は情報の確認や変更の準備ができなかったよ。メニューの連携状態を確認して、もう一度試してね。変更の完了は確認できていないよ。');
  }
 }};
}
