import { rename, unlink, writeFile } from "node:fs/promises";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA_40 = /^[a-f0-9]{40}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const SECRET = /(?:sk-|bearer|token|secret|api[_-]?key)/iu;

type Input = Readonly<{ requestId: string; taskId: string; taskFingerprint: string; canonicalSha: string }>;
type Output = Readonly<Input & { continuationContractId: string; outcome: "auto_continue" }>;

function valid(input: unknown): input is Input {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).sort().join("|") === "canonicalSha|requestId|taskFingerprint|taskId"
    && typeof value.requestId === "string" && ID.test(value.requestId) && !SECRET.test(value.requestId)
    && typeof value.taskId === "string" && ID.test(value.taskId) && !SECRET.test(value.taskId)
    && typeof value.taskFingerprint === "string" && SHA_256.test(value.taskFingerprint)
    && typeof value.canonicalSha === "string" && SHA_40.test(value.canonicalSha);
}

export async function runAutonomousFoundation({ input, statePath, stdout }: Readonly<{ input: unknown; statePath: string; stdout: (line: string) => void }>): Promise<0 | 1> {
  if (!valid(input)) { stdout('{"code":"autonomous_input_rejected"}\n'); return 1; }
  const output: Output = { ...input, continuationContractId: input.requestId, outcome: "auto_continue" };
  const body = `${JSON.stringify(output)}\n`;
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, statePath);
    stdout(body);
    return 0;
  } catch {
    await unlink(temporary).catch(() => undefined);
    stdout('{"code":"autonomous_state_unavailable"}\n');
    return 1;
  }
}
