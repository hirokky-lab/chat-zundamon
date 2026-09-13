import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {WritesApi,WriteInput,WriteView} from './google-writes';
import type {DriveApi} from './google-drive';
import './google-write-editor.css';
export function GoogleWriteEditor({api,initial,driveApi,label}:{api?:WritesApi;initial:WriteInput;driveApi?:DriveApi;label:string}){
 const [open,setOpen]=useState(false),[input,setInput]=useState(initial),[view,setView]=useState<WriteView|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[query,setQuery]=useState(''),[folders,setFolders]=useState<{id:string;name:string}[]>([]),[folderName,setFolderName]=useState('マイドライブ');const lock=useRef(false);
 const dialogRef=useRef<HTMLElement>(null);
 useEffect(()=>{if(!open)return;const previous=document.activeElement as HTMLElement|null;dialogRef.current?.focus();return()=>previous?.focus();},[open]);
 if(!api)return null;
 async function run(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'確認できませんでした。');}finally{lock.current=false;setBusy(false);}}
 async function close(){if(view?.state==='prepared')setView(await api!.cancel(view.id));setOpen(false);}
 const done=view&&view.state!=='prepared';
 return <div className="google-write-editor"><button onClick={()=>{setInput(initial);setOpen(true);}} disabled={open}>{label}</button>{open&&createPortal(<div className="google-write-backdrop google-write-editor" onClick={e=>{if(e.target===e.currentTarget&&!busy)void run(close);}} onKeyDown={e=>{if(e.key==='Tab'){const nodes=Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,a[href]')??[]);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialogRef.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}if(e.key==='Escape'&&!busy){e.stopPropagation();void run(close);}}}><section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={initial.kind==='gmail'?'メール送信の確認':'Drive保存の確認'}>
 <h3>{initial.kind==='gmail'?'メールを送信':'Driveに保存'}</h3>
 {!view?<form onSubmit={e=>{e.preventDefault();void run(async()=>setView(await api.prepare(input)));}}>
 {input.kind==='gmail'?<label>宛先<input type="email" required maxLength={254} value={input.to} onChange={e=>setInput({...input,to:e.target.value})}/></label>:<><p>保存先：{folderName}</p><div className="folder-search"><input aria-label="フォルダを検索" value={query} onChange={e=>setQuery(e.target.value)} placeholder="フォルダ名"/><button type="button" disabled={busy||!query.trim()||!driveApi} onClick={()=>void run(async()=>{const r=await driveApi!.search(query);const f=r.files.filter(f=>f.mimeType==='application/vnd.google-apps.folder');setFolders(f);if(!f.length)setError('フォルダが見つかりませんでした。名前を具体的にしてください。');})}>検索</button></div><button type="button" onClick={()=>{setInput({...input,folderId:'root'});setFolderName('マイドライブ');}}>マイドライブ</button>{folders.map(f=><button type="button" key={f.id} onClick={()=>{setInput({...input,folderId:f.id});setFolderName(f.name);setFolders([]);}}>{f.name}</button>)}</>}
 <label>{input.kind==='gmail'?'件名':'ファイル名'}<input required maxLength={200} value={input.title} onChange={e=>setInput({...input,title:e.target.value})}/></label><label>本文<textarea required maxLength={20000} value={input.body} onChange={e=>setInput({...input,body:e.target.value})}/></label><button disabled={busy} type="submit">内容を確認</button><button type="button" disabled={busy} onClick={()=>setOpen(false)}>閉じる</button></form>:<>
 <p>{view.input.kind==='gmail'?`送信元：${view.from}`:`保存先：${view.location}`}</p>{view.input.kind==='gmail'&&<p>宛先：{view.input.to}</p>}<strong>{view.input.title}</strong><p className="write-body">{view.input.body}</p>
 {view.state==='prepared'&&!uncertain&&<><p>{view.input.kind==='gmail'?'この内容でメールを送信します。':'この内容で新しいテキストファイルを作成します。'}</p><button disabled={busy} onClick={()=>void run(async()=>{setUncertain(true);const v=await api.confirm(view.id);setView(v);setUncertain(false);})}>{view.input.kind==='gmail'?'この内容で送信':'この内容で保存'}</button><button disabled={busy} onClick={()=>void run(async()=>{await api.cancel(view.id);setView(null);})}>戻って編集</button></>}
 {done&&<p role="status">{({executing:'実行結果を確認中です。',succeeded:view.input.kind==='gmail'?'送信しました。':'保存しました。',unknown:'結果を確認できません。再実行せず、Googleの画面で確認してください。',cancelled:'取り消しました。',expired:'確認期限が切れました。'} as Record<string,string>)[view.state]}</p>}
 {(uncertain||view.state==='executing'||view.state==='unknown')&&<button disabled={busy} onClick={()=>void run(async()=>{setView(await api.status(view.id));setUncertain(false);})}>状態を確認</button>}
 {(view.state==='cancelled'||view.state==='expired')&&<button disabled={busy} onClick={()=>{setView(null);setUncertain(false);}}>内容を編集する</button>}
 {view.state==='succeeded'&&view.result&&<a href={view.input.kind==='gmail'?`https://mail.google.com/mail/u/0/#sent/${encodeURIComponent(view.result.id)}`:`https://drive.google.com/file/d/${encodeURIComponent(view.result.id)}/view`} target="_blank" rel="noopener noreferrer">{view.input.kind==='gmail'?'送信したメールを開く':'保存したファイルを開く'} ↗</a>}
 <button disabled={busy} onClick={()=>void run(async()=>{if(view.state==='prepared')setView(await api.cancel(view.id));setOpen(false);})}>閉じる</button></>}
 {error&&<p role="alert">{error}</p>}
 </section></div>,document.body)}</div>;
}
