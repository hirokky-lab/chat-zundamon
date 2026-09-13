import {expect,it} from 'vitest';
import {stageDialogue,stageLinks} from '../src/stage-dialogue';
const message=(id:string,text:string,role:'user'|'assistant'='assistant',replyGroupId?:string)=>({id,type:'message' as const,role,text,createdAt:'2026-09-11T00:00:00.000Z',delivery:'sent' as const,...(replyGroupId?{replyGroupId}: {})});
it('retains the first sentence when later parts arrive in the same response',()=>{
 const first=message('a','ひとつめ','assistant','reply-1');
 expect(stageDialogue([first])).toBe('ひとつめ');
 expect(stageDialogue([first,message('b','ふたつめ','assistant','reply-1')])).toBe('ひとつめ\n\nふたつめ');
});
it('replaces the previous response when the next reply begins',()=>{
 expect(stageDialogue([message('a','前の返事','assistant','r1'),message('u','次の質問','user'),message('b','新しい返事','assistant','r2')])).toBe('新しい返事');
});
it('joins legacy consecutive parts without merging across a user turn',()=>{
 expect(stageDialogue([message('a','前の返事'),message('u','質問','user'),message('b','はい'),message('c','続き')])).toBe('はい\n\n続き');
});

it('shows links only for the current reply and excludes older results',()=>{
 const linked={...message('a','道順なのだ','assistant','r1'),lifeCard:{kind:'maps' as const,origin:null,destination:'東京駅',travelMode:'walking' as const}};
 expect(stageLinks([linked])[0].url).toContain('google.com/maps/dir');
 expect(stageLinks([linked,message('u','ありがとう','user'),message('b','どういたしまして','assistant','r2')])).toEqual([]);
});
