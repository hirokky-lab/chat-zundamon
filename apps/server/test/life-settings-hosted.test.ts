import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createSupabaseLifeSettingsRepository} from '../src/life-settings.js';
import type {UserClientFactory} from '../src/hosted-repositories.js';
it('binds authenticated client and never accepts an owner parameter in RPC arguments',async()=>{
 const calls:{owner:string;name:string;args:Record<string,unknown>}[]=[];
 const factory=((owner)=>({rpc:async(name,args)=>{calls.push({owner:owner.userId,name,args});return {data:name==='update_life_settings'?null:{revision:0,home:null,calendar:null,tasks:null},error:null};}})) as UserClientFactory;
 const repo=createSupabaseLifeSettingsRepository(factory);const owner={userId:'owner-a',accessToken:'token',email:''};
 await repo.get(owner);await expect(repo.update(owner,{revision:2,home:null,calendar:null,tasks:null})).rejects.toMatchObject({code:'conflict'});
 expect(calls.map(x=>x.owner)).toEqual(['owner-a','owner-a']);expect(calls[1].args).not.toHaveProperty('p_owner_id');
});
it('migration uses authenticated owner scope and atomic revision lock, with no direct write grant',()=>{
 const sql=readFileSync(new URL('../../../supabase/migrations/202609050003_life_settings.sql',import.meta.url),'utf8');
 expect(sql).toContain('owner_id=auth.uid()');expect(sql).toContain('pg_advisory_xact_lock');expect(sql).toContain('for update');
 expect(sql).toContain('enable row level security');expect(sql).not.toMatch(/grant (?:all|insert|update).*to authenticated/i);
 expect(sql).toContain('day_count>=50 or minute_count>=8');
});
