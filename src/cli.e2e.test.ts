import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "./core/types.js";

const CLI_PATH = fileURLToPath(new URL("../dist/bin/cli.js", import.meta.url));
const STUB_SESSION_ID = "stub-session";

/**
 * Minimal ACP server used as `REFINED_AGY_ACP_BIN`: answers `initialize`, then reports the
 * agent connection as lost (which latches `needsRecycle` in the proxy), and fails every
 * `session/load` so an in-place recycle exhausts its attempts.
 */
const STUB_AGY = `#!/usr/bin/env node
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "stub-agy", version: "0.0.0" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Agent connection was lost and could not be re-established: Failed to rebuild agent: stub",
            },
          },
        },
      });
    } else if (msg.method === "session/load") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: "stub session/load failure" },
      });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
`;

interface ProxyRun {
  readonly child: ChildProcess;
  readonly stdoutEnded: Promise<void>;
  readonly exited: Promise<number | null>;
  send: (msg: AcpStreamMessage) => void;
  waitFor: (
    predicate: (msg: AcpStreamMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<AcpStreamMessage>;
}

function startProxy(stubPath: string): ProxyRun {
  const child = spawn(process.execPath, [CLI_PATH], {
    env: {
      ...process.env,
      REFINED_AGY_ACP_BIN: stubPath,
      REFINED_AGY_INJECT_SKILLS: "0",
      REFINED_AGY_TRACE: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const inbox: AcpStreamMessage[] = [];
  const waiters: Array<{
    predicate: (msg: AcpStreamMessage) => boolean;
    resolve: (msg: AcpStreamMessage) => void;
  }> = [];

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as AcpStreamMessage;
      inbox.push(msg);
      const matched = waiters.filter((waiter) => waiter.predicate(msg));
      for (const waiter of matched) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(msg);
      }
    }
  });

  const stdoutEnded = new Promise<void>((resolve) => {
    child.stdout?.on("end", () => resolve());
    child.stdout?.on("close", () => resolve());
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  const waitFor = async (
    predicate: (msg: AcpStreamMessage) => boolean,
    timeoutMs = 15_000,
  ): Promise<AcpStreamMessage> => {
    const buffered = inbox.find(predicate);
    if (buffered !== undefined) return buffered;
    return await new Promise<AcpStreamMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error("Timed out waiting for an ACP message from the proxy"));
      }, timeoutMs);
      const waiter = {
        predicate,
        resolve: (msg: AcpStreamMessage) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      waiters.push(waiter);
    });
  };

  return {
    child,
    stdoutEnded,
    exited,
    send: (msg) => child.stdin?.write(`${JSON.stringify(msg)}\n`),
    waitFor,
  };
}

describe("refined-antigravity-acp CLI", () => {
  it("solution: an exhausted recycle closes stdout and exits so the client observes the disconnect", async () => {
    expect(
      existsSync(CLI_PATH),
      `Missing ${CLI_PATH}; run \`pnpm run build\` before the e2e suite`,
    ).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "agy-cli-e2e-"));
    const stubPath = join(dir, "stub-agy");
    writeFileSync(stubPath, STUB_AGY, { mode: 0o755 });
    chmodSync(stubPath, 0o755);

    const proxy = startProxy(stubPath);
    try {
      proxy.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: "dsh", version: "0" },
        },
      } as unknown as AcpStreamMessage);
      await proxy.waitFor((msg) => "id" in msg && msg.id === 1);

      // The stub reports the agent connection as lost, which latches the session for recycling.
      await proxy.waitFor((msg) => "method" in msg && msg.method === "session/update");

      proxy.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          sessionId: STUB_SESSION_ID,
          prompt: [{ type: "text", text: "ping" }],
        },
      } as unknown as AcpStreamMessage);

      const rejection = await proxy.waitFor((msg) => "id" in msg && msg.id === 2 && "error" in msg);
      expect(JSON.stringify(rejection)).toContain("stub session/load failure");

      // The readable ending must close stdout (client-side EOF) and terminate the process;
      // without that, the client never sees a disconnect and the process idles on stdin.
      await proxy.stdoutEnded;
      expect(await proxy.exited).toBe(0);
    } finally {
      proxy.child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
});
