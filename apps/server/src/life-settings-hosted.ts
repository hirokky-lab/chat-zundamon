import type { UserClientFactory } from './hosted-repositories.js';
import { createLifeSettingsService,createSupabaseLifeSettingsRepository,LifeServiceError } from './life-settings.js';
import { createLifeWeatherService,createOpenMeteoProvider } from './life-weather.js';
export function createHostedLifeServices(options:{createUserClient:UserClientFactory;fetch?:typeof globalThis.fetch}) {
 const settings=createLifeSettingsService(createSupabaseLifeSettingsRepository(options.createUserClient));
 const weather=createLifeWeatherService({settings,provider:createOpenMeteoProvider({fetch:options.fetch}),quota:{async acquire(owner){const result=await options.createUserClient(owner).rpc('acquire_life_weather_quota',{});if(result.error||typeof result.data!=='boolean')throw new LifeServiceError('unavailable');return result.data;}}});
 return {settings,weather};
}
