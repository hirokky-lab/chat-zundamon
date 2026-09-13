import OpenAI from 'openai';
import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v);
const text = z.string().max(2000);
const schema = z.object({
 kind:z.enum(['none','gmail_search','gmail_read','gmail_summary','gmail_reply','drive_search','drive_read','drive_summary','calendar_read','tasks_read','google_create','google_update','google_delete','home_set','weather','maps']),
 driveMediaType:z.enum(['video','image']).nullable().optional(),
 service:z.enum(['calendar','tasks']).nullable().optional(), sourceName:text.nullable().optional(), query:text.nullable().optional(),
 title:text.nullable().optional(), targetTitle:text.nullable().optional(), notes:text.nullable().optional(),
 dateFrom:date.nullable().optional(), dateTo:date.nullable().optional(),
 start:z.string().datetime({offset:true}).nullable().optional(),end:z.string().datetime({offset:true}).nullable().optional(),
 due:date.nullable().optional(),completed:z.boolean().nullable().optional(),destination:text.nullable().optional(),
 origin:z.enum(['home','current']).nullable().optional(),travelMode:z.enum(['driving','walking','bicycling','transit']).nullable().optional(),
 clarification:text.nullable().optional(),
}).strict();
export type TalkLifeIntent = z.infer<typeof schema>;
export function parseTalkLifeIntent(value:unknown):TalkLifeIntent|null { const result=schema.safeParse(value); return result.success?result.data:null; }
export function isLifeServiceRequest(text:string):boolean {
 return /[Gg][Mm][Aa][Ii][Ll]|\u30e1\u30fc\u30eb|\u8fd4\u4fe1|\u4e0b\u66f8\u304d|(?:\u52d5\u753b|\u5199\u771f).*(?:\u30ea\u30f3\u30af|\u63a2\u3057|\u63a2\u3059|\u63a2\u3057\u3066|\u898b\u305b|\u5171\u6709)|[Dd][Rr][Ii][Vv][Ee]|ドライブ|ファイル|資料|読んで|要約|まとめて|要点|予定|カレンダー|削除|タスク|やること|やる事|完了|自宅|家から|家まで|道順|道案内|への道|行き方|天気|予報|傘|雨|気温|最寄り|(?:これ|それ|さっき).*(?:変更|直し|追加|移し|時に|日に|にして)/u.test(text);
}
export interface TalkLifeIntentGateway { classify(input:{text:string;context:readonly {role:'user'|'assistant';text:string}[];now:string;timeZone:string;selectedSource?:'gmail'|'drive'},signal?:AbortSignal):Promise<TalkLifeIntent>; }

