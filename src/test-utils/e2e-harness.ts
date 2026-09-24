import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { agyCommand } from "../core/command.js";
import { createAntigravityConnector, type AntigravityConnectorOptions } from "../index.js";
import type {
  AcpStreamMessage,
  InboundContext,
  OutboundContext,
  StderrContext,
} from "../core/types.js";
import { createSessionCache } from "../core/session-cache.js";
import type { McpProxyPool } from "../fixes/stale-mcp-endpoints/index.js";

export function createMockContext(): InboundContext & OutboundContext & StderrContext {
  return {
    sessionCache: createSessionCache(),
    forwardInbound: () => {},
    writeToChild: async () => {},
    sendInternalRequest: async () => ({}) as AcpStreamMessage,
    triggerRecycle: async () => {},
    declareHang: () => {},
  };
}

export interface AcpTestClient {
  readonly send: (msg: AcpStreamMessage) => Promise<void>;
  readonly waitForResponse: (id: string | number, timeoutMs?: number) => Promise<AcpStreamMessage>;
  readonly nextMatching: (
    predicate: (msg: AcpStreamMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<AcpStreamMessage>;
  readonly initialize: (clientInfo?: {
    name: string;
    version: string;
  }) => Promise<AcpStreamMessage>;
  readonly newSession: (
    params?: Record<string, unknown>,
  ) => Promise<{ sessionId: string; [key: string]: unknown }>;
  readonly prompt: (
    sessionId: string,
    text: string,
    id?: string | number,
  ) => Promise<{ id: string | number }>;
  readonly stderrLines: () => string[];
  readonly allMessages: () => AcpStreamMessage[];
  readonly close: () => Promise<void>;
}

interface ClientIo {
  write: (line: string) => Promise<void>;
  stderrLines: () => string[];
  close: () => Promise<void>;
}

function createClient(
  io: ClientIo,
  subscribe: (onMessage: (msg: AcpStreamMessage) => void) => void,
): AcpTestClient {
  const messages: AcpStreamMessage[] = [];
  const waiters: Array<{
    predicate: (msg: AcpStreamMessage) => boolean;
    resolve: (msg: AcpStreamMessage) => void;
  }> = [];
  let nextId = 1;

  subscribe((msg) => {
    messages.push(msg);
    const idx = waiters.findIndex((w) => w.predicate(msg));
    if (idx !== -1) {
      const [waiter] = waiters.splice(idx, 1);
      waiter?.resolve(msg);
    }
  });

  const send = async (msg: AcpStreamMessage): Promise<void> => {
    await io.write(JSON.stringify(msg) + "\n");
  };

  const nextMatching = (
    predicate: (msg: AcpStreamMessage) => boolean,
    timeoutMs = 45000,
  ): Promise<AcpStreamMessage> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (msg: AcpStreamMessage) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for matching message after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  };

  const waitForResponse = (id: string | number, timeoutMs = 45000): Promise<AcpStreamMessage> =>
    nextMatching(
      (m) =>
        ("id" in m && m.id === id) ||
        (("result" in m || "error" in m) && (m as { id?: unknown }).id === id),
      timeoutMs,
    );

  const initialize = async (
    clientInfo = { name: "test-client", version: "1.0.0" },
  ): Promise<AcpStreamMessage> => {
    const id = nextId++;
    await send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: 1, clientInfo },
    } as unknown as AcpStreamMessage);
    return waitForResponse(id);
  };

  const newSession = async (
    params: Record<string, unknown> = {},
  ): Promise<{ sessionId: string; [key: string]: unknown }> => {
    const id = nextId++;
    await send({
      jsonrpc: "2.0",
      id,
      method: "session/new",
      params: { cwd: process.cwd(), mcpServers: [], ...params },
    } as unknown as AcpStreamMessage);
    const res = await waitForResponse(id);
    if ("error" in res && res.error)
      throw new Error(`session/new error: ${JSON.stringify(res.error)}`);
    return (res as { result: { sessionId: string; [key: string]: unknown } }).result;
  };

  const prompt = async (
    sessionId: string,
    text: string,
    explicitId?: string | number,
  ): Promise<{ id: string | number }> => {
    const id = explicitId ?? nextId++;
    await send({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    } as unknown as AcpStreamMessage);
    return { id };
  };

  return {
    send,
    waitForResponse,
    nextMatching,
    initialize,
    newSession,
    prompt,
    stderrLines: io.stderrLines,
    allMessages: () => [...messages],
    close: io.close,
  };
}

