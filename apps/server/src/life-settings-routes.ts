import type { FastifyInstance,FastifyReply } from 'fastify';
import { LifeServiceError,type LifeSettingsService } from './life-settings.js';
import type { LifeWeatherService } from './life-weather.js';
export function registerLifeSettingsRoutes(app:FastifyInstance,services:{settings:LifeSettingsService;weather:LifeWeatherService}):void {
 app.addHook('onSend',async(request,reply,payload)=>{if(request.url.startsWith('/api/life-settings')||request.url.startsWith('/api/life-weather/'))reply.header('Cache-Control','no-store');return payload;});
 const fail=(reply:FastifyReply,error:unknown)=>{const code=error instanceof LifeServiceError?error.code:'unavailable';return reply.code(code==='invalid_request'?400:code==='conflict'||code==='home_required'?409:code==='quota_exceeded'?429:503).send({error:'Life service request could not be completed',code});};
 app.get('/api/life-settings',async(req,reply)=>{if(!req.yuiUser)return reply.code(401).send({error:'Authentication required'});try{return await services.settings.get(req.yuiUser);}catch(e){return fail(reply,e);}});
 app.put('/api/life-settings',async(req,reply)=>{if(!req.yuiUser)return reply.code(401).send({error:'Authentication required'});try{return await services.settings.update(req.yuiUser,req.body);}catch(e){return fail(reply,e);}});
 app.post('/api/life-weather/locations',async(req,reply)=>{if(!req.yuiUser)return reply.code(401).send({error:'Authentication required'});try{const b=req.body;if(!b||typeof b!=='object'||Object.keys(b).join(',')!=='query')throw new LifeServiceError('invalid_request');return await services.weather.locations(req.yuiUser,(b as {query:string}).query);}catch(e){return fail(reply,e);}});
 app.post('/api/life-weather/forecast',async(req,reply)=>{if(!req.yuiUser)return reply.code(401).send({error:'Authentication required'});try{const b=req.body;if(!b||typeof b!=='object'||Object.keys(b).join(',')!=='days')throw new LifeServiceError('invalid_request');return await services.weather.forecast(req.yuiUser,(b as {days:number}).days);}catch(e){return fail(reply,e);}});
}
