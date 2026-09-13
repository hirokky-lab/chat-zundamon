import { describe, expect, it } from 'vitest';
import { buildSyncApp, loadSyncConfig } from '../src/sync-app';

const env = {
  ZUNDAMON_SUPABASE_URL: 'https://dedicated.supabase.co',
  ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: 'public-test',
  ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY: 'server-secret-test',
  ZUNDAMON_ALLOWED_EMAIL: 'owner@example.com',
  ZUNDAMON_ALLOWED_ORIGIN: 'https://private.example',
};
describe('dedicated sync service', () => {
  it('routes Codex answers independently of the chat AI key and retains authentication and origin checks', async () => {
    const app = buildSyncApp(loadSyncConfig({...env, ZUNDAMON_CODEX_ENABLED:'true'}), {
      authVerifier:{verify:async token=>token==='owner'?{userId:'owner',email:'owner@example.com',accessToken:token}:null},
    });
    const request = {method:'POST' as const, url:'/api/codex/jobs/test-request/answer', payload:{pendingId:'00000000-0000-4000-8000-000000000001',answers:{'0':'緑'}}};
    try {
      expect((await app.inject(request)).statusCode).toBe(401);
      expect((await app.inject({...request,headers:{authorization:'Bearer owner',origin:'https://other.example'}})).statusCode).toBe(403);
      const answer = await app.inject({...request,headers:{authorization:'Bearer owner',origin:env.ZUNDAMON_ALLOWED_ORIGIN}});
      expect(answer.statusCode).toBe(409);
      expect(answer.json()).toEqual({error:'request_expired'});
    } finally {await app.close();}
  });
  it('requires dedicated credentials and an owner but no AI key', () => {
    expect(loadSyncConfig(env).allowedEmail).toBe('owner@example.com');
    expect(() => loadSyncConfig({})).toThrow();
    expect(() => loadSyncConfig({...env, ZUNDAMON_ALLOWED_EMAIL: ''})).toThrow();
  });
  it('protects saved data, exposes only public config, and refuses AI requests', async () => {
    const app = buildSyncApp(loadSyncConfig(env), {
      authVerifier: {verify: async token => token === 'owner' ? {userId:'owner',email:'owner@example.com',accessToken:token} : null},
      profileRepository: {get: async () => null, save: async () => {throw new Error('unused');}},
    });
    try {
      expect(app.externalTools.flags().web_search).toBe(true);
      expect((await app.inject('/api/profile')).statusCode).toBe(401);
      expect((await app.inject('/api/ai-connection')).statusCode).toBe(401);
      const ai=await app.inject({url:'/api/ai-connection',headers:{authorization:'Bearer owner'}});
      expect(ai.statusCode).toBe(200);expect(ai.json().configured).toBe(false);
      const profile = await app.inject({url:'/api/profile',headers:{authorization:'Bearer owner'}});
      expect(profile.json()).toEqual({profile:null});
      const config = await app.inject('/api/browser-config');
      expect(config.statusCode).toBe(200);
      expect(config.body).not.toContain('server-secret');
      expect(config.body).not.toContain('owner@example.com');
      for(const url of ['/api/chat','/api/chat/transcriptions','/api/memory/process','/api/realtime/session','/api/cron/backup']) {
        const response = await app.inject({method:'POST',url,headers:{authorization:'Bearer owner'}});
        expect(response.statusCode).toBe(503);
      }
    } finally { await app.close(); }
  });
  it('enables authenticated chat, memory and photos with the dedicated AI key', async () => {
    const app = buildSyncApp(loadSyncConfig({...env,ZUNDAMON_OPENAI_API_KEY:'test-key'}), {
      authVerifier:{verify:async token=>token==='owner'?{userId:'owner',email:'owner@example.com',accessToken:token}:null},
      profileRepository:{get:async()=>null,save:async()=>{throw new Error('unused');}},
    });
    try {
      expect((await app.inject({method:'POST',url:'/api/chat/responses',payload:{}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/chat/responses',headers:{authorization:'Bearer owner'},payload:{}})).statusCode).toBe(400);
      expect((await app.inject({method:'POST',url:'/api/realtime/session',headers:{authorization:'Bearer owner'}})).statusCode).toBe(503);
      expect((await app.inject('/api/browser-config')).body).not.toContain('test-key');
      expect((await app.inject('/api/browser-config')).json().photoAnalysisEnabled).toBe(true);
      for (const url of ['/api/memory/process','/api/photo-responses','/api/chat/transcriptions']) {
        expect((await app.inject({method:'POST',url,payload:{}})).statusCode).toBe(401);
        const response = await app.inject({method:'POST',url,headers:{authorization:'Bearer owner'},payload:{}});
        expect([400,415]).toContain(response.statusCode);
      }
    } finally {await app.close();}
  });

});

describe('calendar connection configuration', () => {
  const configured = {...env,
    ZUNDAMON_GOOGLE_OAUTH_CLIENT_ID:'calendar-client',
    ZUNDAMON_GOOGLE_OAUTH_CLIENT_SECRET:'calendar-secret',
    ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_B64:Buffer.alloc(32,7).toString('base64'),
    ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_VERSION:'v1'};
  it('loads only complete dedicated OAuth configuration', () => {
    expect(loadSyncConfig(configured).googleOAuth?.redirectUri).toBe('https://private.example/api/google-calendar-tasks/callback');
    expect(loadSyncConfig({...configured,ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_B64:'bad'}).googleOAuth).toBeUndefined();
  });
  it('requires authentication and keeps Tasks and write scopes unavailable', async () => {
    const app=buildSyncApp(loadSyncConfig(configured), {
      authVerifier:{verify:async token=>token==='owner'?{userId:'owner',email:'owner@example.com',accessToken:token}:null},
    });
    try {
      expect((await app.inject('/api/google-calendar-tasks/status')).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/google-calendar-tasks/calendar/connect',payload:{}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url:'/api/google-calendar-tasks/tasks/connect',headers:{authorization:'Bearer owner'},payload:{}})).statusCode).toBe(503);
      expect((await app.inject({method:'POST',url:'/api/google-calendar-tasks/calendar/connect',headers:{authorization:'Bearer owner'},payload:{purpose:'write'}})).statusCode).toBe(409);
      const publicConfig=await app.inject('/api/browser-config');
      expect(publicConfig.body).not.toContain('calendar-secret');
      expect((await app.inject('/api/google-calendar-tasks/callback')).statusCode).toBe(404);
    } finally {await app.close();}
  });
});

it('allows the configured owner through the actual call and usage routes, while blocking unconfigured AI', async () => {
  for (const configured of [false,true]) {
    const app=buildSyncApp(loadSyncConfig({...env,...(configured?{ZUNDAMON_OPENAI_API_KEY:'test-key'}:{})}),{
      authVerifier:{verify:async token=>token==='owner'?{userId:'owner',email:'owner@example.com',accessToken:token}:null},
      profileRepository:{get:async()=>null,save:async()=>{throw Error('unused');}},
    });
    try {
      const call={method:'POST' as const,url:'/api/realtime/calls',headers:{'content-type':'application/sdp'},payload:'test offer'};
      expect((await app.inject(call)).statusCode).toBe(401);
      const result=await app.inject({...call,headers:{...call.headers,authorization:'Bearer owner'}});
      expect(result.statusCode).toBe(configured?409:503);
      const usage=await app.inject({method:'POST',url:'/api/usage',headers:{authorization:'Bearer owner'},payload:{}});
      expect(usage.statusCode).toBe(400);
    } finally {await app.close();}
  }
});
