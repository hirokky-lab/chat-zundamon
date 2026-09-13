import { MenuPage } from '../components/MenuPage';
import {GmailConnection} from './GmailConnection';
import type {GmailApi} from '../gmail';
import {DriveConnection} from './DriveConnection';
import type {DriveApi} from '../google-drive';
import {useEffect,useState} from 'react';
import {ArrowLeft,CalendarBlank,GoogleDriveLogo,EnvelopeSimple} from '@phosphor-icons/react';
import type {GoogleCalendarTasksApi,GoogleConnectionStatus} from '../google-calendar-tasks';
import '../google-connections.css';
export function GoogleConnections({api,driveApi,gmailApi,onClose,navigate=(url:string)=>window.location.assign(url)}:{api:GoogleCalendarTasksApi;driveApi?:DriveApi;gmailApi?:GmailApi;onClose:()=>void;navigate?:(url:string)=>void}){
 const [status,setStatus]=useState<GoogleConnectionStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[disconnect,setDisconnect]=useState(false);
 useEffect(()=>{let active=true;api.getSettings().then(s=>{if(active)setStatus(s.calendar);},()=>{if(active)setError('接続状態を確認できませんでした。開き直してください。');});return()=>{active=false;};},[api]);
 async function connect(purpose?: "write"){if(busy||!status||status.state==='disabled')return;setBusy(true);setError('');try{const url=new URL(await (purpose?api.beginConnection('calendar',purpose):api.beginConnection('calendar')));if(url.protocol!=='https:'||url.hostname!=='accounts.google.com'||url.username||url.password)throw Error();navigate(url.toString());}catch{setError('Googleの接続画面を開けませんでした。もう一度お試しください。');setBusy(false);}}
 async function stop(){if(busy)return;setBusy(true);setError('');try{await api.stopService('calendar');const s=await api.getSettings();setStatus(s.calendar);setDisconnect(false);}catch{setError('接続解除を確認できませんでした。もう一度お試しください。');}finally{setBusy(false);}}
 return <MenuPage title="Google連携" onBack={onClose} busy={busy} contentClassName="connection-page"><div className="google-connections-content"><p className="google-connections-intro">いつものGoogleサービスを、ずんだもんと。</p>
 <section className="google-connection-card"><div className="google-connection-title"><CalendarBlank size={28}/><div><h2>Googleカレンダー</h2><span>{!status?'接続状態を確認中':status.state==='connected'?'接続済み':status.state==='disabled'?'利用準備中':'未接続'}</span></div></div><p>仕事やプライベートなど、読み取り可能なカレンダーの予定をまとめて確認します。</p>
 {status?.state==='connected'?<><p className="google-connection-note">Googleアカウントのカレンダーに接続しています。予定の編集は、トークで内容を確認してから実行します。</p><button className="google-connect-action" disabled={busy} onClick={()=>void connect("write")}>予定の追加・変更・削除を有効にする</button>{disconnect?<div className="google-disconnect-confirm"><p>カレンダーとの接続を解除しますか？ Googleの予定は削除されません。</p><button disabled={busy} onClick={()=>void stop()}>接続を解除する</button><button disabled={busy} onClick={()=>setDisconnect(false)}>キャンセル</button></div>:<button className="google-disconnect" onClick={()=>setDisconnect(true)}>接続を解除</button>}</>:<button className="google-connect-action" disabled={busy||!status||status.state==='disabled'} onClick={()=>void connect()}>{busy?'Googleを開いています…':'Googleカレンダーを接続'}</button>}
 {status?.state==='disabled'&&<p className="google-connection-note">接続機能を準備しています。準備ができると、ここからGoogleの許可画面に進めます。</p>}
 </section>
 <DriveConnection api={driveApi} navigate={navigate}/>
 <GmailConnection api={gmailApi} navigate={navigate}/>
 {error&&<p role="alert">{error}</p>}
 </div></MenuPage>;
}
