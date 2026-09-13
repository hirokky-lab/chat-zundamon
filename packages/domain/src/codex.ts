/** The UI renders Codex requests; the server retains their executable response payloads. */
export type CodexQuestion = { id: string; question: string; options?: string[]; secret?: boolean; required?: boolean; type?: 'string' | 'number' | 'integer' | 'boolean' };
export type CodexPendingRequest = {
  id: string; kind: 'approval' | 'questions' | 'form' | 'url'; title: string; details: string;
  choices: Array<{ id: string; label: string }>;
  questions?: CodexQuestion[]; url?: string;
};
export type CodexAnswer = { choice?: string; answers?: Record<string, string> };
export type CodexJob = {
  id: string; requestId: string; prompt: string;
  status: 'connecting' | 'researching' | 'working' | 'waiting' | 'completed' | 'cancelled' | 'failed';
  message: string; result: string | null; createdAt: string; updatedAt: string;
  threadId?: string | null; turnId?: string | null;
  pending?: CodexPendingRequest[]; projectName?: string; cwd?: string;
  conversationId?: string; mode?: 'agent';
};
export const codexWorking = (job: CodexJob) => ['connecting', 'researching', 'working', 'waiting'].includes(job.status);
