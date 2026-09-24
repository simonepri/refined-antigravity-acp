import type { ChildProcess } from "node:child_process";
import type { AcpConnector, AcpStream, AcpStreamMessage } from "./core/types.js";

// Core generic transport and plumbing
import { AcpPipeline } from "./core/pipeline.js";
import { defaultSpawnProcess } from "./core/transport.js";
import { ProcessSupervisor } from "./core/supervisor.js";

// Dedicated Fixes (Mapped 1:1 to Readme Table)
import { createDefaultFixes } from "./fixes/index.js";
import { resolveBinaryCommand } from "./fixes/missing-localharness/index.js";
import { DEFAULT_PROMPT_RETRY_DELAY_MS } from "./fixes/active-turn-collision/index.js";
import { type McpProxyPool, sharedMcpProxyPool } from "./fixes/stale-mcp-endpoints/index.js";

// Export all fixes and plumbing
export * from "./fixes/index.js";
export * from "./core/types.js";
export * from "./core/session-cache.js";
export * from "./core/transport.js";
export * from "./core/pipeline.js";
export * from "./core/supervisor.js";
export * from "./core/command.js";
export * from "./setup.js";

export const PROMPT_RETRY_DELAY_MS = DEFAULT_PROMPT_RETRY_DELAY_MS;

export interface AntigravityConnectorOptions {
  spawnProcess?: (cmd: string, args: string[]) => ChildProcess | Promise<ChildProcess>;
  recycleTimeoutMs?: number;
  /** Total spawn+resync attempts per recycle before giving up (including the first). */
  recycleSpawnAttempts?: number;
  /** Delay between failed respawn attempts. */
  recycleRetryDelayMs?: number;
}

/**
 * Creates an in-process ACP connector stream that launches the official `agy_acp_server` binary,
 * automatically downloading it if not present, and applies mode option filtering, outbound MCP adaptation,
 * text sanitization, hang detection, and transparent process recycling.
 */
export function createAntigravityConnector(
  proxies: McpProxyPool = sharedMcpProxyPool,
  options?: AntigravityConnectorOptions,
): AcpConnector {
  return async (): Promise<AcpStream> => {
    const [cmd, ...args] = await resolveBinaryCommand();

    const spawnFn = options?.spawnProcess ?? ((c, a) => defaultSpawnProcess(c, a));
    const initialChild = await spawnFn(cmd, args);

    const supervisor = new ProcessSupervisor({
      cmd,
      args,
      initialChild,
      pipeline: new AcpPipeline(createDefaultFixes()),
      proxies,
      spawnProcess: options?.spawnProcess,
      recycleTimeoutMs: options?.recycleTimeoutMs,
      recycleSpawnAttempts: options?.recycleSpawnAttempts,
      recycleRetryDelayMs: options?.recycleRetryDelayMs,
    });

    return supervisor.createStreams();
  };
}

export type { AcpConnector, AcpStreamMessage };
