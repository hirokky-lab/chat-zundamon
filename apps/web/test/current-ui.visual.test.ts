// @vitest-environment node
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

describe('Chatずんだもん current UI acceptance', () => {
  it('keeps search, profile and call transitions usable at compact, phone and desktop sizes', async () => {
    const server = await createServer({root:fileURLToPath(new URL('..',import.meta.url)),logLevel:'silent',server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false}});
    await server.listen();
    const address=server.httpServer!.address(); if(!address || typeof address==='string')throw Error('fixture_server');
    const browser=await chromium.launch({headless:true});
    try {
      for(const width of [320,390,1280]) for(const night of [false,true]) {
        const page=await browser.newPage({viewport:{width,height:width===320?700:844}});
        const external:string[]=[],errors:string[]=[];
        page.on('request',r=>{if(new URL(r.url()).hostname!=='127.0.0.1')external.push(r.url());});
        page.on('pageerror',e=>errors.push(e.message));
        await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/current-ui.fixture.html${night?'?night=1':''}`);
        await page.getByRole('button',{name:'トークを開く',exact:true}).click();
        await page.getByRole('button',{name:'履歴を検索',exact:true}).click();
        await page.getByRole('searchbox').fill('音楽');
        await page.getByText('1 / 1',{exact:true}).waitFor();
        const geometry=await page.locator('.chat-screen').evaluate(el=>{
          const d=el.ownerDocument,w=d.defaultView!;
          const r=d.querySelector('.chat-scroll-area')!.getBoundingClientRect();
          return {width:w.innerWidth,documentWidth:d.documentElement.scrollWidth,historyHeight:r.height,searchHeight:d.querySelector('#talk-history-search')!.getBoundingClientRect().height,composer:getComputedStyle(d.querySelector('.composer-shell')!).visibility,title:getComputedStyle(d.querySelector('.desktop-log-title')!).color};
        });
        expect(geometry.documentWidth).toBe(width);
        expect(geometry.historyHeight).toBeGreaterThan(350);
        expect(geometry.searchHeight).toBeLessThanOrEqual(60);
        expect(geometry.composer).toBe('hidden');
        if(night)expect(geometry.title).toBe('rgb(247, 247, 246)');
        await page.getByRole('button',{name:'検索を閉じる',exact:true}).click();
        expect(await page.locator('.composer-shell').evaluate(el=>getComputedStyle(el).visibility)).toBe('visible');
        await page.getByRole('button',{name:'メニューを開く',exact:true}).click();
        await page.getByRole('button',{name:'プロフィール',exact:true}).click();
        const save=page.getByRole('button',{name:'保存する',exact:true});
        await save.waitFor();
        expect(await save.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        await page.getByRole('button',{name:'閉じてホームへ戻る',exact:true}).click();
        await page.getByRole('button',{name:'ライブチャットを開始',exact:true}).click();
        await page.getByText('聞いています',{exact:true}).waitFor();
        await page.locator('details.transcript > summary').click();
        await page.getByRole('button',{name:'ライブチャットを終了',exact:true}).click();
        await page.getByRole('button',{name:'トークを開く',exact:true}).waitFor();
        expect(await page.locator('.talk-avatar').isVisible()).toBe(true);
        expect(errors).toEqual([]); expect(external).toEqual([]);
        await page.close();
      }
    } finally {await browser.close();await server.close();}
  },180_000);
});
