import { describe, expect, it } from "vitest";
import type {
  AcpStreamMessage,
  InboundContext,
  OutboundContext,
  StderrContext,
} from "../../core/types.js";
import {
  createBackgroundTasksFix,
  formatSubagentContent,
  inferToolName,
  parseSubagentsFromArgs,
  type PlanEntry,
} from "./index.js";

const dummyInboundContext = {} as InboundContext;

describe("inferToolName", () => {
  it("identifies subagent execution when tool name is invoke_subagent or schedule", () => {
    expect(inferToolName("invoke_subagent", undefined, undefined)).toBe("invoke_subagent");
    expect(inferToolName("schedule", undefined, undefined)).toBe("schedule");
  });

  it("identifies subagent execution when tool title describes running subagents or schedule", () => {
    expect(inferToolName(undefined, "Running invoke_subagent", undefined)).toBe("invoke_subagent");
    expect(inferToolName(undefined, "Run invoke_subagent?", undefined)).toBe("invoke_subagent");
    expect(inferToolName(undefined, "Running schedule", undefined)).toBe("schedule");
  });

  it("identifies subagent execution when tool arguments contain subagent declarations", () => {
    expect(
      inferToolName(undefined, undefined, {
        Subagents: [{ Role: "Worker", TypeName: "research" }],
      }),
    ).toBe("invoke_subagent");
    expect(
      inferToolName(undefined, undefined, JSON.stringify({ Subagents: [{ Role: "Worker" }] })),
    ).toBe("invoke_subagent");
  });

  it("ignores regular non-subagent tool calls", () => {
    expect(inferToolName("run_command", "Run ls -la", { CommandLine: "ls" })).toBeNull();
    expect(inferToolName(undefined, "view_file", { path: "foo.ts" })).toBeNull();
  });
});

describe("parseSubagentsFromArgs and formatSubagentContent", () => {
  it("formats human-readable task descriptions for each declared subagent", () => {
    const raw = {
      Subagents: [
        { Role: "Inspector", Prompt: "Check things", TypeName: "research" },
        { TypeName: "reviewer", Prompt: "Review code" },
        { Prompt: "Do background analysis" },
      ],
    };
    const subs = parseSubagentsFromArgs(raw);
    expect(subs).toHaveLength(3);
    const [sub0, sub1, sub2] = subs;
    expect(sub0).toBeDefined();
    expect(sub1).toBeDefined();
    expect(sub2).toBeDefined();
    expect(formatSubagentContent(sub0!)).toBe("Subagent: Inspector");
    expect(formatSubagentContent(sub1!)).toBe("Subagent: reviewer");
    expect(formatSubagentContent(sub2!)).toBe("Subagent: Do background analysis");
  });
});

