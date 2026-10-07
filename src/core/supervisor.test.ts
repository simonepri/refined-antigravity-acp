import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { ACP_METHODS, SESSION_UPDATES, STOP_REASONS, type AcpStreamMessage } from "./types.js";
import { AcpPipeline } from "./pipeline.js";
import { ProcessSupervisor } from "./supervisor.js";
import { getOrCreateSession } from "./session-cache.js";

function createMockChild(): {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  let isKilled = false;
  const child = {
    stdout,
    stderr,
    stdin,
    get killed() {
      return isKilled;
    },
    on: () => child,
    once: () => child,
    kill: () => {
      isKilled = true;
      return true;
    },
  } as unknown as ChildProcess;

  return { child, stdout, stderr, stdin };
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

  it("marks session for recycle when upstream emits agent connection loss chunk", async () => {
    const { child } = createMockChild();
    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([]),
    });
    const streams = supervisor.createStreams();
    const reader = streams.readable.getReader();

    // Allocate session in cache
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 200,
      method: ACP_METHODS.SESSION_NEW,
      params: { cwd: "/tmp" },
    } as unknown as AcpStreamMessage);
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 200,
        result: { sessionId: "session-conn-lost" },
      }),
    );

    const session = supervisor.sessionCache.sessions.get("session-conn-lost");
    expect(session).toBeDefined();
    expect(session?.needsRecycle).toBeFalsy();

    // Upstream emits agent connection loss message chunk
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

    expect(session?.needsRecycle).toBe(true);

    await reader.cancel();
    supervisor.close();
  });
});
