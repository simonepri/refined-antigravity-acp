import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  type AcpStreamMessage,
  type SessionUpdateParams,
  type SessionUpdatePayload,
} from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import { createInterleavedStreamToolCallsFix } from "./index.js";

function makeMessageChunk(sessionId: string, text: string): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
        content: { type: "text", text },
      },
    },
  };
}

function makeToolCallMessage(
  sessionId: string,
  toolCallId: string,
  name: string,
  rawInput: Record<string, unknown>,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.TOOL_CALL,
        toolCallId,
        name,
        rawInput,
        status: "in_progress",
      },
    },
  };
}

function makeToolCallUpdateMessage(
  sessionId: string,
  toolCallId: string,
  status: "completed" | "failed" = "completed",
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
        toolCallId,
        status,
      },
    },
  };
}

function makePlanMessage(
  sessionId: string,
  entries: Array<{ id: string; title: string; status: string }>,
): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.PLAN,
        entries,
      },
    },
  };
}

function makeNoticeMessage(sessionId: string, message: string): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_METHODS.SESSION_UPDATE,
    params: {
      sessionId,
      update: {
        sessionUpdate: SESSION_UPDATES.NOTICE,
        message,
      },
    },
  };
}

function makePromptSuccessResponse(promptId: string | number, sessionId: string): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: "end_turn" },
    params: { sessionId },
  } as unknown as AcpStreamMessage;
}

describe("interleaved-stream-tool-calls problem reproduction", () => {
  it("problem: raw unbuffered stream interleaves concurrent tool calls into streaming assistant text, splitting markdown links", () => {
    const rawEvents: AcpStreamMessage[] = [
      makeMessageChunk("s1", "1. Local-only -XX:ActiveProcessorCount=8 + -Xmx4g in ['."),
      makeToolCallMessage("s1", "call_sub_1", "view_file", {
        AbsolutePath: "src/bazel/tools/ci/auth.py",
      }),
      makeMessageChunk(
        "s1",
        "bazelrc ](file:///Users/simonepri/GitHub/boltz-bio/depot/.bazelrc), overridden in CI via [ src/bazel/tools/ci/auth.py ](file:///Users/simonepri/GitHub/bol",
      ),
      makeToolCallMessage("s1", "call_sub_2", "view_file", {
        AbsolutePath: "src/bazel/profiles/profiles.bazelrc",
      }),
      makeMessageChunk(
        "s1",
        "tz-bio/depot/src/bazel/tools/ci/auth.py)'s `.bazelrc.user` so CI runners continue.",
      ),
    ];

    const updates = rawEvents.map((m) =>
      "params" in m
        ? ((m.params as SessionUpdateParams | undefined)?.update as SessionUpdatePayload)
        : undefined,
    );

    expect(updates[0]?.sessionUpdate).toBe("agent_message_chunk");
    expect(updates[1]?.sessionUpdate).toBe("tool_call");
    expect(updates[2]?.sessionUpdate).toBe("agent_message_chunk");
    expect(updates[3]?.sessionUpdate).toBe("tool_call");
    expect(updates[4]?.sessionUpdate).toBe("agent_message_chunk");

    const content0 = updates[0]?.content as { text?: string } | undefined;
    const chunk0Text = content0?.text ?? "";
    expect(chunk0Text.endsWith("['.")).toBe(true);

    const content2 = updates[2]?.content as { text?: string } | undefined;
    const chunk2Text = content2?.text ?? "";
    expect(chunk2Text.startsWith("bazelrc ]")).toBe(true);
  });
});

