import { MenuPage } from '../components/MenuPage';
import {useEffect,useState} from 'react';
import {ArrowLeft,CaretRight,User,Briefcase,MapPin,NotePencil} from '@phosphor-icons/react';
import type {Memory,Profile,LifeSettings as Settings} from '@yui/domain';
import type {MemoryApi} from '../api';
import type {LifeServicesApi} from '../life-services';
import type {GoogleCalendarTasksApi} from '../google-calendar-tasks';
import {LifeSettings} from './LifeSettings';
import '../memory-hub.css';
const blank={nickname:'',occupation:'',details:'',responsePreferences:''};
export function MemoryHub({profile,api,memoryApi,googleApi,onClose,onOpenMemories,onSaveName,onMemoryEnabled,onSaveProfile}:{profile:Profile;api:LifeServicesApi;memoryApi:MemoryApi;googleApi:GoogleCalendarTasksApi;onClose:()=>void;onOpenMemories:()=>void;onSaveName:(name:string)=>Promise<void>;onMemoryEnabled:(enabled:boolean)=>void;onSaveProfile?:(input:{displayName:string;occupation:string;region:string})=>Promise<void>}){
 const [settings,setSettings]=useState<Settings|null>(null),[personal,setPersonal]=useState(blank),[name,setName]=useState(profile.displayName),[enabled,setEnabled]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[home,setHome]=useState(false);
 const [region,setRegion]=useState(profile.region??'');
 const profileReady=Boolean(onSaveProfile)||Boolean(settings);
 const [memories,setMemories]=useState<Memory[]>([]),[memoryState,setMemoryState]=useState('loading');
 useEffect(()=>{let active=true;Promise.resolve().then(()=>memoryApi.list()).then(items=>{if(active){setMemories(items.filter(m=>m.status==='active'));setMemoryState('ready');}},()=>{if(active)setMemoryState('error');});return()=>{active=false;};},[memoryApi]);
 useEffect(()=>{let active=true;if(onSaveProfile){setPersonal({...blank,occupation:profile.occupation??''});api.getSettings().then(s=>{if(active){setSettings(s);if(s.home)setRegion(s.home.label);}},()=>{});}else{api.getSettings().then(s=>{if(active){setSettings(s);setPersonal(s.personal??blank);}},()=>{if(active)setMessage('プロフィールを読み込めませんでした。開き直してください。');});}memoryApi.getSettings().then(m=>{if(active)setEnabled(m.memoryEnabled);},()=>{if(active)setMessage('記憶の設定を読み込めませんでした。開き直してください。');});return()=>{active=false;};},[api,memoryApi]);

 async function save(){if(!profileReady||busy||!name.trim())return;setBusy(true);setMessage('');try{if(onSaveProfile){await onSaveProfile({displayName:name.trim(),occupation:personal.occupation,region});setMessage('保存しました。');return;}if(!settings)return;const next=await api.saveSettings({...settings,personal});setSettings(next);if(name.trim()!==profile.displayName){try{await onSaveName(name.trim());}catch{setMessage('詳細は保存しましたが、名前を保存できませんでした。もう一度保存してください。');return;}}setMessage('保存しました。');}catch{setMessage('保存できませんでした。別の画面で更新した場合は、開き直してください。');}finally{setBusy(false);}}
 async function toggle(){if(enabled===null||busy)return;setBusy(true);setMessage('');try{const result=await memoryApi.updateSettings({memoryEnabled:!enabled});setEnabled(result.memoryEnabled);onMemoryEnabled(result.memoryEnabled);}catch{setMessage('メモリの設定を変更できませんでした。');}finally{setBusy(false);}}
 if(home)return <LifeSettings api={api} googleApi={googleApi} initialSection="home" onClose={()=>{setHome(false);setBusy(true);api.getSettings().then(s=>{setSettings(s);setRegion(s.home?.label??'');}).catch(()=>{setSettings(null);setMessage('地域設定を再取得できませんでした。開き直してください。');}).finally(()=>setBusy(false));}}/>;
 return <MenuPage title="プロフィール" onBack={onClose} busy={busy} contentClassName="memory-hub">
 <div className="memory-hub-content">
 <form onSubmit={e=>{e.preventDefault();void save();}}>
 <div className="memory-section-heading"><h2>あなたのこと</h2><button className="memory-save" type="submit" disabled={busy||!profileReady||!name.trim()}>{busy?"保存中…":"保存する"}</button></div>
 <fieldset disabled={busy||!profileReady}>
 <div className="memory-profile-card">
 <label className="memory-profile-row"><User size={22} aria-hidden="true"/><span>名前</span><input aria-label="あなたの名前" value={name} maxLength={20} autoComplete="name" onChange={e=>setName(e.target.value)}/></label>
 <label className="memory-profile-row"><Briefcase size={22} aria-hidden="true"/><span>仕事</span><input aria-label="職業" value={personal.occupation} maxLength={120} placeholder="未設定" onChange={e=>setPersonal({...personal,occupation:e.target.value})}/></label>
 <button type="button" className="memory-profile-row" onClick={()=>setHome(true)}><MapPin size={22} aria-hidden="true"/><span>地域</span><span className="memory-profile-value">{region||settings?.home?.label||'未設定'}</span><CaretRight size={18}/></button>
 </div>
 {!onSaveProfile&&<details className="memory-more"><summary>呼び方・好みを編集</summary><label>呼び方<input value={personal.nickname} maxLength={20} placeholder="呼んでほしい名前" onChange={e=>setPersonal({...personal,nickname:e.target.value})}/></label><label>プロフィールの詳細<textarea value={personal.details} maxLength={2000} rows={3} placeholder="好きなこと、関心のあることなど" onChange={e=>setPersonal({...personal,details:e.target.value})}/></label><label>返答の好み<textarea value={personal.responsePreferences} maxLength={1000} rows={2} placeholder="短めに、詳しく、など" onChange={e=>setPersonal({...personal,responsePreferences:e.target.value})}/></label></details>}
 </fieldset></form>
 {message&&<p role="status" className="memory-feedback">{message}</p>}
 <div className="memory-section-heading"><h2>覚えていること</h2><button className="memory-manage" onClick={onOpenMemories} disabled={busy}>編集・削除<CaretRight size={16}/></button></div>
 <div className="memory-list-card">
 {memoryState==='loading'?<p className="memory-empty" role="status">読み込み中…</p>:memoryState==='error'?<p className="memory-empty" role="alert">記憶を読み込めませんでした。編集・削除から開き直せます。</p>:memories.length===0?<p className="memory-empty">覚えたことが、ここに並びます。</p>:<ul>{memories.slice(0,5).map(memory=><li key={memory.id}><button onClick={onOpenMemories} disabled={busy}><NotePencil size={22} aria-hidden="true"/><span>{memory.sensitivity==='sensitive'?'非表示の記憶':memory.content}</span><CaretRight size={16}/></button></li>)}</ul>}
 {memories.length>5&&<button className="memory-see-all" onClick={onOpenMemories}>すべて見る（{memories.length}件）</button>}
 </div>
 <div className="memory-toggle-row"><div><strong>会話から覚える</strong><p>会話をもとに、あなたのことを覚えます。</p></div><button role="switch" aria-checked={enabled===true} aria-label="会話から覚える" disabled={busy||enabled===null} onClick={()=>void toggle()}><span/></button></div>
 <p className="memory-help">オフにしても、保存した記憶は消えません。</p>
 </div></MenuPage>;
}