export interface SpawnRawAgyOptions {
  cmd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export async function spawnRawAgy(opts: SpawnRawAgyOptions = {}): Promise<AcpTestClient> {
  const [defaultCmd, ...defaultArgs] = agyCommand();
  const cmd = opts.cmd ?? defaultCmd;
  const args = opts.args ?? defaultArgs;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: "false",
    ...opts.env,
  };

  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: opts.cwd });
  const stderr: string[] = [];

  const rlErr = readline.createInterface({ input: child.stderr!, crlfDelay: Infinity });
  rlErr.on("line", (line) => stderr.push(line));

  const io: ClientIo = {
    write: (line) =>
      new Promise((resolve, reject) => {
        if (!child.stdin?.writable) return reject(new Error("stdin is not writable"));
        child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
      }),
    stderrLines: () => [...stderr],
    close: async () => {
      rlErr.close();
      if (child.stdin?.writable) child.stdin.end();
      if (!child.killed) child.kill("SIGKILL");
    },
  };

  return createClient(io, (onMessage) => {
    const rlOut = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rlOut.on("line", (line) => {
      try {
        onMessage(JSON.parse(line) as AcpStreamMessage);
      } catch {
        // Non-JSON ignored
      }
    });
  });
}

export interface SpawnWrappedOptions {
  cmd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  proxies?: McpProxyPool;
  options?: AntigravityConnectorOptions;
}

export async function spawnWrapped(opts: SpawnWrappedOptions = {}): Promise<AcpTestClient> {
  const [defaultCmd, ...defaultArgs] = agyCommand();
  const targetCmd = opts.cmd ?? defaultCmd;
  const targetArgs = opts.args ?? defaultArgs;
  const forwardedStderr: string[] = [];

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    const str = typeof chunk === "string" ? chunk : String(chunk);
    for (const line of str.split("\n")) {
      if (line) forwardedStderr.push(line);
    }
    return originalStderrWrite(chunk as string, ...(rest as []));
  }) as unknown as typeof process.stderr.write;

  const children: ChildProcess[] = [];
  const customSpawn = (cmd: string, args: string[]): ChildProcess => {
    const effectiveCmd = opts.cmd ? targetCmd : cmd;
    const effectiveArgs = opts.cmd ? targetArgs : args;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      BROWSER: "false",
      ...opts.env,
    };

    const [origCmd] = agyCommand();
    const origHarness = origCmd.replace(/agy_acp_server\.(par|exe)$/, "localharness_external");
    if (!env.ANTIGRAVITY_HARNESS_PATH && origHarness !== effectiveCmd) {
      env.ANTIGRAVITY_HARNESS_PATH = origHarness;
    }

    const child = spawn(effectiveCmd, effectiveArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: opts.cwd,
    });
    children.push(child);
    return child;
  };

  const connector = createAntigravityConnector(opts.proxies, {
    ...opts.options,
    spawnProcess: opts.options?.spawnProcess ?? customSpawn,
  });

  const stream = await connector();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let closed = false;

  const io: ClientIo = {
    write: async (line) => {
      await writer.write(JSON.parse(line.trim()));
    },
    stderrLines: () => [...forwardedStderr],
    close: async () => {
      if (closed) return;
      closed = true;
      process.stderr.write = originalStderrWrite;
      try {
        await writer.close();
      } catch {}
      try {
        await reader.cancel();
      } catch {}
      for (const ch of children) {
        if (!ch.killed) ch.kill("SIGKILL");
      }
    },
  };

  return createClient(io, (onMessage) => {
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          if (value) onMessage(value);
        }
      } catch {}
    })();
  });
}
