import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  STOP_REASONS,
  type AcpFix,
  type AcpStreamMessage,
} from "./types.js";
import { AcpPipeline } from "./pipeline.js";
import {
  ProcessSupervisor,
  computeSessionLoadTimeout,
  DEFAULT_RECYCLE_TIMEOUT_MS,
  LOAD_TIMEOUT_PER_MB_MS,
} from "./supervisor.js";
import { createSessionCache, getOrCreateSession } from "./session-cache.js";

function createMockChild(): {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  emitClose: () => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let isKilled = false;
  const exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;

  const child = {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get killed() {
      return isKilled;
    },
    on: (evt: string, fn: (...args: unknown[]) => void) => {
      const list = listeners.get(evt) ?? [];
      list.push(fn);
      listeners.set(evt, list);
      return child;
    },
    once: (evt: string, fn: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]) => {
        const list = listeners.get(evt);
        if (list) {
          listeners.set(
            evt,
            list.filter((l) => l !== wrapped),
          );
        }
        fn(...args);
      };
      return child.on(evt, wrapped);
    },
    removeAllListeners: (evt?: string) => {
      if (evt) listeners.delete(evt);
      else listeners.clear();
      return child;
    },
    kill: (sig?: NodeJS.Signals | number) => {
      isKilled = true;
      stdin.destroy();
      signalCode = (typeof sig === "string" ? sig : "SIGKILL") as NodeJS.Signals;
      return true;
    },
  } as unknown as ChildProcess;

  const emitClose = () => {
    const list = listeners.get("close") ?? [];
    for (const fn of list) {
      fn();
    }
  };

  return { child, stdout, stderr, stdin, emitClose };
}

