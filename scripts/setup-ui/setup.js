const form=document.querySelector('#setup'),fields=form.elements;
let step=0,preview=false,checked={ai:false,storage:false};
const value=name=>fields.namedItem(name).value.trim();
const ai=()=>({apiKey:value('aiKey')});
const storage=()=>({url:value('dbUrl'),publishableKey:value('dbPublic'),serviceKey:value('dbSecret'),email:value('email'),origin:value('appUrl')});
const error=message=>document.querySelector('#error').textContent=message;
async function api(route,data){const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;}
function render(){
 document.querySelectorAll('[data-step]').forEach(section=>section.hidden=Number(section.dataset.step)!==step);
 document.querySelectorAll('nav li').forEach((item,index)=>{if(index===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');});
 document.querySelector('#back').hidden=step===0;document.querySelector('#next').hidden=step===4;
 if(step===4){const review=document.querySelector('#review');review.replaceChildren();for(const [title,description] of [['AI','OpenAI'],['保存先','Supabase'],['ログイン',value('email')||'プレビュー'],['声',fields.voice.selectedOptions[0].textContent],['Google連携',value('google')==='configure'?'登録のみ・起動後に接続':'あとで設定']]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=title;dd.textContent=description;review.append(dt,dd);}}
}
function advance(){document.querySelector('#google-callback').textContent=(value('appUrl').replace(/\/$/,'')||'https://your-app.example')+'/api/google-calendar-tasks/callback';error('');if(!preview&&((step===0&&!checked.ai)||(step===1&&(!checked.storage||!fields.prepared.checked)))){error('接続確認と、このページの準備を済ませてください。');return;}if(step===2&&value('voice')==='sakura'&&!value('voiceKey')){error('さくらのAPIキーを入力するか、あとで設定を選んでください。');return;}step++;render();document.querySelector(`[data-step="${step}"] h2`).setAttribute('tabindex','-1');document.querySelector(`[data-step="${step}"] h2`).focus();}
document.querySelector('#next').onclick=advance;
document.querySelector('#back').onclick=()=>{step--;error('');render();};
form.addEventListener('input',event=>{const group=event.target.name==='aiKey'?'ai':['dbUrl','dbPublic','dbSecret','email','appUrl'].includes(event.target.name)?'storage':null;if(group){checked[group]=false;document.querySelector(`#${group}-status`).textContent='';}});
fields.google.addEventListener('change',()=>{document.querySelector('#google-fields').hidden=value('google')!=='configure';});
fields.voice.addEventListener('change',()=>{document.querySelector('#sakura').hidden=value('voice')!=='sakura';document.querySelector('#tts-hint').hidden=value('voice')!=='ttsquest';});
document.querySelectorAll('[data-check]').forEach(button=>button.onclick=async()=>{
 const group=button.dataset.check;error('');button.disabled=true;checked[group]=false;document.querySelector(`#${group}-status`).textContent='接続を確認しています…';
 try{await api('check',{group,value:group==='ai'?ai():storage()});checked[group]=true;document.querySelector(`#${group}-status`).textContent=group==='ai'?'接続できました。実際の会話は起動後に確認できます。':'認証サービスと基本の保存テーブルに接続できました。';}catch(e){document.querySelector(`#${group}-status`).textContent='';error(e.message||'接続を確認できませんでした。');}finally{button.disabled=false;}
});
form.onsubmit=async event=>{event.preventDefault();if(step!==4){advance();return;}const button=form.querySelector('[type=submit]');button.disabled=true;error('');try{await api('save',{ai:ai(),storage:storage(),voice:{provider:value('voice'),apiKey:value('voiceKey')},prepared:fields.prepared.checked,google:{enabled:value('google')==='configure',clientId:value('googleId'),clientSecret:value('googleSecret'),prepared:fields.googlePrepared.checked}});form.reset();form.hidden=true;document.querySelector('nav').hidden=true;document.querySelector('#done').hidden=false;document.querySelector('#done h2').setAttribute('tabindex','-1');document.querySelector('#done h2').focus();}catch(e){error(e.message||'保存できませんでした。');}finally{button.disabled=false;}};
fetch('status').then(r=>{if(!r.ok)throw Error();return r.json();}).then(status=>{preview=status.preview;if(preview)document.querySelector('#notice').textContent='プレビュー：入力不要で各画面を見られます。接続・保存は行いません。';else if(status.configured){document.querySelector('#notice').textContent='この環境は設定済みです。接続情報は変更していません。AI・声・Google連携はアプリの設定から管理できます。';form.hidden=true;document.querySelector('nav').hidden=true;}}).catch(()=>{error('初期設定を読み込めませんでした。起動し直してください。');form.querySelectorAll('button').forEach(b=>b.disabled=true);});
render();
