import Fastify from 'fastify';
import {it,expect} from 'vitest';
import {registerLifeSettingsRoutes} from '../src/life-settings-routes.js';
import {createLifeSettingsService,createInMemoryLifeSettingsRepository} from '../src/life-settings.js';
import {createLifeWeatherService} from '../src/life-weather.js';
it('authenticates routes, enforces exact bodies and returns generic failures',async()=>{
 const app=Fastify();const settings=createLifeSettingsService(createInMemoryLifeSettingsRepository());
 app.addHook('preHandler',async r=>{if(r.headers.authorization)r.yuiUser={userId:'a',email:'',accessToken:'test'};});
 const weather=createLifeWeatherService({settings,provider:{locations:async()=>{throw Error('private content');},forecast:async()=>{throw Error();}}});
 registerLifeSettingsRoutes(app,{settings,weather});
 expect((await app.inject({url:'/api/life-settings'})).statusCode).toBe(401);
 const headers={authorization:'test'};
 expect((await app.inject({url:'/api/life-settings',headers})).json().revision).toBe(0);
 expect((await app.inject({url:'/api/life-weather/locations',method:'POST',headers,payload:{query:'Example',ownerId:'other'}})).statusCode).toBe(400);
 const fail=await app.inject({url:'/api/life-weather/locations',method:'POST',headers,payload:{query:'Example'}});
 expect(fail.statusCode).toBe(503);expect(fail.body).not.toContain('private content');await app.close();
});
