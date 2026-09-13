export type AIStatus={configured:boolean;source:'server'|'personal'|'none';checkedAt:string|null;model:string};
export type AIConnectionApi={status():Promise<AIStatus>;save(key:string):Promise<AIStatus>;test():Promise<AIStatus>;remove():Promise<AIStatus>};
export function createAIConnectionApi(http:typeof fetch):AIConnectionApi{
 async function call(method:string,key?:string){const response=await http('/api/ai-connection',{method,credentials:'same-origin',cache:'no-store',...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(key?{key}:{})})});
 if(!response.ok){const data=await response.json().catch(()=>({}));const messages:Record<string,string>={invalid_key:'APIキーを確認してください。',key_rejected:'このキーでは接続できません。キーや利用権限を確認してください。',quota_or_rate_limit:'利用枠またはリクエスト上限に達しています。OpenAIの利用状況を確認してください。',connection_failed:'接続を確認できませんでした。少し待ってからお試しください。',key_required:'APIキーを入力してください。',storage_unavailable:'設定を保存・読み込みできませんでした。',check_in_progress:'接続確認が終わるまでお待ちください。'};throw Error(messages[data.error]??'接続設定を確認できませんでした。もう一度お試しください。');}return await response.json() as AIStatus;}
 return {status:()=>call('GET'),save:key=>call('PUT',key),test:()=>call('POST'),remove:()=>call('DELETE')};
}