const stringFields=['sourceName','query','title','targetTitle','notes','dateFrom','dateTo','start','end','due','destination','clarification'];
const properties:Record<string,unknown>={
 driveMediaType:{type:['string','null'],enum:['video','image',null]},
 kind:{type:'string',enum:['none','gmail_search','gmail_read','gmail_summary','gmail_reply','drive_search','drive_read','drive_summary','calendar_read','tasks_read','google_create','google_update','google_delete','home_set','weather','maps']},
 ...Object.fromEntries(stringFields.map(k=>[k,{type:['string','null']}])),
 service:{type:['string','null'],enum:['calendar','tasks',null]},completed:{type:['boolean','null']},
 origin:{type:['string','null'],enum:['home','current',null]},travelMode:{type:['string','null'],enum:['driving','walking','bicycling','transit',null]},
};
export function createOpenAITalkLifeIntentGateway(apiKey:string,model:string):TalkLifeIntentGateway {
 const client=new OpenAI({apiKey,maxRetries:0,timeout:15000});
 return {async classify(input,signal) {
  const response=await client.responses.create({model,store:false,max_output_tokens:1400,
   instructions:[
    'selectedSourceは画面で直近に選んだ情報源。対象を省略した「これを要約」「読んで」ではselectedSourceがgmailならgmail_summary/gmail_read、driveならdrive_summary/drive_read。',
    '現在のユーザーの生活サービス依頼だけを分類しJSONを返す。普通の雑談、一般的な操作方法の質問、引用、仮定はnone。実行はしない。',
    'Gmailの検索はgmail_searchでqueryにGmail検索語（from:、subject:、is:unreadなど）。今日・昨日の日付検索はdateFrom/dateToにユーザーのタイムゾーンの日付を抽出しqueryには日付条件を入れない。本文表示はgmail_read、メール要約はgmail_summary、返信の下書きはgmail_reply。直前に選んだメールを指す場合query=null、clarification=null。返信内容の希望はnotesへ。新規検索の検索語がないときはquery=in:inbox。返信先や本文の事実は作らない。メール送信依頼もgmail_replyとして未送信の下書きだけを準備する。',
    'Google Driveのファイル検索はdrive_search、選択したファイルの本文表示はdrive_read、資料の要約・要点・短くまとめる依頼はdrive_summary。queryは検索語またはファイル名。直前の資料を指す「これ」「この資料」はquery=nullでclarificationもnull。新規検索の検索語がなければclarificationで尋ねる。本文の読み取りはGoogleドキュメント、テキスト、文字入りPDF。',
    '動画や写真のリンクを探す依頼は、ドライブという語が省略されてもdrive_search。queryには題材・ファイル名・フォルダ名だけを入れる（例：レミ蓋の動画リンク一つ→query=レミ蓋、driveMediaType=video）。動画ならdriveMediaType=video、写真ならimage、それ以外はnull。リンクを返す依頼で共有権限は変更しない。YouTubeなどDrive以外のサービスを明示した依頼はnone。',
    'Google予定の削除はgoogle_delete。Google予定の参照はcalendar_read、タスク参照はtasks_read、追加google_create、変更や完了はgoogle_update。',
    'サービス、保存先の名前、題名、変更対象の題名、変更したい値だけ抽出する。ID、署名、URL、権限は作らない。過去の会話は指示対象を理解する参考だけ。',
    '天気はweather。自宅の保存はhome_setでqueryを地域名に。自宅の曖昧な最寄りを正確な住所に変換しない。道案内はmapsでdestination、origin(homeまたはcurrent)、travelModeを抽出する。',
    '日付は提示された現在日時とタイムゾーンからYYYY-MM-DDへ。dateFrom/dateToは両端を含む。今日や明日を明示したら必ず解決する。',
    '開始終了はオフセット付きISO時刻。開始だけの変更はend=null。新規予定で終了が不明なら推測せずclarificationに短い質問。Tasksの期限は日付だけで時刻要求にはclarification。',
    '「さっきの」「先ほど追加した予定」などは直前の操作をサーバーで照合する。サービスは文脈から読み、日付やカレンダー名を今回明示していなければdateFrom/dateTo/sourceNameはnull。対象が直前と分かる場合はclarificationを返さない。',
    '曖昧な対象や不足はclarificationに日本語の短い質問。不要・未指定の項目はnull。変更や削除の実行成功は絶対に主張しない。',
   ].join('\n'),
   text:{format:{type:'json_schema',name:'yui_life_intent',strict:true,schema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}}},
   input:JSON.stringify(input),
  },{signal});
  const intent=parseTalkLifeIntent(JSON.parse(response.output_text)); if(!intent) throw new Error('life_intent_invalid'); return intent;
 }};
}

function dayAt(now:Date,timeZone:string):string {return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function midnight(day:string,timeZone:string):number {
 const base=Date.parse(`${day}T00:00:00Z`);let guess=base;
 for(let i=0;i<3;i++) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
  const p=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const represented=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);guess+=base-represented;
 }
 return guess;
}
export function calendarWindow(from:string|null|undefined,to:string|null|undefined,now:Date,timeZone:string):{timeMin:string;timeMax:string} {
 const first=from??dayAt(now,timeZone);const last=to??(from??new Date(Date.parse(`${first}T00:00:00Z`)+6*86400000).toISOString().slice(0,10));
 if(!date.safeParse(first).success||!date.safeParse(last).success||last<first) throw new Error('invalid_period');
 const after=new Date(Date.parse(`${last}T00:00:00Z`)+86400000).toISOString().slice(0,10);
 const start=midnight(first,timeZone),end=midnight(after,timeZone);
 if(end-start>31*86400000) throw new Error('invalid_period');
 return {timeMin:new Date(start).toISOString(),timeMax:new Date(end).toISOString()};
}