describe("backgroundTasksFix processInbound", () => {
  it("surfaces running subagents as active checklist items in the execution plan", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_subagents";

    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_sub_1",
          title: "Running invoke_subagent",
          kind: "other",
          rawInput: {
            Subagents: [
              { Role: "Worker 1", TypeName: "research" },
              { Role: "Worker 2", TypeName: "research" },
            ],
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const result = (await fix.onInbound?.(msg, dummyInboundContext)) as AcpStreamMessage[];

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(msg);
    expect(result[1]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Subagent: Worker 1", priority: "high", status: "in_progress" },
            { content: "Subagent: Worker 2", priority: "high", status: "in_progress" },
          ],
        },
      },
    });
  });

  it("avoids duplicating checklist items when subsequent progress updates arrive for the same tool", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_subagents";

    const startMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_sub_1",
          title: "Running invoke_subagent",
          rawInput: {
            Subagents: [{ Role: "Worker 1", TypeName: "research" }],
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const updateMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_sub_1",
          title: "Running invoke_subagent",
          status: "in_progress",
          rawInput: {
            Subagents: [{ Role: "Worker 1", TypeName: "research" }],
          },
        },
      },
    } as unknown as AcpStreamMessage;

    await fix.onInbound?.(startMsg, dummyInboundContext);
    const secondResult = (await fix.onInbound?.(
      updateMsg,
      dummyInboundContext,
    )) as AcpStreamMessage[];

    expect(secondResult).toHaveLength(1);
    expect(secondResult[0]).toBe(updateMsg);
  });

  it("marks all active checklist items as completed when background tasks finish and session becomes idle", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_subagents";

    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_sub_1",
          title: "Running invoke_subagent",
          rawInput: {
            Subagents: [{ Role: "Worker 1", TypeName: "research" }],
          },
        },
      },
    } as unknown as AcpStreamMessage;

    await fix.onInbound?.(msg, dummyInboundContext);

    // Turn end while waiting does not complete prematurely
    const waitingTurnEnd = await fix.onTurnEnd?.(sessionId, dummyInboundContext);
    expect(waitingTurnEnd).toEqual([]);

    // When background tasks finish and Go reports idle:
    const forwardedMessages: AcpStreamMessage[] = [];
    const mockStderrContext: StderrContext = {
      forwardInbound: (m: AcpStreamMessage) => {
        forwardedMessages.push(m);
      },
    } as unknown as StderrContext;

    fix.onStderrLine?.(
      `RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"${sessionId}","state":"STATE_FULLY_IDLE"}}`,
      mockStderrContext,
    );

    const completedPlan = forwardedMessages.find((m) => {
      if (!("params" in m) || !m.params || typeof m.params !== "object") return false;
      const p = m.params as { update?: { sessionUpdate?: string; entries?: PlanEntry[] } };
      return p.update?.sessionUpdate === "plan" && p.update.entries?.[0]?.status === "completed";
    });
    expect(completedPlan).toBeDefined();
  });

  it("surfaces a backgrounded command as an active subtask in the execution plan when execution moves to the background", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_bg_cmd";

    // 1. Initial tool_call for run_command
    const toolCallMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_git_commit",
          title: "Run git commit",
          rawInput: {
            CommandLine: "git commit -m 'feat: update infra'",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    await fix.onInbound?.(toolCallMsg, dummyInboundContext);

    // 2. tool_call_update arrives stating the tool was moved to a background task
    const bgResultMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_git_commit",
          rawOutput:
            "Created At: 2026-09-24T11:41:00Z\nTool is running as a background task with task id: sess_bg_cmd/task-3101\nTask Description: git commit -m 'feat: update infra'",
        },
      },
    } as unknown as AcpStreamMessage;

    const result = (await fix.onInbound?.(bgResultMsg, dummyInboundContext)) as AcpStreamMessage[];

    // Expected: Emits the tool_call_update AND a plan update indicating the background task
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(bgResultMsg);
    expect(result[1]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Background task: git commit -m 'feat: update infra'",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      },
    });
  });

  it("prevents prompt turn from ending prematurely while asynchronous tasks are still running in the background", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_waiting_task";

    // 1. Initial prompt starts
    const dummyOutboundContext = {} as OutboundContext;
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "Run git commit" }] },
      } as unknown as AcpStreamMessage,
      dummyOutboundContext,
    );

    // 2. Command backgrounded: localharness reports STATE_WAITING_FOR_TASKS on stderr
    const forwardedMessages: AcpStreamMessage[] = [];
    const mockStderrContext: StderrContext = {
      forwardInbound: (msg: AcpStreamMessage) => {
        forwardedMessages.push(msg);
      },
    } as unknown as StderrContext;

    fix.onStderrLine?.(
      `RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"${sessionId}","state":"STATE_WAITING_FOR_TASKS"}}`,
      mockStderrContext,
    );

    // Verify waiting plan was emitted
    expect(forwardedMessages).toHaveLength(1);
    expect(forwardedMessages[0]).toMatchObject({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ status: "in_progress" }],
        },
      },
    });

    // 3. Upstream agy_acp_server prematurely sends end_turn response for prompt 1
    const prematurePromptResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn" },
    } as unknown as AcpStreamMessage;

    // This inbound prompt response should be intercepted and deferred because we are waiting for tasks!
    const inboundResult = (await fix.onInbound?.(
      prematurePromptResponse,
      dummyInboundContext,
    )) as AcpStreamMessage[];

    // Expect prematurePromptResponse to be deferred (not returned immediately)
    expect(inboundResult).toEqual([]);

    // 4. Upstream onTurnEnd must NOT mark entries completed while waiting for tasks
    const turnEndMsgs = (await fix.onTurnEnd?.(
      sessionId,
      dummyInboundContext,
    )) as AcpStreamMessage[];
    expect(turnEndMsgs).toEqual([]);

    // 5. Later, background task finishes: localharness reports STATE_FULLY_IDLE
    fix.onStderrLine?.(
      `RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"${sessionId}","state":"STATE_FULLY_IDLE"}}`,
      mockStderrContext,
    );

    // Expected: deferred prompt response and completed plan should now be released
    const planCompletedMsg = forwardedMessages.find((m) => {
      if (!("params" in m) || !m.params || typeof m.params !== "object") return false;
      const p = m.params as { update?: { sessionUpdate?: string; entries?: PlanEntry[] } };
      return p.update?.sessionUpdate === "plan" && p.update.entries?.[0]?.status === "completed";
    });
    expect(planCompletedMsg).toBeDefined();

    const releasedEndTurn = forwardedMessages.find((m) => {
      if (!("result" in m) || !m.result || typeof m.result !== "object") return false;
      const r = m.result as { stopReason?: string };
      return r.stopReason === "end_turn";
    });
    expect(releasedEndTurn).toBeDefined();
    expect(releasedEndTurn).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn" },
    });
  });

  it("preserves live stream integrity by never injecting duplicate message chunks or tool calls during task completion", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_stream_integrity";

    // 1. Prompt starts
    const dummyOutboundContext = {} as OutboundContext;
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "Run task" }] },
      } as unknown as AcpStreamMessage,
      dummyOutboundContext,
    );

    const forwardedMessages: AcpStreamMessage[] = [];
    const mockStderrContext: StderrContext = {
      forwardInbound: (msg: AcpStreamMessage) => {
        forwardedMessages.push(msg);
      },
    } as unknown as StderrContext;

    // 2. Command moves to background
    fix.onStderrLine?.(
      `RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"${sessionId}","state":"STATE_WAITING_FOR_TASKS"}}`,
      mockStderrContext,
    );

    // 3. Defer premature end_turn
    await fix.onInbound?.(
      { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } } as unknown as AcpStreamMessage,
      dummyInboundContext,
    );

    // 4. Background task finishes, Antigravity logs STATE_RUNNING
    fix.onStderrLine?.(
      `RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"${sessionId}","state":"STATE_RUNNING"}}`,
      mockStderrContext,
    );

    // 5. Antigravity finishes and logs STATE_FULLY_IDLE
    fix.onStderrLine?.(
      `RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"${sessionId}","state":"STATE_FULLY_IDLE"}}`,
      mockStderrContext,
    );

    // Ensure NO synthetic agent_message_chunk or tool_call messages were injected
    const syntheticChunks = forwardedMessages.filter((m) => {
      if (!("params" in m) || !m.params || typeof m.params !== "object") return false;
      const p = m.params as { update?: { sessionUpdate?: string } };
      return (
        p.update?.sessionUpdate === "agent_message_chunk" ||
        p.update?.sessionUpdate === "tool_call" ||
        p.update?.sessionUpdate === "tool_call_update"
      );
    });
    expect(syntheticChunks).toHaveLength(0);

    // Verify deferred end_turn was released
    const releasedEndTurn = forwardedMessages.find(
      (m) => (m as { result?: { stopReason?: string } }).result?.stopReason === "end_turn",
    );
    expect(releasedEndTurn).toBeDefined();
  });

  it("terminates prompt turn and clears active subtasks immediately when client cancels during background task execution", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_cancel_bg";

    // 1. Prompt starts
    const dummyOutboundContext = {} as OutboundContext;
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "Long task" }] },
      } as unknown as AcpStreamMessage,
      dummyOutboundContext,
    );

    // 2. Command backgrounded
    const forwardedMessages: AcpStreamMessage[] = [];
    const mockStderrContext: StderrContext = {
      forwardInbound: (msg: AcpStreamMessage) => {
        forwardedMessages.push(msg);
      },
    } as unknown as StderrContext;

    fix.onStderrLine?.(
      `RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"${sessionId}","state":"STATE_WAITING_FOR_TASKS"}}`,
      mockStderrContext,
    );

    // 3. Upstream prematurely sends end_turn -> deferred
    await fix.onInbound?.(
      { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } } as unknown as AcpStreamMessage,
      dummyInboundContext,
    );

    // 4. Client sends session/cancel while task is running
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    } as unknown as AcpStreamMessage;
    fix.onOutbound?.(cancelMsg, dummyOutboundContext);

    // 5. Upstream sends cancelled prompt response
    // If upstream returns result stopReason: "cancelled", it must NOT be deferred!
    const cancelResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "cancelled" },
    } as unknown as AcpStreamMessage;

    const inboundResult = await fix.onInbound?.(cancelResponse, dummyInboundContext);
    expect(inboundResult).toEqual([cancelResponse]); // NOT deferred!

    // 6. Active checklist items should be marked completed
    const entries = fix.tracker.getEntries(sessionId);
    expect(entries.every((e) => e.status === "completed")).toBe(true);
  });

  it("holds turn open when subagent execution begins even before stderr telemetry arrives", async () => {
    const fix = createBackgroundTasksFix();
    const sessionId = "sess_subagent_hold";

    // 1. Prompt starts
    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "Spawn helper" }] },
      } as unknown as AcpStreamMessage,
      {} as OutboundContext,
    );

    // 2. Tool call arrives for invoke_subagent
    const toolMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_sub",
          name: "invoke_subagent",
          rawInput: {
            Subagents: [{ Role: "Helper", TypeName: "research" }],
          },
        },
      },
    } as unknown as AcpStreamMessage;
    await fix.onInbound?.(toolMsg, dummyInboundContext);

    // 3. Upstream immediately sends end_turn before stderr line arrives
    const prematureEndTurn: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "end_turn" },
    } as unknown as AcpStreamMessage;

    const res = await fix.onInbound?.(prematureEndTurn, dummyInboundContext);
    // Must be deferred!
    expect(res).toEqual([]);
    expect(fix.tracker.isWaitingForTasks(sessionId)).toBe(true);
  });
});
