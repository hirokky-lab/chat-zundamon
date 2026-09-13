import {it,expect,vi} from 'vitest';
import {createTalkLifeRouter} from '../src/talk-life-router.js';
import {createUnlimitedCostGuard} from '../src/cost-guard.js';
const owner={userId:'test-owner',email:'test@example.test',accessToken:'fixture'};
const file={id:'doc-a',name:'資料',mimeType:'text/plain'};
function setup({files=[file],text='目的は待ち時間の短縮。方法は予約制。',truncated=false}={}){
 const drive={read:vi.fn().mockResolvedValue({file,text,truncated}),search:vi.fn().mockResolvedValue({files})};
 const summarize=vi.fn().mockResolvedValue('予約制で待ち時間を短くする資料なのだ。');
 const router=createTalkLifeRouter({drive:drive as any,driveSummary:{summarize},settings:{} as any,weather:{} as any,intent:{classify:async()=>({kind:'drive_summary'})},costGuard:createUnlimitedCostGuard(),maximumUsd:.03,chatState:{get:vi.fn().mockResolvedValue({timeline:[{type:'message',role:'assistant',lifeCard:{kind:'drive-results',query:'資料',result:{files}}}]})} as any});
 return {drive,summarize,send:()=>router.respond({owner,text:'この資料を要約して',turns:[],clientMessageId:'summary-test',timeZone:'Asia/Tokyo'})};
}
it('re-reads the owner-authorized selected file, returning a brief reply with its source',async()=>{const t=setup();const result=await t.send();expect(t.drive.read).toHaveBeenCalledWith(owner,'doc-a');expect(t.summarize).toHaveBeenCalledOnce();expect(result?.bubbles[0]?.flow).toBe('external_context');expect(result?.bubbles[0]?.text).toBe('予約制で待ち時間を短くする資料なのだ。');expect(result?.lifeCard).toEqual({kind:'drive-results',query:'資料',result:{files:[file]}});});
it('does not read or summarize an ambiguous selection',async()=>{const t=setup({files:[file,{...file,id:'doc-b'}]});await t.send();expect(t.drive.read).not.toHaveBeenCalled();expect(t.summarize).not.toHaveBeenCalled();});
it('marks partial summaries and avoids hallucinating from empty documents',async()=>{const partial=setup({truncated:true});expect((await partial.send())?.bubbles[0]?.text).toContain('先頭の一部');const empty=setup({text:'  '});expect((await empty.send())?.bubbles[0]?.text).toContain('本文がなかった');expect(empty.summarize).not.toHaveBeenCalled();});
it('does not summarize cached content if current access fails',async()=>{const t=setup();t.drive.read.mockRejectedValueOnce(Error('forbidden'));await t.send();expect(t.summarize).not.toHaveBeenCalled();});
