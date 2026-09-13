import {describe, it, expect} from 'vitest';
import Fastify from 'fastify';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerBgm} from '../src/bgm';
import {registerAuthentication} from '../src/auth';
describe('private installed BGM',()=>{
  it('requires owner authentication, permits only catalog tracks, and does not publicly cache audio',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'zundamon-bgm-'));
    const app=Fastify();app.decorateRequest('yuiUser');
    registerAuthentication(app,{allowedOrigin:'https://private.example',verifier:{verify:async token=>token==='owner'?{userId:'owner',email:'owner@example.com',accessToken:token}:null}});
    registerBgm(app,dir);
    try{
      await writeFile(join(dir,'hiru.mp3'),Buffer.from('ID3test-fixture'));
      expect((await app.inject('/api/bgm/hiru')).statusCode).toBe(401);
      const headers={authorization:'Bearer owner'};
      const result=await app.inject({url:'/api/bgm/hiru',headers});expect(result.statusCode).toBe(200);expect(result.headers['content-type']).toBe('audio/mpeg');expect(result.headers['cache-control']).toBe('private, no-store');
      expect((await app.inject({url:'/api/bgm/jitaku',headers})).statusCode).toBe(404);
      for(const track of ['kaeru','jitaku']) {await writeFile(join(dir,track+'.mp3'),Buffer.from('fixture'));expect((await app.inject({url:'/api/bgm/'+track,headers})).statusCode).toBe(200);}
      expect((await app.inject({url:'/api/bgm/secret',headers})).statusCode).toBe(404);
    }finally{await app.close();await rm(dir,{recursive:true,force:true});}
  });
});
