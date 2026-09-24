import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import type { AcpStreamMessage } from "./types.js";
import type { AcpPipeline } from "./pipeline.js";

const ACP_TRACE_ENABLED = process.env.REFINED_AGY_TRACE === "1";

export function traceAcp(direction: "client->agy" | "agy->client", msg: AcpStreamMessage): void {
  if (!ACP_TRACE_ENABLED) return;
  const m = msg as { id?: unknown; method?: unknown; error?: unknown };
  const id = m.id === undefined ? "-" : String(m.id);
  const kind = m.method ? String(m.method) : m.error ? "error" : "result";
  console.error(`[refined-antigravity-acp][acp] ${direction} id=${id} ${kind}`);
}

export function defaultSpawnProcess(
  cmd: string,
  args: string[],
  pipeline?: AcpPipeline,
): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: "false",
  };

  if (pipeline) {
    pipeline.applySpawn(env, cmd, args);
  }

  return spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}

export async function writeJsonMessage(child: ChildProcess, msg: AcpStreamMessage): Promise<void> {
  const stdin = child.stdin;
  if (!stdin || !stdin.writable) {
    throw new Error("Child process stdin is not writable");
  }

  const payload = JSON.stringify(msg) + "\n";
  const canContinue = stdin.write(payload);
  if (!canContinue) {
    await once(stdin, "drain");
  }
}
