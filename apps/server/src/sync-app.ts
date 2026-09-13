import {isBgmTrack} from '@yui/domain';
import {registerBgm} from './bgm.js';
import { CodexJobs } from './codex/jobs.js';
import { registerCodex } from './codex/routes.js';
import { createOpenAIWebSearchGateway } from "./web-search.js";
import { createOpenAITranscriptionGateway } from "./transcription.js";
import {createOpenAIRealtimeGateway} from "./realtime.js";
import {createTtsQuestGateway} from './ttsquest.js';
import {createVoiceConnection} from './voice-connection.js';
import {createSakuraSpeechGateway} from './sakura-speech.js';
import {fileURLToPath} from 'node:url';
import {AIKeyStore,createDynamicAI,registerAIConnection} from './ai-connection.js';
import {createGoogleWrites} from './google-writes.js';
import {createGmailService} from './gmail.js';
import {createOpenAIGmailAssistant} from './gmail-assistant.js';
import {createOpenAIDriveSummaryGateway} from './drive-summary.js';
import {createClient} from '@supabase/supabase-js';
import {createGoogleDriveService} from './google-drive.js';
import { createOpenAITalkLifeIntentGateway } from './talk-life-intent.js';
import { hostedGoogleOAuth } from './config.js';
import { createSupabaseGoogleCalendarTasksConnectionRepository, createSupabaseGoogleCalendarTasksQuotaRepository } from './google-calendar-tasks.js';
import { createHostedLifeServices } from './life-settings-hosted.js';
import { createOpenAIChatGateway } from './chat.js';
import { createOpenAIMemoryExtractor } from './memory-extractor.js';
import { AuthoritativeMemoryTurnSource } from './memory-turn-source.js';
import { createSupabasePhotoServiceClient } from './supabase-client.js';
import { createSupabasePhotoRepository } from './photo-repository.js';
import { createSupabasePhotoStorage } from './photo-storage.js';
import { createOpenAIPhotoAnalysisGateway } from './photo.js';
import { ALL_EXTERNAL_TOOLS_OFF } from './external-tools.js';
import { z } from 'zod';
import { buildApp, createHostedGoogleRuntime, type BuildAppOptions } from './app.js';
import { createSupabaseAuthVerifier } from './auth.js';
import { createSupabaseAuthClient, createSupabaseUserClientFactory, createSupabaseServiceMutationClientFactory } from './supabase-client.js';
import { createSupabaseProfileRepository, createSupabaseMemoryRepository, createSupabaseChatStateRepository, createSupabaseMemorySettingsRepository } from './hosted-repositories.js';
import { createSupabaseVisualStylePreferenceRepository } from './visual-style-preferences.js';

const origin = z.url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
});
const schema = z.object({
  supabaseUrl: origin,
  supabasePublishableKey: z.string().min(1),
  supabaseServiceRoleKey: z.string().min(1),
  allowedEmail: z.email().transform(value => value.toLowerCase()),
  allowedOrigin: origin,
  openaiApiKey: z.string().min(1).optional(),
});
export function loadSyncConfig(env: Record<string,string|undefined> = process.env) {
  return { ...schema.parse({
    supabaseUrl: env.ZUNDAMON_SUPABASE_URL,
    supabasePublishableKey: env.ZUNDAMON_SUPABASE_PUBLISHABLE_KEY,
    supabaseServiceRoleKey: env.ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY,
    allowedEmail: env.ZUNDAMON_ALLOWED_EMAIL,
    allowedOrigin: env.ZUNDAMON_ALLOWED_ORIGIN,
    openaiApiKey: env.ZUNDAMON_OPENAI_API_KEY || undefined,
  }), codexEnabled: env.ZUNDAMON_CODEX_ENABLED === "true", codexBinary: env.ZUNDAMON_CODEX_BINARY?.trim() || "codex", defaultVoiceProvider:env.ZUNDAMON_DEFAULT_VOICE_PROVIDER==='sakura'?'sakura' as const:'ttsquest' as const, sakuraAiApiKey:env.ZUNDAMON_SAKURA_AI_API_KEY?.trim()||undefined, googleAssistantWrite:{calendar:env.ZUNDAMON_GOOGLE_CALENDAR_WRITE_ENABLED==='true',tasks:false}, gmailEnabled:env.ZUNDAMON_GMAIL_ENABLED==='true', driveEnabled:env.ZUNDAMON_GOOGLE_DRIVE_ENABLED==='true', googleOAuth: hostedGoogleOAuth(env, env.ZUNDAMON_ALLOWED_ORIGIN) };
}

