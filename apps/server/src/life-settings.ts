import { containsForbiddenSecret } from "../../../packages/domain/src/secret.js";
import { emptyLifeSettings,isLifeSettings,type LifeSettings } from '../../../packages/domain/src/life-settings.js';
import type { RequestUser } from './request-user.js';
import type { UserClientFactory } from './hosted-repositories.js';
export class LifeServiceError extends Error {
 constructor(public readonly code:'invalid_request'|'conflict'|'unavailable'|'home_required'|'quota_exceeded') {super('Life service request could not be completed');}
}
export interface LifeSettingsRepository {get(owner:RequestUser):Promise<LifeSettings>;update(owner:RequestUser,input:LifeSettings):Promise<LifeSettings>;}
export type LifeSettingsService=ReturnType<typeof createLifeSettingsService>;
export function createLifeSettingsService(repository:LifeSettingsRepository) {
 return {
  async get(owner:RequestUser) {if(!owner.userId)throw new LifeServiceError('unavailable');return repository.get(owner);},
  async update(owner:RequestUser,input:unknown) {if(!owner.userId)throw new LifeServiceError('unavailable');if(!isLifeSettings(input)||input.personal&&Object.values(input.personal).some(containsForbiddenSecret))throw new LifeServiceError('invalid_request');return repository.update(owner,input);},
 };
}
/** Local fixture repository only. Hosted runtime uses the owner-authenticated RPCs. */
export function createInMemoryLifeSettingsRepository():LifeSettingsRepository {
 const rows=new Map<string,LifeSettings>();
 return {async get(o){return structuredClone(rows.get(o.userId)??emptyLifeSettings());},async update(o,input){
 const current=rows.get(o.userId)??emptyLifeSettings();if(current.revision!==input.revision)throw new LifeServiceError('conflict');
 const next=structuredClone({...input,...(!('personal' in input)&&current.personal?{personal:current.personal}:{}),revision:input.revision+1});rows.set(o.userId,next);return structuredClone(next);
 }};
}
export function createSupabaseLifeSettingsRepository(createUserClient:UserClientFactory):LifeSettingsRepository {
 const invoke=async(o:RequestUser,name:string,args:Record<string,unknown>)=>{
  const {data,error}=await createUserClient(o).rpc(name,args);
  if(error)throw new LifeServiceError('unavailable');
  if(data===null&&name==='update_life_settings')throw new LifeServiceError('conflict');
  if(!isLifeSettings(data))throw new LifeServiceError('unavailable');return data;
 };
 return {get:o=>invoke(o,'get_life_settings',{}),update:(o,input)=>invoke(o,'update_life_settings',{p_expected_revision:input.revision,p_settings:input})};
}
