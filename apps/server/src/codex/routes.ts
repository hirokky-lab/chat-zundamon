import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CodexJobs, requestIdSchema } from './jobs.js';
export function registerCodex(app: FastifyInstance, options: { jobs?: CodexJobs; origin: string }) {
  app.get('/api/codex/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { enabled: !!options.jobs, project: 'Codex', mode: 'agent', ...(options.jobs ? await options.jobs.connectionStatus() : { connected: false }) };
  });
  app.get('/api/codex/jobs/latest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.jobs) return reply.code(503).send({ error: 'codex_disabled' });
    try { return { job: options.jobs.latest(request.yuiUser.userId) }; }
    catch { return reply.code(503).send({ error: 'storage_unavailable' }); }
  });
  app.get('/api/codex/jobs/:requestId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.jobs) return reply.code(503).send({ error: 'codex_disabled' });
    const parsed = z.object({ requestId: requestIdSchema }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const job = options.jobs.get(request.yuiUser.userId, parsed.data.requestId);
      return job ? { job } : reply.code(404).send({ error: 'not_found' });
    } catch { return reply.code(503).send({ error: 'storage_unavailable' }); }
  });
  for (const method of ['POST', 'DELETE'] as const) app.route({
    method, url: '/api/codex/jobs', bodyLimit: 100000,
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (request.headers.origin !== options.origin) return reply.code(403).send({ error: 'origin_not_allowed' });
      if (!options.jobs) return reply.code(503).send({ error: 'codex_disabled' });
      const parsed = (method === 'POST'
        ? z.object({ requestId: requestIdSchema, prompt: z.string().trim().min(1).max(4000), context: z.string().max(16000).optional(), previousRequestId: requestIdSchema.optional() }).strict()
        : z.object({ requestId: requestIdSchema }).strict()).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        const job = method === 'POST' && 'prompt' in parsed.data && typeof parsed.data.prompt === 'string'
          ? options.jobs.start(request.yuiUser.userId, parsed.data.requestId, parsed.data.prompt, { context: 'context' in parsed.data && typeof parsed.data.context === 'string' ? parsed.data.context : undefined, previousRequestId: 'previousRequestId' in parsed.data && typeof parsed.data.previousRequestId === 'string' ? parsed.data.previousRequestId : undefined })
          : options.jobs.cancel(request.yuiUser.userId, parsed.data.requestId);
        return reply.code(202).send({ job });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'codex_busy' || message === 'request_conflict') return reply.code(409).send({ error: message });
        if (message === 'secret_not_allowed') return reply.code(400).send({ error: message });
        return reply.code(503).send({ error: 'codex_unavailable' });
      }
    },
  });
  app.post('/api/codex/jobs/:requestId/answer', { bodyLimit: 40000 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers.origin !== options.origin) return reply.code(403).send({ error: 'origin_not_allowed' });
    if (!options.jobs) return reply.code(503).send({ error: 'codex_disabled' });
    const params = z.object({ requestId: requestIdSchema }).safeParse(request.params);
    const body = z.object({ pendingId: z.uuid(), choice: z.string().max(100).optional(), answers: z.record(z.string().max(200), z.string().max(10000)).optional() }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_answer' });
    try { return { job: await options.jobs.answer(request.yuiUser.userId, params.data.requestId, body.data.pendingId, body.data) }; }
    catch (error) { return reply.code(409).send({ error: error instanceof Error && error.message === 'invalid_answer' ? 'invalid_answer' : 'request_expired' }); }
  });
  app.addHook('onClose', async () => options.jobs?.close());
}
