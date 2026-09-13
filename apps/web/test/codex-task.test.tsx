import {act, renderHook, waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useCodexTask} from '../src/components/CodexTask';
import type {CodexApi,CodexJob} from '../src/codex';
const job:CodexJob={id:'done',requestId:'request',prompt:'test',status:'completed',message:'完了',result:'結果',createdAt:'2026-09-13',updatedAt:'2026-09-13'};
const api={status:async()=>({enabled:true}),latest:async()=>job} as CodexApi;
beforeEach(()=>{const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});});
afterEach(()=>vi.unstubAllGlobals());
it('keeps dismissed results hidden after remount and restores only for a new job',async()=>{
 const first=renderHook(()=>useCodexTask(api,'owner'));
 act(()=>first.result.current.onJob(job));
 act(()=>first.result.current.dismiss());
 expect(first.result.current.visibleJob).toBeNull();first.unmount();
 const second=renderHook(()=>useCodexTask(api,'owner'));
 await act(async()=>{});
 expect(second.result.current.visibleJob).toBeNull();
 act(()=>second.result.current.onJob({...job,id:'new',status:'working'}));
 expect(second.result.current.visibleJob?.id).toBe('new');second.unmount();
});
it('retires a completed card on the next turn but keeps running work visible',async()=>{
 const hook=renderHook(()=>useCodexTask(api,'owner'));
 act(()=>hook.result.current.onJob(job));
 act(()=>hook.result.current.dismiss());expect(hook.result.current.visibleJob).toBeNull();
 act(()=>hook.result.current.onJob({...job,id:'working',status:'working'}));
 act(()=>hook.result.current.dismiss());expect(hook.result.current.visibleJob?.id).toBe('working');hook.unmount();
});

it.each(['completed','cancelled','failed'] as const)('does not revive a historical %s card on a fresh installation',async(status)=>{
 const latest=vi.fn(async()=>({...job,status}));
 const restored={...api,latest};
 const hook=renderHook(()=>useCodexTask(restored,'fresh-install'));
 await waitFor(()=>expect(latest).toHaveBeenCalled());
 await act(async()=>{});
 expect(hook.result.current.job).toBeNull();
 expect(hook.result.current.visibleJob).toBeNull();
 hook.unmount();
});
it.each(['working','waiting'] as const)('restores %s work and shows its completion during this session',async(status)=>{
 const running={...job,status,result:undefined};
 const restored={...api,latest:async()=>running};
 const hook=renderHook(()=>useCodexTask(restored,'owner'));
 await waitFor(()=>expect(hook.result.current.visibleJob?.status).toBe(status));
 act(()=>hook.result.current.onJob(job));
 expect(hook.result.current.visibleJob?.status).toBe('completed');
 act(()=>hook.result.current.dismiss());expect(hook.result.current.visibleJob).toBeNull();
 hook.unmount();
});
it('allows an explicitly requested historical result to be shown after a clean startup',async()=>{
 const hook=renderHook(()=>useCodexTask(api,'fresh-install'));
 await act(async()=>{});
 expect(hook.result.current.visibleJob).toBeNull();
 act(()=>hook.result.current.onJob(job));
 expect(hook.result.current.visibleJob?.result).toBe('結果');
 hook.unmount();
});
it('does not replace a new request with a delayed startup restore',async()=>{
 let resolve!:(job:CodexJob)=>void;
 const latest=vi.fn(()=>new Promise<CodexJob>(done=>{resolve=done}));
 const restored={...api,latest};
 const hook=renderHook(()=>useCodexTask(restored,'owner'));
 await waitFor(()=>expect(latest).toHaveBeenCalled());
 act(()=>hook.result.current.onJob({...job,id:'new-request',status:'working'}));
 await act(async()=>resolve({...job,status:'working'}));
 expect(hook.result.current.visibleJob?.id).toBe('new-request');
 hook.unmount();
});