describe("interleaved-stream-tool-calls solution verification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("solution: buffers concurrent tool calls while assistant text is streaming and flushes them on stream settlement", () => {
    const forwarded: AcpStreamMessage[] = [];
    const mockContext = createMockContext({
      forwardInbound: (msg) => forwarded.push(msg),
    });

    const fix = createInterleavedStreamToolCallsFix({ idleTimeoutMs: 100 });
    const sessionId = "s1";

    const chunk1 = makeMessageChunk(sessionId, "1. Local-only in ['.");
    const tool1 = makeToolCallMessage(sessionId, "call_1", "view_file", {
      AbsolutePath: "auth.py",
    });
    const chunk2 = makeMessageChunk(sessionId, "bazelrc ](file:///auth.py).");
    const tool2 = makeToolCallMessage(sessionId, "call_2", "view_file", {
      AbsolutePath: "profiles.bazelrc",
    });
    const chunk3 = makeMessageChunk(sessionId, " Done!");

    const out1 = fix.onInbound?.(chunk1, mockContext);
    expect(out1).toEqual([chunk1]);

    const outTool1 = fix.onInbound?.(tool1, mockContext);
    expect(outTool1).toEqual([]);

    const out2 = fix.onInbound?.(chunk2, mockContext);
    expect(out2).toEqual([chunk2]);

    const outTool2 = fix.onInbound?.(tool2, mockContext);
    expect(outTool2).toEqual([]);

    const out3 = fix.onInbound?.(chunk3, mockContext);
    expect(out3).toEqual([chunk3]);

    const emittedChunks = [out1, out2, out3].flat() as AcpStreamMessage[];
    const fullText = emittedChunks
      .map((m) => {
        const update = "params" in m ? (m.params as SessionUpdateParams).update : undefined;
        return (update?.content as { text: string } | undefined)?.text ?? "";
      })
      .join("");
    expect(fullText).toBe("1. Local-only in ['.bazelrc ](file:///auth.py). Done!");

    expect(forwarded).toEqual([]);

    vi.advanceTimersByTime(150);

    expect(forwarded).toEqual([tool1, tool2]);

    fix.dispose?.();
  });

  it("solution: flushes buffered tool calls before prompt success response", () => {
    const mockContext = createMockContext();
    const fix = createInterleavedStreamToolCallsFix({ idleTimeoutMs: 200 });
    const sessionId = "s1";

    const chunk1 = makeMessageChunk(sessionId, "Preparing changes in ['");
    const tool1 = makeToolCallMessage(sessionId, "call_1", "view_file", {
      AbsolutePath: "defs.bzl",
    });
    const chunk2 = makeMessageChunk(sessionId, "defs.bzl ](file:///defs.bzl).");

    fix.onInbound?.(chunk1, mockContext);
    fix.onInbound?.(tool1, mockContext);
    fix.onInbound?.(chunk2, mockContext);

    const promptResponse = makePromptSuccessResponse(42, sessionId);
    const result = fix.onInbound?.(promptResponse, mockContext) as AcpStreamMessage[];

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(tool1);
    expect(result[1]).toBe(promptResponse);

    fix.dispose?.();
  });

  it("solution: buffers tool_call_update for buffered tool calls, but passes updates for already-emitted tool calls", () => {
    const mockContext = createMockContext();
    const fix = createInterleavedStreamToolCallsFix({ idleTimeoutMs: 200 });
    const sessionId = "s1";

    const earlyTool = makeToolCallMessage(sessionId, "early_call", "run_command", {
      CommandLine: "ls",
    });
    const earlyOut = fix.onInbound?.(earlyTool, mockContext);
    expect(earlyOut).toEqual([earlyTool]);

    const chunk1 = makeMessageChunk(sessionId, "Looking at results...");
    fix.onInbound?.(chunk1, mockContext);

    const earlyUpdate = makeToolCallUpdateMessage(sessionId, "early_call", "completed");
    const earlyUpdateOut = fix.onInbound?.(earlyUpdate, mockContext);
    expect(earlyUpdateOut).toEqual([earlyUpdate]);

    const subTool = makeToolCallMessage(sessionId, "sub_call", "view_file", {
      AbsolutePath: "a.py",
    });
    expect(fix.onInbound?.(subTool, mockContext)).toEqual([]);

    const subUpdate = makeToolCallUpdateMessage(sessionId, "sub_call", "completed");
    expect(fix.onInbound?.(subUpdate, mockContext)).toEqual([]);

    const promptResponse = makePromptSuccessResponse(99, sessionId);
    const finalOut = fix.onInbound?.(promptResponse, mockContext) as AcpStreamMessage[];

    expect(finalOut).toEqual([subTool, subUpdate, promptResponse]);

    fix.dispose?.();
  });

  it("solution: passes normal sequential tool calls through immediately without delay when not streaming", () => {
    const mockContext = createMockContext();
    const fix = createInterleavedStreamToolCallsFix();
    const sessionId = "s1";

    const tool = makeToolCallMessage(sessionId, "call_1", "run_command", { CommandLine: "pwd" });
    const update = makeToolCallUpdateMessage(sessionId, "call_1", "completed");

    expect(fix.onInbound?.(tool, mockContext)).toEqual([tool]);
    expect(fix.onInbound?.(update, mockContext)).toEqual([update]);

    fix.dispose?.();
  });

  it("solution: flushes buffered tool calls on onTurnEnd", () => {
    const mockContext = createMockContext();
    const fix = createInterleavedStreamToolCallsFix();
    const sessionId = "s1";

    const chunk = makeMessageChunk(sessionId, "Starting subagent...");
    const tool = makeToolCallMessage(sessionId, "call_sub", "run_command", {
      CommandLine: "git status",
    });

    fix.onInbound?.(chunk, mockContext);
    fix.onInbound?.(tool, mockContext);

    const flushed = fix.onTurnEnd?.(sessionId, mockContext);
    expect(flushed).toEqual([tool]);

    fix.dispose?.();
  });

  it("solution: flushes buffered tool calls on outbound session/prompt or session/cancel", () => {
    const fix = createInterleavedStreamToolCallsFix();
    const sessionId = "s1";
    const mockContext = createMockContext();

    const chunk = makeMessageChunk(sessionId, "Streaming...");
    const tool = makeToolCallMessage(sessionId, "call_sub", "view_file", { AbsolutePath: "b.py" });

    fix.onInbound?.(chunk, mockContext);
    fix.onInbound?.(tool, mockContext);

    const promptOutbound: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 123,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId, prompt: [] },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(promptOutbound, mockContext);

    const nextTurn = fix.onTurnEnd?.(sessionId, mockContext);
    expect(nextTurn).toEqual([]);

    fix.dispose?.();
  });

  it("solution: isolates stream state and buffers per sessionId", () => {
    const mockContext = createMockContext();
    const fix = createInterleavedStreamToolCallsFix({ idleTimeoutMs: 200 });

    const chunkA = makeMessageChunk("sessA", "Session A text...");
    fix.onInbound?.(chunkA, mockContext);

    const toolB = makeToolCallMessage("sessB", "call_B", "view_file", { AbsolutePath: "test.txt" });
    const outB = fix.onInbound?.(toolB, mockContext);
    expect(outB).toEqual([toolB]);

    const toolA = makeToolCallMessage("sessA", "call_A", "view_file", { AbsolutePath: "a.txt" });
    const outA = fix.onInbound?.(toolA, mockContext);
    expect(outA).toEqual([]);

    fix.dispose?.();
  });

  it("solution: buffers background task plan updates during active assistant text streaming", () => {
    const forwarded: AcpStreamMessage[] = [];
    const mockContext = createMockContext({
      forwardInbound: (msg) => forwarded.push(msg),
    });

    const fix = createInterleavedStreamToolCallsFix({ idleTimeoutMs: 200 });
    const sessionId = "s1";

    // Text chunk 1 arrives (e.g. "I launched background task to create .worktrees")
    const chunk1 = makeMessageChunk(sessionId, "I launched background task to create .worktrees");
    const outChunk1 = fix.onInbound?.(chunk1, mockContext);
    expect(outChunk1).toEqual([chunk1]);

    // Background task plan update arrives concurrently while assistant text is streaming
    const planMsg = makePlanMessage(sessionId, [
      { id: "task-2829", title: "create worktree", status: "in_progress" },
    ]);
    const outPlan = fix.onInbound?.(planMsg, mockContext);
    // Crucial: plan message must be buffered, not emitted mid-stream!
    expect(outPlan).toEqual([]);

    // Text chunk 2 arrives (e.g. "/narrow-all-files-diff worktree...")
    const chunk2 = makeMessageChunk(sessionId, "/narrow-all-files-diff worktree...");
    const outChunk2 = fix.onInbound?.(chunk2, mockContext);
    expect(outChunk2).toEqual([chunk2]);

    // Stream settles via idle timeout
    vi.advanceTimersByTime(200);

    // Plan update is flushed without splitting the text chunks
    expect(forwarded).toEqual([planMsg]);

    fix.dispose?.();
  });

  it("solution: buffers notice updates during active assistant text streaming", () => {
    const forwarded: AcpStreamMessage[] = [];
    const mockContext = createMockContext({
      forwardInbound: (msg) => forwarded.push(msg),
    });

    const fix = createInterleavedStreamToolCallsFix({ idleTimeoutMs: 200 });
    const sessionId = "s1";

    const chunk1 = makeMessageChunk(sessionId, "Processing data...");
    fix.onInbound?.(chunk1, mockContext);

    const notice = makeNoticeMessage(sessionId, "Compacting context...");
    const outNotice = fix.onInbound?.(notice, mockContext);
    expect(outNotice).toEqual([]);

    vi.advanceTimersByTime(200);
    expect(forwarded).toEqual([notice]);

    fix.dispose?.();
  });

  it("solution: does not buffer plan updates when stream is inactive", () => {
    const mockContext = createMockContext();
    const fix = createInterleavedStreamToolCallsFix();
    const sessionId = "s1";

    const planMsg = makePlanMessage(sessionId, [
      { id: "task-1", title: "task 1", status: "completed" },
    ]);
    const out = fix.onInbound?.(planMsg, mockContext);
    expect(out).toEqual([planMsg]);

    fix.dispose?.();
  });
});