describe("ProcessSupervisor", () => {
  it("solution: suppresses all inbound notifications while isRecycling is active", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([]),
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // Simulate recycling active
    supervisor.isRecycling = true;

    // Upstream emits hundreds of session/update events during internal session/load
    const historyNotification: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
          content: { type: "text", text: "Old replayed message" },
        },
      },
    };

    await supervisor.handleStdoutLine(JSON.stringify(historyNotification));

    // Wait microtask tick
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Must be suppressed completely
    expect(forwarded).toHaveLength(0);

    // After recycling concludes, normal notifications are forwarded
    supervisor.isRecycling = false;
    const liveNotification: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
          content: { type: "text", text: "New live message" },
        },
      },
    };

    await supervisor.handleStdoutLine(JSON.stringify(liveNotification));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toEqual(liveNotification);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: triggerRecycle resyncs child with session/load without leaking replayed notifications to client", async () => {
    const { child: initialChild } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const { child: recycledChild } = createMockChild();

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild,
      pipeline: new AcpPipeline([]),
      spawnProcess: () => recycledChild,
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    const handleRecycledChildStdin = async (line: string) => {
      const msg = JSON.parse(line) as { id?: string | number; method?: string };
      if (msg.id === "__refined_agy_recycle_init") {
        await supervisor.handleStdoutLine(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }),
        );
      } else if (msg.id === "__refined_agy_recycle_load") {
        for (let i = 0; i < 5; i++) {
          await supervisor.handleStdoutLine(
            JSON.stringify({
              jsonrpc: "2.0",
              method: ACP_METHODS.SESSION_UPDATE,
              params: {
                sessionId: "session-recycle",
                update: {
                  sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
                  content: { type: "text", text: `History chunk ${i}` },
                },
              },
            }),
          );
        }
        await supervisor.handleStdoutLine(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }),
        );
      }
    };

    recycledChild.stdin?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        void handleRecycledChildStdin(line);
      }
    });

    const session = getOrCreateSession(supervisor.sessionCache, "session-recycle");
    await supervisor.triggerRecycle(session);

    expect(supervisor.isRecycling).toBe(false);
    expect(forwarded).toHaveLength(0);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: triggerRecycle sends the cached initialize through the outbound pipeline", async () => {
    const { child: initialChild } = createMockChild();
    const { child: recycledChild } = createMockChild();
    const sentInitialize: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild,
      pipeline: new AcpPipeline([
        {
          name: "rename-client",
          onOutbound: (msg) =>
            "method" in msg && msg.method === ACP_METHODS.INITIALIZE
              ? ({
                  ...msg,
                  params: { protocolVersion: 1, clientInfo: { name: "renamed", version: "1" } },
                } as AcpStreamMessage)
              : msg,
        },
      ]),
      spawnProcess: () => recycledChild,
    });
    supervisor.sessionCache.cachedInitializeParams = {
      protocolVersion: 1,
      clientInfo: { name: "original", version: "1" },
    };

    recycledChild.stdin?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf-8").split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as AcpStreamMessage & { id?: string | number };
        if ("method" in msg && msg.method === ACP_METHODS.INITIALIZE) sentInitialize.push(msg);
        void supervisor.handleStdoutLine(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }),
        );
      }
    });

    const session = getOrCreateSession(supervisor.sessionCache, "session-recycle-init");
    await supervisor.triggerRecycle(session);

    expect(sentInitialize).toHaveLength(1);
    expect(
      (sentInitialize[0] as { params?: { clientInfo?: { name?: string } } }).params?.clientInfo
        ?.name,
    ).toBe("renamed");

    supervisor.close();
  });

  it("solution: prompt settlement watchdog terminates turn with end_turn after usage_update when upstream hangs", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([]),
      promptSettlementTimeoutMs: 50,
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // Client sends session/prompt
    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 101,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "What is 2+2?" }],
      },
    } as unknown as AcpStreamMessage;

    await supervisor.handleOutbound(promptMsg);

    // Upstream emits usage_update (indicating model generation is complete)
    const usageUpdate: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: SESSION_UPDATES.USAGE_UPDATE,
          used: 172000,
          size: 1000000,
        },
      },
    };

    await supervisor.handleStdoutLine(JSON.stringify(usageUpdate));

    // Wait for the prompt settlement watchdog to fire (>50ms)
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Watchdog should have synthesized the terminal end_turn response
    const endTurnResponse = forwarded.find(
      (m) =>
        "id" in m &&
        m.id === 101 &&
        "result" in m &&
        (m.result as { stopReason?: string })?.stopReason === STOP_REASONS.END_TURN,
    );
    expect(endTurnResponse).toBeDefined();

    // Now verify late upstream response is suppressed and not forwarded twice
    const lateResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 101,
      result: { stopReason: STOP_REASONS.END_TURN },
    } as unknown as AcpStreamMessage;

    const countBefore = forwarded.length;
    await supervisor.handleStdoutLine(JSON.stringify(lateResponse));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(forwarded).toHaveLength(countBefore);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: prompt settlement watchdog is cleared when upstream returns response before timeout", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([]),
      promptSettlementTimeoutMs: 100,
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // Client sends prompt
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 102,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "session-2", prompt: [] },
    } as unknown as AcpStreamMessage);

    // Upstream emits usage_update
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "session-2",
          update: { sessionUpdate: SESSION_UPDATES.USAGE_UPDATE, used: 100, size: 1000 },
        },
      }),
    );

    // Prompt response arrives promptly from upstream (after 10ms)
    await new Promise((resolve) => setTimeout(resolve, 10));
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        result: { stopReason: STOP_REASONS.END_TURN },
      }),
    );

    // Wait beyond the watchdog timeout
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Verify exactly one response was delivered for id 102
    const responses = forwarded.filter((m) => "id" in m && m.id === 102);
    expect(responses).toHaveLength(1);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: prompt settlement watchdog is cancelled on session/cancel", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([]),
      promptSettlementTimeoutMs: 50,
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // Client sends prompt
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 103,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "session-3", prompt: [] },
    } as unknown as AcpStreamMessage);

    // Upstream emits usage_update
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "session-3",
          update: { sessionUpdate: SESSION_UPDATES.USAGE_UPDATE, used: 100, size: 1000 },
        },
      }),
    );

    // User cancels turn
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_CANCEL,
      params: { sessionId: "session-3" },
    } as unknown as AcpStreamMessage);

    // Wait beyond the watchdog timeout
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Watchdog should NOT have fired end_turn
    const syntheticResponses = forwarded.filter((m) => "id" in m && m.id === 103 && "result" in m);
    expect(syntheticResponses).toHaveLength(0);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: prompt settlement watchdog is cleared when tool call activity arrives after usage_update", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([]),
      promptSettlementTimeoutMs: 50,
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // Client sends prompt
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 104,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "session-4", prompt: [] },
    } as unknown as AcpStreamMessage);

    // Upstream emits usage_update
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "session-4",
          update: { sessionUpdate: SESSION_UPDATES.USAGE_UPDATE, used: 100, size: 1000 },
        },
      }),
    );

    // Upstream emits tool call (active execution started)
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "session-4",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-1",
            name: "run_command",
          },
        },
      }),
    );

    // Wait beyond the watchdog timeout
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Watchdog should NOT have fired end_turn because active tool execution cleared the watchdog
    const syntheticResponses = forwarded.filter((m) => "id" in m && m.id === 104 && "result" in m);
    expect(syntheticResponses).toHaveLength(0);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: prompt settlement watchdog is disabled by default", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([]),
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // Client sends prompt
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 105,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "session-5", prompt: [] },
    } as unknown as AcpStreamMessage);

    // Upstream emits usage_update
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "session-5",
          update: { sessionUpdate: SESSION_UPDATES.USAGE_UPDATE, used: 100, size: 1000 },
        },
      }),
    );

    // Wait 50ms
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No synthetic end_turn should be emitted by default
    const syntheticResponses = forwarded.filter((m) => "id" in m && m.id === 105 && "result" in m);
    expect(syntheticResponses).toHaveLength(0);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: forwards child stdout lines in emission order when inbound fixes settle out of order", async () => {
    const { child, stdout } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    // Inbound fixes typically spend longer on session/update than on responses.
    const slowUpdates: AcpFix = {
      name: "slow-updates",
      onInbound: async (msg) => {
        if ("method" in msg) await new Promise((resolve) => setTimeout(resolve, 20));
        return [msg];
      },
    };

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([slowUpdates]),
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    const chunk = {
      jsonrpc: "2.0",
      method: ACP_METHODS.SESSION_UPDATE,
      params: {
        sessionId: "session-order",
        update: {
          sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
          content: { type: "text", text: "answer" },
        },
      },
    };
    const result = { jsonrpc: "2.0", id: 7, result: { stopReason: STOP_REASONS.END_TURN } };
    stdout.write(JSON.stringify(chunk) + "\n" + JSON.stringify(result) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 60));

    // The prompt result must not overtake the text that preceded it.
    expect(forwarded).toEqual([chunk, result]);

    await reader.cancel();
    supervisor.close();
  });

  it("solution: recycle replies bypass the stdout queue while an inbound fix awaits a recycle", async () => {
    const { child: initialChild, stdout } = createMockChild();
    const { child: recycledChild, stdout: recycledStdout } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];
    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "session-recover");

    const recoverOnFailure: AcpFix = {
      name: "recover-on-failure",
      onInbound: async (msg) => {
        if ("error" in msg) await supervisor.triggerRecycle(session);
        return [msg];
      },
    };

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild,
      pipeline: new AcpPipeline([recoverOnFailure]),
      sessionCache: cache,
      spawnProcess: () => recycledChild,
      recycleTimeoutMs: 500,
      recycleSpawnAttempts: 1,
    });

    recycledChild.stdin?.on("data", (data: Buffer) => {
      for (const line of data.toString("utf-8").split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: string | number };
        recycledStdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      }
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    const failure = { jsonrpc: "2.0", id: 8, error: { code: -32603, message: "busy" } };
    stdout.write(JSON.stringify(failure) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(supervisor.currentChild).toBe(recycledChild);
    expect(supervisor.isClosed).toBe(false);
    expect(forwarded).toEqual([failure]);

    await reader.cancel();
    supervisor.close();
  });

  it("flags session for recycling when upstream emits agent connection lost chunk and recycles on next prompt", async () => {
    const { child: initialChild } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];
    const { child: recycledChild } = createMockChild();

    const cache = createSessionCache();
    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild,
      pipeline: new AcpPipeline([]),
      sessionCache: cache,
      spawnProcess: () => recycledChild,
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // 1. Allocate session
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 201,
      method: ACP_METHODS.SESSION_NEW,
      params: { cwd: "/tmp" },
    } as unknown as AcpStreamMessage);
    await supervisor.handleStdoutLine(
      JSON.stringify({ jsonrpc: "2.0", id: 201, result: { sessionId: "session-conn-lost" } }),
    );

    // 2. Upstream emits agent connection lost chunk
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "session-conn-lost",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: {
              type: "text",
              text: "Agent connection was lost and could not be re-established: Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)",
            },
          },
        },
      }),
    );

    // Verify session is marked for recycling
    const session = cache.sessions.get("session-conn-lost");
    expect(session?.needsRecycle).toBe(true);

    // 3. Client sends next prompt -> triggers process recycling
    let recycledChildReceivedInit = false;
    const handleRecycledChildStdin = async (line: string) => {
      const msg = JSON.parse(line) as { id?: string | number; method?: string };
      if (msg.id === "__refined_agy_recycle_init") {
        recycledChildReceivedInit = true;
        await supervisor.handleStdoutLine(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }),
        );
      } else if (msg.id === "__refined_agy_recycle_load") {
        await supervisor.handleStdoutLine(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }),
        );
      }
    };

    recycledChild.stdin?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        void handleRecycledChildStdin(line);
      }
    });

    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 301,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "session-conn-lost",
        prompt: [{ type: "text", text: "Next prompt" }],
      },
    } as unknown as AcpStreamMessage);

    // Process recycling must have been triggered for the new prompt
    expect(recycledChildReceivedInit).toBe(true);
    expect(session?.needsRecycle).toBe(false);

    await reader.cancel();
    supervisor.close();
  });

  describe("computeSessionLoadTimeout", () => {
    it("returns baseTimeoutMs when database file does not exist", () => {
      const timeout = computeSessionLoadTimeout(
        "non-existent-session",
        60_000,
        "/tmp/does-not-exist-at-all.db",
      );
      expect(timeout).toBe(60_000);
    });

    it("dynamically scales timeout based on conversation DB file size", () => {
      const testDir = join(tmpdir(), `test-db-scale-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      const testDb = join(testDir, "test-sess.db");
      const buffer = Buffer.alloc(10 * 1024 * 1024);
      writeFileSync(testDb, buffer);

      try {
        const timeout = computeSessionLoadTimeout("test-sess", 60_000, testDb);
        // 10 MB * 500 ms = 5,000 ms additional timeout
        expect(timeout).toBe(65_000);
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it("uses default 180s base timeout when baseTimeoutMs is omitted", () => {
      const timeout = computeSessionLoadTimeout("non-existent-session");
      expect(timeout).toBe(DEFAULT_RECYCLE_TIMEOUT_MS);
      expect(timeout).toBe(180_000);
      expect(LOAD_TIMEOUT_PER_MB_MS).toBe(500);
    });
  });

  it("solution: triggerRecycle computes session/load timeout using customDbPathGetter", async () => {
    const { child: initialChild } = createMockChild();
    const { child: recycledChild } = createMockChild();
    const testDir = join(tmpdir(), `test-custom-db-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const dummyDb = join(testDir, "large-session.db");
    writeFileSync(dummyDb, Buffer.alloc(20 * 1024 * 1024));

    let queriedSessionId: string | null = null;
    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild,
      pipeline: new AcpPipeline([]),
      spawnProcess: () => recycledChild,
      customDbPathGetter: (sid) => {
        queriedSessionId = sid;
        return dummyDb;
      },
    });

    recycledChild.stdin?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line) as { id?: string | number };
        if (msg.id) {
          void supervisor.handleStdoutLine(
            JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }),
          );
        }
      }
    });

    try {
      const session = getOrCreateSession(supervisor.sessionCache, "large-session");
      await supervisor.triggerRecycle(session);
      expect(queriedSessionId).toBe("large-session");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
      supervisor.close();
    }
  });

  it("solution: fails recycle gracefully on outbound prompt without crashing proxy or destroying stream", async () => {
    const { child: initialChild, emitClose } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];
    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "sess-fail-recycle");
    session.needsRecycle = true;

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild,
      pipeline: new AcpPipeline([]),
      sessionCache: cache,
      spawnProcess: () => {
        throw new Error("simulated spawn failure");
      },
      recycleSpawnAttempts: 1,
      recycleRetryDelayMs: 10,
    });

    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) forwarded.push(value);
      }
    })();

    // Outbound prompt arrives while session needs recycle
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 999,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "sess-fail-recycle",
        prompt: [{ type: "text", text: "Hello" }],
      },
    } as unknown as AcpStreamMessage);

    // Supervisor must NOT be closed, and must forward a JSON-RPC error response for prompt 999
    expect(supervisor.isClosed).toBe(false);
    expect(forwarded).toEqual([
      {
        jsonrpc: "2.0",
        id: 999,
        error: expect.objectContaining({
          code: -32603,
          message: expect.stringContaining("sess-fail-recycle"),
        }),
      },
    ]);

    // Late close event on initial killed child must NOT close the supervisor stream
    emitClose();
    expect(supervisor.isClosed).toBe(false);

    // Subsequent outbound message for another session or global method when child is dead must reject cleanly
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 1000,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "sess-other",
        prompt: [{ type: "text", text: "Other" }],
      },
    } as unknown as AcpStreamMessage);

    expect(supervisor.isClosed).toBe(false);
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]).toEqual({
      jsonrpc: "2.0",
      id: 1000,
      error: expect.objectContaining({
        code: -32603,
        message: expect.stringContaining("Agent process is not running"),
      }),
    });

    await reader.cancel();
    supervisor.close();
  });
  it("solution: triggerRecycle rejects when process recycle fails", async () => {
    const { child: initialChild } = createMockChild();
    const cache = createSessionCache();
    const session = getOrCreateSession(cache, "sess-fail-recycle");

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild,
      pipeline: new AcpPipeline([]),
      sessionCache: cache,
      spawnProcess: () => {
        throw new Error("simulated spawn failure");
      },
      recycleSpawnAttempts: 1,
      recycleRetryDelayMs: 10,
    });

    await expect(supervisor.triggerRecycle(session)).rejects.toThrow(
      "Process recycle for session sess-fail-recycle failed",
    );
    expect(supervisor.isClosed).toBe(false);
    supervisor.close();
  });
});
