import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,linkSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function string(value,max=4096){if(typeof value!=='string'||!value.trim()||value.length>max||/[\r\n\0"\\]/.test(value))throw Error('入力内容を確認してください。');return value.trim();}
function key(value){return string(value);}
export function validate(group,data){
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('入力内容を確認してください。');
  if(group==='ai'){
    const apiKey=key(data.apiKey);if(!/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey))throw Error('OpenAIのAPIキーを確認してください。');
    return {apiKey};
  }
  if(group==='storage'){
    const url=new URL(string(data.url));
    if(!/^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(url.href))throw Error('SupabaseのプロジェクトURLを入力してください。');
    const origin=new URL(string(data.origin));
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('アプリを開くHTTPSのURLを入力してください。');
    const email=string(data.email,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('ログインに使うメールアドレスを確認してください。');
    return {url:url.origin,publishableKey:key(data.publishableKey),serviceKey:key(data.serviceKey),origin:origin.origin,email};
  }
  throw Error('設定項目を確認してください。');
}

export async function checkConnection(group,value,fetcher=fetch){
  const request=async(url,headers)=>{
    const response=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
    await response.body?.cancel();
    if(!response.ok)throw Error('接続を確認できませんでした。キー・サービスの状態・準備手順を確認してください。');
  };
  if(group==='ai'){
    // Model metadata only: no generated content and no conversation is sent.
    await request('https://api.openai.com/v1/models/gpt-5.6-luna',{Authorization:`Bearer ${value.apiKey}`});
  }else{
    await request(`${value.url}/auth/v1/settings`,{apikey:value.publishableKey});
    for(const table of ['profiles','memories','chat_snapshots'])await request(`${value.url}/rest/v1/${table}?select=*&limit=0`,{apikey:value.serviceKey,Authorization:`Bearer ${value.serviceKey}`});
  }
}

export function saveConfiguration(target,ai,storage,voice,google={enabled:false}){
  const values={ZUNDAMON_OPENAI_API_KEY:ai.apiKey,ZUNDAMON_SUPABASE_URL:storage.url,ZUNDAMON_SUPABASE_PUBLISHABLE_KEY:storage.publishableKey,ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY:storage.serviceKey,ZUNDAMON_ALLOWED_EMAIL:storage.email,ZUNDAMON_ALLOWED_ORIGIN:storage.origin};
  if(voice?.provider==='sakura'){values.ZUNDAMON_SAKURA_AI_API_KEY=key(voice.apiKey);values.ZUNDAMON_DEFAULT_VOICE_PROVIDER='sakura';}
  else if(voice?.provider!=='ttsquest'&&voice?.provider!=='later')throw Error('音声サービスを確認してください。');
  if(google.enabled===true){
    const clientId=string(google.clientId),clientSecret=key(google.clientSecret);
    if(!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)||google.prepared!==true)throw Error('Googleのクライアント情報と準備を確認してください。');
    Object.assign(values,{ZUNDAMON_GOOGLE_OAUTH_CLIENT_ID:clientId,ZUNDAMON_GOOGLE_OAUTH_CLIENT_SECRET:clientSecret,ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_B64:randomBytes(32).toString('base64'),ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_VERSION:'v1',ZUNDAMON_GOOGLE_DRIVE_ENABLED:'true',ZUNDAMON_GMAIL_ENABLED:'true',ZUNDAMON_GOOGLE_CALENDAR_WRITE_ENABLED:'true'});
  }
  // An existing file (including a symlink) is never replaced. Publish atomically.
  const temp=target+'.setup-'+randomBytes(12).toString('hex');
  try{
    writeFileSync(temp,Object.entries(values).map(([name,value])=>`${name}="${string(value)}"`).join('\n')+'\n',{mode:0o600,flag:'wx'});
    linkSync(temp,target);
  }finally{if(existsSync(temp))unlinkSync(temp);}
}

export async function startSetup({target=resolve(root,'.env.connection.local'),preview=false,fetcher=fetch}={}){
  const nonce=randomBytes(32).toString('hex'),checked=new Map();let origin='',busy=false,finished=false;
  const server=createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const send=(status,value)=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(req.headers.host!==new URL(origin).host||!req.url?.startsWith('/'+nonce+'/'))return send(403,{error:'この初期設定リンクは無効です。'});
    const route=req.url.slice(nonce.length+2);
    if(req.method==='GET'&&['','setup.js','setup.css'].includes(route)){
      const file=route||'index.html',type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';
      res.writeHead(200,{...headers,'Content-Type':type+'; charset=utf-8'});res.end(readFileSync(resolve(root,'scripts/setup-ui',file)));return;
    }
    if(req.method==='GET'&&route==='status')return send(200,{configured:existsSync(target),preview,finished});
    if(req.method!=='POST'||!['check','save'].includes(route))return send(404,{error:'見つかりません。'});
    if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return send(403,{error:'この画面から操作してください。'});
    if(preview)return send(409,{error:'これはプレビューです。接続・保存は行いません。'});
    if(existsSync(target)||finished)return send(409,{error:'設定済みです。既存の設定は変更していません。'});
    if(busy)return send(409,{error:'接続確認が終わるまでお待ちください。'});
    busy=true;
    try{
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>20000)throw Error('入力が長すぎます。');}
      const data=JSON.parse(body);
      if(route==='check'){
        const value=validate(data.group,data.value);checked.delete(data.group);
        await checkConnection(data.group,value,fetcher);checked.set(data.group,fingerprint(value));
        return send(200,{ok:true});
      }
      const ai=validate('ai',data.ai),storage=validate('storage',data.storage);
      if(checked.get('ai')!==fingerprint(ai)||checked.get('storage')!==fingerprint(storage))throw Error('変更した設定の接続確認を行ってください。');
      if(data.prepared!==true)throw Error('保存先とログインの準備を確認してください。');
      saveConfiguration(target,ai,storage,data.voice,data.google);finished=true;checked.clear();return send(200,{ok:true});
    }catch(error){
      const known=error instanceof Error&&/[。]$/.test(error.message);
      send(400,{error:known?error.message:'設定できませんでした。入力と接続先を確認してください。'});
    }finally{busy=false;}
  });
  server.requestTimeout=20000;server.headersTimeout=15000;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  return {server,url:`${origin}/${nonce}/`};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {server,url}=await startSetup({preview:process.argv.includes('--preview')});
  console.log(`初期設定を開いてください: ${url}\n終了するには Ctrl+C`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
}
