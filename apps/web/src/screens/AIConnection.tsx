import { MenuPage } from '../components/MenuPage';
import {useEffect,useState} from 'react';
import {Key} from '@phosphor-icons/react';
import type {AIConnectionApi,AIStatus} from '../ai-connection';
import '../google-connections.css';
import '../ai-connection.css';
import type { CodexApi } from '../codex';
import { CodexConnectionCard } from '../components/CodexConnectionCard';
export function AIConnection({api,codexApi,onClose}:{api:AIConnectionApi;codexApi?:CodexApi;onClose:()=>void}){
 const [status,setStatus]=useState<AIStatus|null>(null),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[removing,setRemoving]=useState(false);
 useEffect(()=>{let alive=true;api.status().then(s=>{if(alive)setStatus(s);},()=>{if(alive)setError('設定を読み込めませんでした。開き直してください。');});return()=>{alive=false;};},[api]);
 async function act(kind:'save'|'test'|'remove'){
 if(busy)return;setBusy(true);setError('');setMessage('');
 try{const next=await (kind==='save'?api.save(key.trim()):kind==='test'?api.test():api.remove());setStatus(next);setKey('');setRemoving(false);setMessage(kind==='remove'?'AIの接続を解除しました。':kind==='test'?'接続できました。':'接続を確認して保存しました。');}
 catch(e){setError(e instanceof Error?e.message:'接続を確認できませんでした。');}finally{setBusy(false);}
 }
 return <MenuPage title="AI接続" onBack={onClose} busy={busy} contentClassName="connection-page ai-connection"><div className="google-connections-content"><section className="google-connection-card"><div className="google-connection-title"><Key size={28}/><div><h2>OpenAI</h2><span>{status?status.configured?'登録済み':'未接続':'読み込み中'}</span></div></div>
 <p>ずんだもんとの会話や、写真の読み取りに使います。</p>
 {status?.configured&&<button disabled={busy} className="ai-secondary" onClick={()=>void act('test')}>接続を確認</button>}
 <form onSubmit={e=>{e.preventDefault();void act('save');}}><label htmlFor="ai-api-key">{status?.configured?'新しいAPIキー':'APIキー'}</label><input id="ai-api-key" name="api-key" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={key} disabled={busy||!status} onChange={e=>{setKey(e.target.value);setMessage('');setError('');}} placeholder="sk-…" maxLength={512}/><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">APIキーを取得する ↗</a><button className="google-connect-action" disabled={busy||!status||!key.trim()} type="submit">{busy?'確認中…':'確認して保存する'}</button></form>
 <p className="google-connection-note">同じアカウントで使う端末に反映されます。キーはサーバーに暗号化して保存します。</p><p className="google-connection-note">ChatGPTの契約とは別に、OpenAI APIの利用料金がかかります。接続確認でも短い通信を行います。</p>
 {status?.configured&&(removing?<div className="google-disconnect-confirm"><p>AIの接続を解除しますか？ 会話や記憶は残ります。</p><button disabled={busy} onClick={()=>void act('remove')}>接続を解除する</button><button disabled={busy} onClick={()=>setRemoving(false)}>キャンセル</button></div>:<button className="google-disconnect" disabled={busy} onClick={()=>setRemoving(true)}>接続を解除</button>)}
 {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
 </section>{codexApi ? <CodexConnectionCard api={codexApi}/> : null}</div></MenuPage>;
}
