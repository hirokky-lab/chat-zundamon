import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { containsForbiddenSecret } from "./memory-policy.js";
import type { ExternalToolBoundary, ExternalToolExecution } from "./external-tools.js";
import type { RequestUser } from "./request-user.js";

const modeSchema = z.enum(["organize", "task_suggestions", "draft"]);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const requestSchema = z.object({
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/u),
  conversationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/u),
  mode: modeSchema,
  text: boundedText(4_000),
  confirmationToken: z.string().min(1).max(2_048).optional(),
}).strict();
const resultSchema = z.object({
  summary: boundedText(1_000),
  tasks: z.array(boundedText(240)).max(8),
  draft: boundedText(4_000).nullable(),
  workplacePolicy: z.literal("unknown"),
}).strict().superRefine((value, context) => {
  const texts = [value.summary, ...value.tasks, ...(value.draft ? [value.draft] : [])];
  if (texts.some(containsForbiddenSecret)) context.addIssue({ code: "custom", message: "unsafe output" });
});

export type WorkAssistMode = z.infer<typeof modeSchema>;
export type WorkAssistResult = z.infer<typeof resultSchema>;
export type WorkAssistGateway = {
  generate(input: { mode: WorkAssistMode; text: string; signal: AbortSignal }): Promise<ExternalToolExecution<unknown>>;
};
export type WorkAssistOutcome =
  | { status: "success"; result: WorkAssistResult }
  | { status: "disabled" | "confirmation_required" | "sensitive_input_blocked" | "unavailable" };

export function createWorkAssistService(options: {
  boundary: ExternalToolBoundary;
  gateway: WorkAssistGateway;
  timeoutMs?: number;
}) {
  return {
    async assist(user: RequestUser, input: z.infer<typeof requestSchema>): Promise<WorkAssistOutcome> {
      if (containsForbiddenSecret(input.text)) return { status: "sensitive_input_blocked" };
      const outcome = await options.boundary.run({
        user,
        requestId: input.requestId,
        attempt: 1,
        feature: "work_assist",
        operation: "external_change",
        context: {
          conversationId: input.conversationId,
          channel: "chat",
          personaId: "yui",
          memoryScope: "shared",
        },
        input: { mode: input.mode, text: input.text },
        confirmationToken: input.confirmationToken,
        timeoutMs: options.timeoutMs ?? 15_000,
        execute: async ({ input: work, signal }) => {
          const execution = await options.gateway.generate({ ...work, signal });
          const parsed = resultSchema.safeParse(execution.value);
          if (!parsed.success) throw new Error("invalid work assistance result");
          return { ...execution, value: parsed.data };
        },
      });
      if (outcome.status === "disabled") return { status: "disabled" };
      if (outcome.status === "confirmation_required") return { status: "confirmation_required" };
      if (outcome.status !== "success") return { status: "unavailable" };
      return { status: "success", result: outcome.value };
    },
  };
}

export function registerWorkAssistRoute(app: FastifyInstance, options: {
  boundary: ExternalToolBoundary;
  gateway: WorkAssistGateway;
  timeoutMs?: number;
}): void {
  const service = createWorkAssistService(options);
  app.post("/api/work-assist", async (request, reply) => {
    const owner = request.yuiUser;
    if (!owner) return reply.code(401).send({ status: "unavailable" });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ status: "unavailable" });
    const outcome = await service.assist(owner, parsed.data);
    if (outcome.status === "success") return reply.send(outcome);
    if (outcome.status === "confirmation_required") return reply.code(409).send(outcome);
    if (outcome.status === "sensitive_input_blocked") return reply.code(400).send(outcome);
    return reply.code(503).send({ status: "unavailable" });
  });
}