// Owner-scoped storage with optional AI and separately configured read-only Calendar access.
export function buildSyncApp(config: ReturnType<typeof loadSyncConfig>, overrides: Pick<BuildAppOptions,'authVerifier'|'profileRepository'> = {}) {
  const keyStore=new AIKeyStore(fileURLToPath(new URL('../../../data/ai-connection/',import.meta.url)),config.openaiApiKey);
  const ai=createDynamicAI(keyStore);
  const voice=createVoiceConnection({directory:fileURLToPath(new URL('../../../data/voice-connection/',import.meta.url)),owner:()=>ai.context.getStore(),origin:config.allowedOrigin,defaultProvider:config.defaultVoiceProvider,ttsquest:createTtsQuestGateway(),sakura:config.sakuraAiApiKey?createSakuraSpeechGateway({apiKey:config.sakuraAiApiKey}):undefined});
  const factory = createSupabaseUserClientFactory(config.supabaseUrl, config.supabasePublishableKey);
  const mutations = createSupabaseServiceMutationClientFactory(config.supabaseUrl, config.supabaseServiceRoleKey);
  const chatStateRepository = createSupabaseChatStateRepository(factory,mutations);
  const externalToolFlags = {...ALL_EXTERNAL_TOOLS_OFF,web_search:true,photo_analysis:true,calendar_read:!!config.googleOAuth};
  const google = createHostedGoogleRuntime({...config,externalToolFlags}, mutations);
  const driveClient=createClient(config.supabaseUrl,config.supabaseServiceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const drive=config.driveEnabled&&config.googleOAuth?createGoogleDriveService({...config.googleOAuth,key:config.googleOAuth.tokenKey,rpc:async(owner,operation,args)=>{const r=await driveClient.rpc('server_drive_rpc',{p_owner_id:owner||null,p_operation:operation,p_args:args});if(r.error)throw Error('drive_repository_unavailable');return r.data;}}):undefined;
  const gmail=config.gmailEnabled&&config.googleOAuth?createGmailService({...config.googleOAuth,key:config.googleOAuth.tokenKey,rpc:async(owner,operation,args)=>{const r=await driveClient.rpc('server_gmail_rpc',{p_owner_id:owner||null,p_operation:operation,p_args:args});if(r.error){console.warn('gmail_repository_code:'+String(r.error.code).replace(/[^A-Z0-9_]/g,''));throw Error('gmail_repository_unavailable');}return r.data;}}):undefined;
  const googleWrites=config.googleOAuth?createGoogleWrites({gmail,drive,key:config.googleOAuth.tokenKey,rpc:async(owner,operation,args)=>{const r=await driveClient.rpc('server_google_write_rpc',{p_owner_id:owner,p_operation:operation,p_args:args});if(r.error)throw Error('write_repository_unavailable');return r.data;}}):undefined;
  const app = buildApp({googleWrites,
    codexEnabled: config.codexEnabled,
    realtimeGateway: ai.gateway(key => createOpenAIRealtimeGateway({apiKey:key})),
    realtimeModel: "gpt-realtime-2.1-mini",
    sakuraSpeechGateway:voice.gateway,
    gmail, gmailAssistant:gmail?ai.gateway(key=>createOpenAIGmailAssistant(key,'gpt-5.6-luna')):undefined,
    drive,
    driveSummary:drive ? ai.gateway(key=>createOpenAIDriveSummaryGateway(key,'gpt-5.6-luna')) : undefined,
    googleAssistant:google?.assistant,
    lifeIntent:google ? ai.gateway(key=>createOpenAITalkLifeIntentGateway(key,'gpt-5.6-luna')) : undefined,
    googleCalendarTasksFactory:google?.factory,
    googleOAuthService:google?.oauth,
    googleCalendarTasksPreviewGateway:google?.previewGateway,
    googleCalendarTasksConnectionRepository:createSupabaseGoogleCalendarTasksConnectionRepository(mutations),
    googleCalendarTasksQuotaRepository:createSupabaseGoogleCalendarTasksQuotaRepository(mutations),
    logger: false,
    lifeServices: createHostedLifeServices({createUserClient:factory}),
    transcriptionGateway: ai.gateway(key=>createOpenAITranscriptionGateway({apiKey:key})),
    webSearchGateway: ai.gateway(key=>createOpenAIWebSearchGateway({apiKey:key,onFailure:failure=>console.warn('web_search_failure',JSON.stringify(failure))})),
    webSearchTimeoutMs: 30_000,
    chatGateway: ai.gateway(key=>createOpenAIChatGateway({apiKey:key})),
    chatModel: "gpt-5.6-luna",
    extractor: ai.gateway(key=>createOpenAIMemoryExtractor({apiKey:key,model:'gpt-5.6-luna'})),
    allowedOrigin: config.allowedOrigin,
    authVerifier: overrides.authVerifier ?? createSupabaseAuthVerifier(createSupabaseAuthClient(config.supabaseUrl,config.supabasePublishableKey),config.allowedEmail),
    browserConfig: {supabaseUrl:config.supabaseUrl,supabasePublishableKey:config.supabasePublishableKey,photoAnalysisEnabled:true,integratedUiEnabled:true,prismEchoEnabled:false},
    externalToolFlags,
    ...{
      photoRepository: createSupabasePhotoRepository(createSupabasePhotoServiceClient(config.supabaseUrl,config.supabaseServiceRoleKey)),
      photoStorage: createSupabasePhotoStorage(config.supabaseUrl,config.supabaseServiceRoleKey),
      photoAnalysisGateway: ai.gateway(key=>createOpenAIPhotoAnalysisGateway({apiKey:key,maxRetries:0})),
    },
    profileRepository: overrides.profileRepository ?? createSupabaseProfileRepository(factory),
    memoryRepository: createSupabaseMemoryRepository(factory,mutations),
    memorySettingsRepository: createSupabaseMemorySettingsRepository(factory,mutations),
    chatStateRepository,
    memoryTurnSource: new AuthoritativeMemoryTurnSource(chatStateRepository),
    memoryPolicyVersion: 'natural-v1',
    visualStylePreferenceRepository: createSupabaseVisualStylePreferenceRepository(factory),
    automaticChatMemoryMode: 'hosted_authoritative_snapshot',
  });
  app.addHook('onRequest',(request,reply,done)=>{
    if(request.yuiUser && request.yuiUser.email.toLowerCase()!==config.allowedEmail){void reply.code(403).send({error:'owner_required'});return;}
    ai.context.run(request.yuiUser?.userId??'',done);
  });
  registerCodex(app, {
    origin: config.allowedOrigin,
    jobs: config.codexEnabled ? new CodexJobs({
      directory: fileURLToPath(new URL('../../../data/codex-jobs/', import.meta.url)),
      project: fileURLToPath(new URL('../../../', import.meta.url)),
      binary: config.codexBinary,
    }) : undefined,
  });
  registerBgm(app, fileURLToPath(new URL('../../../data/bgm/', import.meta.url)));
  voice.register(app);
  registerAIConnection(app,{store:keyStore,allowedOrigin:config.allowedOrigin});
  app.addHook('onRequest',async (request,reply) => {
    if(request.method === 'OPTIONS') return;
    const path = new URL(request.url,'http://localhost').pathname;
    if (path === '/api/codex/status' || path === '/api/codex/jobs' || /^\/api\/codex\/jobs\/[a-zA-Z0-9:_-]+(?:\/answer)?$/.test(path)) return;
    if (path.startsWith('/api/bgm/') && isBgmTrack(path.slice('/api/bgm/'.length))) return;
    if(path==='/api/ai-connection'||path==='/api/voice-connection'||path==='/api/realtime/speech')return;
    let aiReady=false;try{aiReady=!!request.yuiUser&&!!keyStore.key(request.yuiUser.userId);}catch{}
    if(config.googleOAuth && (path === '/api/google-calendar-tasks/status' || path === '/api/google-calendar-tasks/callback' || /^\/api\/google-calendar-tasks\/calendar(?:\/(?:connect|read|preview|sources))?$/.test(path))) return;
    if(config.googleOAuth && config.googleAssistantWrite.calendar && (/^\/api\/google-assistant\/(?:list|prepare|confirm|cancel)$/.test(path)||/^\/api\/google-assistant\/operations\/[a-f0-9-]+$/.test(path))) return;
    if(/^\/api\/google-writes\/(?:prepare|status|cancel|confirm)$/.test(path))return;
    if(path==='/api/gmail/status'||config.gmailEnabled&&/^\/api\/gmail\/(?:connect|disconnect|search|read)$/.test(path))return;
    if(path==='/api/google-drive/status'||config.driveEnabled&&/^\/api\/google-drive\/(?:connect|disconnect|search|read)$/.test(path))return;
    if(aiReady && path === '/api/realtime/calls' && request.method === 'POST') return;
    // A completed call must still report usage if its AI key was removed meanwhile.
    if(path === '/api/usage' && request.method === 'POST') return;
    if(aiReady && (path === '/api/chat/responses' || path === '/api/chat/transcriptions')) return;
    if(aiReady && path === '/api/memory/process') return;
    if((request.method==='GET'||request.method==='DELETE') && /^\/api\/photos\/[a-f0-9-]+(?:\/content)?$/.test(path))return;
    if(aiReady && (path === '/api/photo-responses' || /^\/api\/photos\/[a-f0-9-]+(?:\/(?:content|commit))?$/.test(path))) return;
    if(['/healthz','/api/healthz','/api/browser-config','/api/profile','/api/chat-state','/api/memory-settings','/api/memories','/api/memory-tombstones','/api/visual-style-preference','/api/life-settings','/api/life-weather/locations'].includes(path)) return;
    if(/^\/api\/memories\/[a-f0-9-]+(?:\/(?:forget|keep))?$/.test(path)) return;
    if(/^\/api\/memory-tombstones\/[a-f0-9-]+\/release$/.test(path)) return;
    return reply.code(503).header('Cache-Control','no-store').send({error:'connection_setup_in_progress'});
  });
  return app;
}
