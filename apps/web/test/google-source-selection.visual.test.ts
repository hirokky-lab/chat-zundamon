// @vitest-environment node
import { chromium } from "playwright";
import { createServer } from "vite";
import { describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("Google source selection mobile UI", () => {
  it("selects a work calendar and a non-default task list without overflow or external traffic", async () => {
    const server = await createServer({root:fileURLToPath(new URL("..", import.meta.url)),configFile:false,appType:"mpa",logLevel:"silent",server:{host:"127.0.0.1",port:0,hmr:false}});
    await server.listen();
    const address = server.httpServer!.address(); if (!address || typeof address === "string") throw Error("server");
    const browser = await chromium.launch({headless:true});
    try {
      const page = await browser.newPage({viewport:{width:390,height:844}});
      const external:string[]=[];
      page.on("request", r=> {if(new URL(r.url()).hostname!=="127.0.0.1") external.push(r.url());});
      await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/smartphone-practical.fixture.html?config=${encodeURIComponent(JSON.stringify({page:"home",style:"yui",scale:"normal"}))}`);
      for (const [label, service] of [["予定表","Googleカレンダー"],["タスクリスト","Google Tasks"]]) {
        await page.getByRole("button",{name:`表示する${label}を選ぶ`}).click();
        await page.getByRole("combobox",{name:`表示する${label}`,exact:true}).selectOption("work-source");
        await page.getByRole("button",{name:`${service}の内容を見る`}).click();
      }
      await page.getByRole("list",{name:"タスクの内容"}).waitFor();
      expect(await page.getByText("表示元：仕事",{exact:true}).count()).toBe(2);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
      expect(external).toEqual([]);
      mkdirSync(fileURLToPath(new URL("../../../test-results/google-source-selection/",import.meta.url)),{recursive:true});
      await page.screenshot({path:fileURLToPath(new URL("../../../test-results/google-source-selection/home.png",import.meta.url)),fullPage:true});
    } finally { await browser.close(); await server.close(); }
  },30000);
});
