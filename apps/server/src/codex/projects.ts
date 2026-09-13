import { z } from 'zod';
import type { CodexRpc } from './rpc.js';
const projectSchema = z.object({ id: z.string(), name: z.string(), roots: z.array(z.object({ path: z.string() })) });
export type CodexProject = z.infer<typeof projectSchema>;
export async function readProjects(rpc: Pick<CodexRpc, 'request'>): Promise<CodexProject[]> {
  const result: CodexProject[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = z.object({ data: z.array(projectSchema), nextCursor: z.string().nullable() }).parse(await rpc.request('project/list', { limit: 100, cursor }));
    result.push(...page.data); cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Error('codex_project_pagination');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}
/** Convenience matching, not a permission list. Codex can resolve any other target. */
export function namedProject(prompt: string, projects: CodexProject[]) {
  const text = prompt.normalize('NFKC').toLowerCase();
  const matches = projects.filter(p => {
    const name = p.name.normalize('NFKC').toLowerCase();
    const at = text.indexOf(name);
    return at >= 0 && (!/^[a-z0-9_-]+$/.test(name) || !/[a-z0-9_-]/.test(text[at - 1] ?? '') && !/[a-z0-9_-]/.test(text[at + name.length] ?? ''));
  });
  const roots = new Set(matches.map(p => p.roots[0]?.path));
  return roots.size === 1 && matches[0]?.roots.length ? matches[0] : undefined;
}
