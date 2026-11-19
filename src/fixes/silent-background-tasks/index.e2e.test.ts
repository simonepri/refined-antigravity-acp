import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  type AcpFix,
  type AcpStreamMessage,
  type StderrContext,
} from "../../core/types.js";
import { AcpPipeline } from "../../core/pipeline.js";
import { ProcessSupervisor } from "../../core/supervisor.js";
import { createBackgroundTasksFix, type PlanEntry } from "./index.js";
import { createDefaultFixes } from "../index.js";

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

describe("silent-background-tasks e2e", () => {
  it("problem: raw agy stderr emits STATE_WAITING_FOR_TASKS without stdout plan notifications", () => {
    const line =
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_1","state":"STATE_WAITING_FOR_TASKS"}}';
    expect(line).toContain("STATE_WAITING_FOR_TASKS");
  });

  it("solution: wrapped connector synthesizes session/update plan notifications for background tasks", () => {
    const fix = createBackgroundTasksFix();
    const emitted: AcpStreamMessage[] = [];
    const stderrContext: StderrContext = {
      sessionCache: {
        sessions: new Map(),
        pendingSessionMetadata: new Map(),
        pendingRequestSessions: new Map(),
      },
      forwardInbound: (msg) => {
        emitted.push(msg);
      },
      writeToChild: async () => {},
      sendInternalRequest: async () => ({}) as AcpStreamMessage,
      triggerRecycle: async () => {},
      declareHang: () => {},
    };

    fix.onStderrLine?.(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_test","state":"STATE_WAITING_FOR_TASKS"}}',
      stderrContext,
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_test",
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Running background subagents and tasks",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      },
    });

    fix.onStderrLine?.(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_test","state":"STATE_RUNNING"}}',
      stderrContext,
    );

    expect(emitted).toHaveLength(2);
    const secondMsg = emitted[1] as {
      params: { update: { entries: Array<{ status: string }> } };
    };
    expect(secondMsg.params.update.entries[0]?.status).toBe("completed");
  });

  it("problem: raw agy passes Subagents as a string-encoded JSON array in invoke_subagent args", () => {
    const rawArgs = {
      Subagents: JSON.stringify([
        { Role: "Worker 1", Prompt: "Task 1" },
        { Role: "Worker 2", Prompt: "Task 2" },
      ]),
    };
    expect(typeof rawArgs.Subagents).toBe("string");
    expect(Array.isArray(rawArgs.Subagents)).toBe(false);
  });

  it("solution: wrapped connector parses string-encoded Subagents array and synthesizes plan notifications", async () => {
    const fix = createBackgroundTasksFix();
    const inboundContext = {
      sessionCache: {
        sessions: new Map(),
        pendingSessionMetadata: new Map(),
        pendingRequestSessions: new Map(),
      },
      forwardInbound: () => {},
      writeToChild: async () => {},
      sendInternalRequest: async () => ({}) as AcpStreamMessage,
      triggerRecycle: async () => {},
      declareHang: () => {},
    };

    const toolCallMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_subagents",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_sub_1",
          name: "invoke_subagent",
          rawInput: {
            Subagents: JSON.stringify([
              { Role: "Research Agent", Prompt: "Investigate module A" },
              { Role: "Verification Agent", Prompt: "Run tests on module B" },
            ]),
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const msgs = (await fix.onInbound?.(toolCallMsg, inboundContext)) ?? [];
    expect(msgs).toHaveLength(2);

    const planMsg = msgs[1] as {
      params: {
        update: {
          sessionUpdate: string;
          entries: Array<{ content: string; status: string; priority: string }>;
        };
      };
    };
    expect(planMsg.params.update.sessionUpdate).toBe("plan");
    expect(planMsg.params.update.entries).toHaveLength(2);
    expect(planMsg.params.update.entries[0]?.content).toBe("Subagent: Research Agent");
    expect(planMsg.params.update.entries[0]?.status).toBe("in_progress");
    expect(planMsg.params.update.entries[1]?.content).toBe("Subagent: Verification Agent");
    expect(planMsg.params.update.entries[1]?.status).toBe("in_progress");
  });

  it("problem: deferring prompt response during background task execution causes client turn to hang indefinitely", async () => {
    // Reproduction of v1.4.0 defect:
    // In v1.4.0, when a background task or subagent was launched, silent-background-tasks
    // intercepted the end_turn prompt response and dropped it to wait for STATE_FULLY_IDLE.
    // Because agy_acp_server never emits STATE_FULLY_IDLE and promptSettlementTimeoutMs=0,
    // the client stream never receives the prompt response and the turn hangs forever.
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    // Simulate v1.4.0 interceptor behavior that defers end_turn while waiting for tasks
    let isWaitingForTasks = false;
    const v140DeferredFix: AcpFix = {
      name: "v140-deferred-fix",
      onInbound(msg: AcpStreamMessage): AcpStreamMessage[] {
        const u = (msg as { params?: { update?: { sessionUpdate?: string; name?: string } } })
          ?.params?.update;
        if (u?.sessionUpdate === SESSION_UPDATES.TOOL_CALL && u.name === "invoke_subagent") {
          isWaitingForTasks = true;
        }
        if ("result" in msg && isWaitingForTasks) {
          // Drops prompt response!
          return [];
        }
        return [msg];
      },
    };

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([v140DeferredFix]),
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

    // 1. Client initiates prompt turn
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 101,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "sess-v140-hang", prompt: [] },
    } as unknown as AcpStreamMessage);

    // 2. Upstream emits tool call for subagent
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-v140-hang",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-sub-1",
            name: "invoke_subagent",
          },
        },
      }),
    );

    // 3. Upstream finishes its turn with end_turn
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        result: { stopReason: "end_turn" },
      }),
    );

    // Wait a brief tick to allow any pipeline dispatching
    await new Promise((resolve) => setTimeout(resolve, 50));

    // REPRODUCE DEFECT: Client NEVER receives the prompt response (id: 101),
    // causing the UI spinner to run indefinitely ("it never stops")
    const receivedPromptResponse = forwarded.find(
      (m) => "id" in m && m.id === 101 && "result" in m,
    );
    expect(receivedPromptResponse).toBeUndefined();

    await reader.cancel();
    supervisor.close();
  });

  it("solution: wrapped connector forwards prompt response immediately to client while tracking background tasks in synthesized plan", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const fix = createBackgroundTasksFix();
    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline([fix]),
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

    // 1. Client initiates prompt turn
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 202,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "sess-fix-complete", prompt: [] },
    } as unknown as AcpStreamMessage);

    // 2. Upstream emits tool call for subagent
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-fix-complete",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-sub-2",
            name: "invoke_subagent",
            rawInput: {
              Subagents: [{ Role: "Worker Agent", TypeName: "research" }],
            },
          },
        },
      }),
    );

    // 3. Upstream finishes its turn with end_turn
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 202,
        result: { stopReason: "end_turn" },
      }),
    );

    // Wait a brief tick to allow any pipeline dispatching
    await new Promise((resolve) => setTimeout(resolve, 50));

    // VERIFY FIX: Prompt response (id: 202) is immediately delivered to the client, stopping the spinner!
    const receivedPromptResponse = forwarded.find(
      (m) => "id" in m && m.id === 202 && "result" in m,
    ) as { result?: { stopReason?: string } } | undefined;
    expect(receivedPromptResponse).toBeDefined();
    expect(receivedPromptResponse?.result?.stopReason).toBe("end_turn");

    // VERIFY PLAN: Synthesized plan update was emitted to track the active background subagent
    const planUpdate = forwarded.find(
      (m) =>
        "params" in m &&
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate === "plan",
    ) as
      | { params: { update: { entries: Array<{ content: string; status: string }> } } }
      | undefined;
    expect(planUpdate).toBeDefined();
    expect(planUpdate?.params.update.entries[0]?.content).toBe("Subagent: Worker Agent");
    expect(planUpdate?.params.update.entries[0]?.status).toBe("in_progress");

    await reader.cancel();
    supervisor.close();
  });

  it("problem: upstream halts in STATE_WAITING_FOR_TASKS after streaming assistant question without emitting terminal prompt response, freezing client spinner indefinitely", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    // Raw pipeline without hardening fixes
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

    // 1. Client sends prompt
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 301,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "sess-waiting-turn-hang",
        prompt: [{ type: "text", text: "Is there a way to make it faster?" }],
      },
    } as unknown as AcpStreamMessage);

    // 2. Upstream streams assistant message ending with a question
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-waiting-turn-hang",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: {
              type: "text",
              text: "Ready to proceed? I will commit and push the working tree, then launch the 5 parallel subagents.",
            },
          },
        },
      }),
    );

    // 3. Upstream emits usage_update
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-waiting-turn-hang",
          update: {
            sessionUpdate: SESSION_UPDATES.USAGE_UPDATE,
            used: 1250,
            size: 1000000,
          },
        },
      }),
    );

    // 4. Upstream localharness remains in STATE_WAITING_FOR_TASKS on stderr
    supervisor.handleStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess-waiting-turn-hang","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    // 5. Upstream produces NO prompt response { id: 301, result: ... }!
    await new Promise((resolve) => setTimeout(resolve, 100));

    // In raw agy, prompt response is never received, freezing client spinner indefinitely
    const receivedPromptResponse = forwarded.find(
      (m) => "id" in m && m.id === 301 && "result" in m,
    );
    expect(receivedPromptResponse).toBeUndefined();

    await reader.cancel();
    supervisor.close();
  });

  it("solution: wrapped connector synthesizes prompt settlement when upstream halts in STATE_WAITING_FOR_TASKS after streaming assistant question", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline(createDefaultFixes()),
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

    // 1. Client sends prompt (e.g. "Is there a way to make it faster?")
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 301,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "sess-waiting-turn-hang",
        prompt: [{ type: "text", text: "Is there a way to make it faster?" }],
      },
    } as unknown as AcpStreamMessage);

    // 2. Upstream streams assistant message ending with a question
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-waiting-turn-hang",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: {
              type: "text",
              text: "Ready to proceed? I will commit and push the working tree, then launch the 5 parallel subagents.",
            },
          },
        },
      }),
    );

    // 3. Upstream emits usage_update
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-waiting-turn-hang",
          update: {
            sessionUpdate: SESSION_UPDATES.USAGE_UPDATE,
            used: 1250,
            size: 1000000,
          },
        },
      }),
    );

    // 4. Upstream localharness remains in STATE_WAITING_FOR_TASKS on stderr
    supervisor.handleStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess-waiting-turn-hang","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    // 5. Upstream produces NO prompt response { id: 301, result: ... }!
    // Wait briefly for prompt settlement synthesis (50ms timer)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Client MUST receive synthesized prompt response (id: 301) with end_turn so Paseo clears the spinner!
    const receivedPromptResponse = forwarded.find(
      (m) => "id" in m && m.id === 301 && "result" in m,
    ) as { result?: { stopReason?: string } } | undefined;

    expect(receivedPromptResponse).toBeDefined();
    expect(receivedPromptResponse?.result?.stopReason).toBe("end_turn");

    await reader.cancel();
    supervisor.close();
  });

  it("solution: synthesizes detailed task titles for flat subagent invocations and background tasks", async () => {
    const { child } = createMockChild();
    const forwarded: AcpStreamMessage[] = [];

    const supervisor = new ProcessSupervisor({
      cmd: "mock-agy",
      args: [],
      initialChild: child,
      pipeline: new AcpPipeline(createDefaultFixes()),
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

    // 1. Client sends prompt
    await supervisor.handleOutbound({
      jsonrpc: "2.0",
      id: 501,
      method: ACP_METHODS.SESSION_PROMPT,
      params: {
        sessionId: "sess-detailed-titles",
        prompt: [{ type: "text", text: "Audit the build and benchmark in the background" }],
      },
    } as unknown as AcpStreamMessage);

    // 2. Upstream emits flat invoke_subagent tool call (without Subagents wrapper array)
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-detailed-titles",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-sub-auditor",
            name: "invoke_subagent",
            rawInput: {
              Role: "Bazel Performance Auditor",
              Prompt: "Analyze build traces for remote cache bottlenecks",
              TypeName: "research",
            },
          },
        },
      }),
    );

    // 3. Upstream emits run_command tool call with toolSummary
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-detailed-titles",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: "call-bench-task",
            rawInput: {
              CommandLine: "python3 bench.py",
              toolSummary: "Test tuned flags and fresh output_base size",
            },
          },
        },
      }),
    );

    // 4. Background task execution notification for run_command
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-detailed-titles",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
            toolCallId: "call-bench-task",
            rawOutput:
              "Tool is running as a background task with task id: sess-detailed-titles/task-4532\nTask logs are available at: ...",
          },
        },
      }),
    );

    // 5. Upstream localharness polls manage_subagents with bare conversationId and state
    await supervisor.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId: "sess-detailed-titles",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
            toolCallId: "call-manage-sub",
            name: "manage_subagents",
            rawOutput: JSON.stringify([{ conversationId: "sub-101", state: "running" }]),
          },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    // VERIFY: The plan contains the descriptive subagent title and background task title,
    // and NO generic "Subagent: Background Task" or bare "Background task: task-4532"!
    const planUpdates = forwarded.filter(
      (m) =>
        "params" in m &&
        (m.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate === "plan",
    ) as Array<{ params: { update: { entries: PlanEntry[] } } }>;

    expect(planUpdates.length).toBeGreaterThan(0);
    const lastPlan = planUpdates.at(-1)!;
    const entryContents = lastPlan.params.update.entries.map((e) => e.content);

    expect(entryContents).toContain("Subagent: Bazel Performance Auditor");
    expect(entryContents).toContain("Background task: Test tuned flags and fresh output_base size");
    expect(entryContents).not.toContain("Subagent: Background Task");

    await reader.cancel();
    supervisor.close();
  });
});
