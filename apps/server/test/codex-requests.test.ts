import { describe, expect, it } from 'vitest';
import { prepareRequest } from '../src/codex/requests';
import { namedProject, readProjects } from '../src/codex/projects';
const request=(method:string,params:unknown)=>prepareRequest({id:12,method,params})!;
describe('Codex confirmation relay',()=>{
 it('only allows offered command decisions and preserves their exact payload',()=>{
  const decision={acceptWithExecpolicyAmendment:{execpolicy_amendment:['npm','test']}};
  const pending=request('item/commandExecution/requestApproval',{command:'npm test',availableDecisions:['decline',decision]});
  expect(pending.view.details).toContain('npm test');
  expect(()=>pending.answer({choice:'accept'})).toThrow();
  expect(pending.answer({choice:'1'})).toEqual({decision});
 });
 it('shows file changes before a decision and only grants the requested permissions',()=>{
  const file=prepareRequest({id:1,method:'item/fileChange/requestApproval',params:{reason:'修正'}},{changes:[{path:'sum.mjs',diff:'- a-b\n+ a+b'}]})!;
  expect(file.view.details).toContain('a+b');
  const permissions={fileSystem:{write:['/tmp/example']}};
  const pending=request('item/permissions/requestApproval',{permissions});
  expect(pending.answer({choice:'accept',answers:{path:'/etc'}})).toEqual({permissions,scope:'turn'});
  expect(pending.answer({choice:'decline'})).toEqual({permissions:{},scope:'turn'});
 });
 it('requires every question and retains free text answers',()=>{
  const pending=request('item/tool/requestUserInput',{questions:[{id:'q',question:'対象は？',options:[{label:'A'}]}]});
  expect(()=>pending.answer({answers:{}})).toThrow();
  expect(pending.answer({answers:{q:'B'}})).toEqual({answers:{q:{answers:['B']}}});
 });
 it('relays connector form values and allows declining incomplete forms',()=>{
  const pending=request('mcpServer/elicitation/request',{mode:'form',serverName:'demo',message:'入力',requestedSchema:{properties:{count:{type:'integer'},ready:{type:'boolean'}},required:['count']}});
  expect(()=>pending.answer({choice:'accept',answers:{count:'1.1'}})).toThrow();
  expect(pending.answer({choice:'accept',answers:{count:'2',ready:'true'}})).toEqual({action:'accept',content:{count:2,ready:true}});
  expect(pending.answer({choice:'decline'})).toEqual({action:'decline',content:null});
 });
 it('does not expose executable URLs',()=>{
  expect(()=>request('mcpServer/elicitation/request',{mode:'url',url:'javascript:alert(1)'})).toThrow();
 });
});
describe('native Codex projects',()=>{
 it('loads every page from Codex',async()=>{
  let n=0;const rpc={request:async()=>++n===1?{data:[{id:'1',name:'A',roots:[{path:'/a'}]}],nextCursor:'next'}:{data:[{id:'2',name:'B',roots:[{path:'/b'}]}],nextCursor:null}};
  expect((await readProjects(rpc)).map(p=>p.name)).toEqual(['A','B']);
 });
 it('leaves ambiguous names to Codex and avoids substring matches',()=>{
  const projects=[{id:'1',name:'work',roots:[{path:'/a'}]},{id:'2',name:'work',roots:[{path:'/b'}]}];
  expect(namedProject('workを直して',projects)).toBeUndefined();
  expect(namedProject('networkを直して',[projects[0]])).toBeUndefined();
  expect(namedProject('WORKを直して',[projects[0]])?.id).toBe('1');
 });
});
