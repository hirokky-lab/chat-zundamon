import {isBgmTrack} from '@yui/domain';
import type {FastifyInstance} from 'fastify';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
/** Only the authenticated owner can hear locally installed tracks. No public asset copies. */
export function registerBgm(app: FastifyInstance, directory: string) {
  app.get<{Params:{track:string}}>('/api/bgm/:track', async (request, reply) => {
    if (!request.yuiUser) return reply.code(401).send({error:'authentication_required'});
    const track = request.params.track;
    if (!isBgmTrack(track)) return reply.code(404).send({error:'bgm_not_found'});
    try {
      const bytes = await readFile(join(directory, track + '.mp3'));
      return reply.header('Cache-Control','private, no-store').type('audio/mpeg').send(bytes);
    } catch { return reply.code(404).send({error:'bgm_not_installed'}); }
  });
}
