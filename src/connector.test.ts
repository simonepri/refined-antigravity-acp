import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import type { ChildProcess } from "node:child_process";
import {
  ChildSlot,
  createAcpReadableStream,
  createAcpWritableStream,
  createSystemPromptState,
  DEFAULT_HANG_GRACE_MS,
  DEFAULT_HANG_INACTIVITY_MS,
  filterConfigOptions,
  HangDetector,
  parseStepUpdate,
  parseTrajectoryStateUpdate,
  processInboundMessage,
  processOutboundMessage,
  RECYCLE_CONFIG_PREFIX,
  RECYCLE_INIT_ID,
  RECYCLE_LOAD_ID,
  RECYCLE_MODE_ID,
  rewriteMcpServers,
} from "./connector.js";
import { StreamSanitizer } from "./sanitize.js";
import type { AcpStreamMessage } from "@getpaseo/plugin/server/acp";

describe("filterConfigOptions", () => {
  it("removes option with id: mode from configOptions", () => {
    const result = {
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select" },
        { id: "mode", name: "Session Mode", category: "mode", type: "select" },
        { id: "other_setting", name: "Other", type: "boolean" },
      ],
    };

    filterConfigOptions(result);

    expect(result.configOptions).toEqual([
      { id: "model", name: "Model", category: "model", type: "select" },
      { id: "other_setting", name: "Other", type: "boolean" },
    ]);
  });

  it("removes option with category: mode even if id differs", () => {
    const result = {
      configOptions: [
        { id: "custom_mode", name: "Mode Selector", category: "mode", type: "select" },
        { id: "model", name: "Model", category: "model", type: "select" },
      ],
    };

    filterConfigOptions(result);

    expect(result.configOptions).toEqual([
      { id: "model", name: "Model", category: "model", type: "select" },
    ]);
  });

  it("handles null, undefined, or missing configOptions gracefully", () => {
    expect(() => filterConfigOptions(null)).not.toThrow();
    expect(() => filterConfigOptions(undefined)).not.toThrow();
    expect(() => filterConfigOptions({})).not.toThrow();
    expect(() => filterConfigOptions({ configOptions: "invalid" })).not.toThrow();
  });
});

describe("rewriteMcpServers", () => {
  it("normalizes object headers to array and leaves the transport type alone", async () => {
    const servers = [
      {
        name: "test-server",
        type: "http",
        url: "http://127.0.0.1:8080/mcp",
        headers: { Authorization: "Bearer xyz", "X-Custom": "val" },
      },
    ];

    await rewriteMcpServers(servers);

    // agy supports http natively; rewriting it to sse only misdescribed the endpoint.
    expect(servers[0].type).toBe("http");
    expect(servers[0].headers).toEqual([
      { name: "Authorization", value: "Bearer xyz" },
      { name: "X-Custom", value: "val" },
    ]);
  });

  it("routes server.url through the proxy pool when provided", async () => {
    const pool = {
      rewriteUrl: async (url: string) =>
        `http://127.0.0.1:9999${new URL(url).pathname}${new URL(url).search}`,
    };
    const servers = [
      {
        name: "paseo",
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=a1",
      },
    ];

    await rewriteMcpServers(servers, pool as any);

    expect(servers[0].type).toBe("http");
    expect(servers[0].url).toBe("http://127.0.0.1:9999/mcp/agents?callerAgentId=a1");
  });

  it("propagates a proxy failure instead of leaving the URL un-normalized", async () => {
    const pool = {
      rewriteUrl: async () => {
        throw new Error("MCP proxy for http://127.0.0.1:6767 is not running");
      },
    };
    const servers = [{ name: "paseo", type: "http", url: "http://127.0.0.1:6767/mcp/agents" }];

    await expect(rewriteMcpServers(servers, pool as any)).rejects.toThrow(/not running/);
    expect(servers[0].url).toBe("http://127.0.0.1:6767/mcp/agents");
  });

  it("normalizes array headers with key property to name property", async () => {
    const servers = [
      {
        name: "test-array",
        type: "http",
        url: "http://127.0.0.1:8080/mcp",
        headers: [{ key: "Authorization", value: "Bearer token" }],
      },
    ];

    await rewriteMcpServers(servers);

    expect(servers[0].headers).toEqual([{ name: "Authorization", value: "Bearer token" }]);
  });
});

describe("processOutboundMessage", () => {
  it("rewrites mcpServers and maps modeId in session/new", async () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd: "/test",
        modeId: "accept-edits",
        mcpServers: [
          {
            name: "local",
            type: "http",
            url: "http://localhost:3000/sse",
          },
        ],
      },
    } as unknown as AcpStreamMessage;

    const out = (await processOutboundMessage(msg)) as unknown as {
      params: { modeId: string; mcpServers: Array<{ type: string }> };
    };

    expect(out.params.modeId).toBe("auto_edit");
    expect(out.params.mcpServers[0].type).toBe("http");
  });

  it("maps dangerously-skip-permissions to yolo and plan to default", async () => {
    const msg1 = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/set_mode",
      params: { modeId: "dangerously-skip-permissions" },
    } as unknown as AcpStreamMessage;
    const out1 = (await processOutboundMessage(msg1)) as unknown as { params: { modeId: string } };
    expect(out1.params.modeId).toBe("yolo");

    const msg2 = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { modeId: "plan" },
    } as unknown as AcpStreamMessage;
    const out2 = (await processOutboundMessage(msg2)) as unknown as { params: { modeId: string } };
    expect(out2.params.modeId).toBe("default");
  });
});

describe("processInboundMessage", () => {
  it("filters mode configOptions from response", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "sess_1",
        configOptions: [{ id: "mode" }, { id: "model" }],
      },
    } as unknown as AcpStreamMessage;

    const [out] = processInboundMessage(msg) as unknown as Array<{
      result: { configOptions: unknown[] };
    }>;
    expect(out.result.configOptions).toEqual([{ id: "model" }]);
  });

  it("sanitizes assistant text updates", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          content: { text: "Hello <system_message>hidden</system_message> world" },
        },
      },
    } as unknown as AcpStreamMessage;

    const [out] = processInboundMessage(msg) as unknown as Array<{
      params: { update: { content: { text: string } } };
    }>;
    expect(out.params.update.content.text).toBe("Hello  world");
  });

  it("emits buffered look-ahead text at the turn boundary instead of dropping it", () => {
    const sanitizer = new StreamSanitizer();
    const state = { lastSessionId: null as string | null };

    // A trailing "<" is held back in case it opens a harness tag.
    const chunk = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_1",
        update: { sessionUpdate: "agent_message_chunk", content: { text: "keep 5 <" } },
      },
    } as unknown as AcpStreamMessage;
    const streamed = processInboundMessage(chunk, sanitizer, state) as unknown as Array<{
      params: { update: { content: { text: string } } };
    }>;
    expect(streamed[0].params.update.content.text).toBe("keep 5 ");

    // The turn ends without the tag ever arriving, so the held text is real output.
    const response = { jsonrpc: "2.0", id: 7, result: { ok: true } } as unknown as AcpStreamMessage;
    const flushed = processInboundMessage(response, sanitizer, state) as unknown as Array<{
      params?: { sessionId?: string; update?: { content?: { text?: string } } };
      result?: unknown;
    }>;
    expect(flushed).toHaveLength(2);
    expect(flushed[0].params?.sessionId).toBe("sess_1");
    expect(flushed[0].params?.update?.content?.text).toBe("<");
    expect(flushed[1].result).toEqual({ ok: true });
  });
});

describe("system context injection", () => {
  it("injects system context and formatting guidance on first prompt of session/new", async () => {
    const promptState = createSystemPromptState();

    const newMsg = {
      jsonrpc: "2.0",
      id: 10,
      method: "session/new",
      params: {
        cwd: "/workspace",
        _meta: {
          _paseo: {
            systemPrompt: "You are an expert DevOps engineer.",
          },
        },
      },
    } as unknown as AcpStreamMessage;
    await processOutboundMessage(newMsg, undefined, promptState);

    const resMsg = {
      jsonrpc: "2.0",
      id: 10,
      result: {
        sessionId: "native-sess-1",
      },
    } as unknown as AcpStreamMessage;
    processInboundMessage(resMsg, undefined, undefined, promptState);

    const promptMsg1 = {
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: {
        sessionId: "native-sess-1",
        prompt: [{ type: "text", text: "Diagnose high CPU usage" }],
      },
    } as unknown as AcpStreamMessage;
    const outPrompt1 = (await processOutboundMessage(
      promptMsg1,
      undefined,
      promptState,
    )) as unknown as {
      params: { prompt: Array<{ type: string; text: string }> };
    };

    expect(outPrompt1.params.prompt[0].text).toContain(
      "[System Context]:\nYou are an expert DevOps engineer.",
    );
    expect(outPrompt1.params.prompt[0].text).toContain("[Formatting Guidance]:");
    expect(outPrompt1.params.prompt[0].text).toContain("Diagnose high CPU usage");
    expect(outPrompt1.params.prompt[0].text.endsWith("\n\nDiagnose high CPU usage")).toBe(true);

    const promptMsg2 = {
      jsonrpc: "2.0",
      id: 12,
      method: "session/prompt",
      params: {
        sessionId: "native-sess-1",
        prompt: [{ type: "text", text: "Check memory too" }],
      },
    } as unknown as AcpStreamMessage;
    const outPrompt2 = (await processOutboundMessage(
      promptMsg2,
      undefined,
      promptState,
    )) as unknown as {
      params: { prompt: Array<{ type: string; text: string }> };
    };

    expect(outPrompt2.params.prompt[0].text).toBe("Check memory too");
    expect(outPrompt2.params.prompt[0].text).not.toContain("[System Context]");
    expect(outPrompt2.params.prompt[0].text).not.toContain("[Formatting Guidance]");
  });

  it("does not inject system context on session/load", async () => {
    const promptState = createSystemPromptState();

    const loadMsg = {
      jsonrpc: "2.0",
      id: 20,
      method: "session/load",
      params: {
        sessionId: "resumed-sess-1",
        _meta: {
          _paseo: {
            systemPrompt: "Should be ignored on load",
          },
        },
      },
    } as unknown as AcpStreamMessage;
    await processOutboundMessage(loadMsg, undefined, promptState);

    const resMsg = {
      jsonrpc: "2.0",
      id: 20,
      result: {
        sessionId: "resumed-sess-1",
      },
    } as unknown as AcpStreamMessage;
    processInboundMessage(resMsg, undefined, undefined, promptState);

    const promptMsg = {
      jsonrpc: "2.0",
      id: 21,
      method: "session/prompt",
      params: {
        sessionId: "resumed-sess-1",
        prompt: [{ type: "text", text: "Continue the previous task" }],
      },
    } as unknown as AcpStreamMessage;
    const outPrompt = (await processOutboundMessage(
      promptMsg,
      undefined,
      promptState,
    )) as unknown as {
      params: { prompt: Array<{ type: string; text: string }> };
    };

    expect(outPrompt.params.prompt[0].text).toBe("Continue the previous task");
    expect(outPrompt.params.prompt[0].text).not.toContain("[System Context]");
    expect(outPrompt.params.prompt[0].text).not.toContain("[Formatting Guidance]");
  });

  it("injects formatting guidance even when session/new provides no system prompt", async () => {
    const promptState = createSystemPromptState();

    const newMsg = {
      jsonrpc: "2.0",
      id: 30,
      method: "session/new",
      params: { cwd: "/workspace" },
    } as unknown as AcpStreamMessage;
    await processOutboundMessage(newMsg, undefined, promptState);

    const resMsg = {
      jsonrpc: "2.0",
      id: 30,
      result: { sessionId: "native-sess-no-prompt" },
    } as unknown as AcpStreamMessage;
    processInboundMessage(resMsg, undefined, undefined, promptState);

    const promptMsg = {
      jsonrpc: "2.0",
      id: 31,
      method: "session/prompt",
      params: {
        sessionId: "native-sess-no-prompt",
        prompt: [{ type: "text", text: "Hello there" }],
      },
    } as unknown as AcpStreamMessage;
    const outPrompt = (await processOutboundMessage(
      promptMsg,
      undefined,
      promptState,
    )) as unknown as {
      params: { prompt: Array<{ type: string; text: string }> };
    };

    expect(outPrompt.params.prompt[0].text).not.toContain("[System Context]");
    expect(outPrompt.params.prompt[0].text).toContain("[Formatting Guidance]:");
    expect(outPrompt.params.prompt[0].text.endsWith("\n\nHello there")).toBe(true);
  });
});

describe("parseTrajectoryStateUpdate", () => {
  it("parses exact RAW WS MSG line", () => {
    const line =
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_1","state":"STATE_WAITING_FOR_TASKS"}}';
    expect(parseTrajectoryStateUpdate(line)).toEqual({
      trajectoryId: "sess_1",
      state: "STATE_WAITING_FOR_TASKS",
    });
  });

  it("parses line with log prefix and extra fields", () => {
    const line =
      '2026-09-22 10:00:00 INFO RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_2","state":"STATE_RUNNING"},"other":123}';
    expect(parseTrajectoryStateUpdate(line)).toEqual({
      trajectoryId: "sess_2",
      state: "STATE_RUNNING",
    });
  });

  it("parses line without RAW WS MSG marker but with trajectoryStateUpdate", () => {
    const line = '{"trajectoryStateUpdate":{"trajectoryId":"sess_3","state":"STATE_FULLY_IDLE"}}';
    expect(parseTrajectoryStateUpdate(line)).toEqual({
      trajectoryId: "sess_3",
      state: "STATE_FULLY_IDLE",
    });
  });

  it("returns null for non-JSON or unrelated stderr lines", () => {
    expect(parseTrajectoryStateUpdate("Starting Antigravity ACP server...")).toBeNull();
    expect(parseTrajectoryStateUpdate('RAW WS MSG: {"otherField": true}')).toBeNull();
    expect(parseTrajectoryStateUpdate("RAW WS MSG: {invalid json")).toBeNull();
  });

  it("returns null if trajectoryId or state is missing or invalid", () => {
    expect(
      parseTrajectoryStateUpdate('RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":123}}'),
    ).toBeNull();
    expect(
      parseTrajectoryStateUpdate(
        'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"s1","state":456}}',
      ),
    ).toBeNull();
  });
});

describe("parseStepUpdate", () => {
  it("extracts trajectoryId, state, target, and source from RAW WS MSG", () => {
    const line =
      'I0922 13:54:15.822065 8416960960 local_connection.py:521] RAW WS MSG: {"stepUpdate":{"cascadeId":"s1","trajectoryId":"s1","stepIndex":1867,"state":"STATE_DONE","source":"SOURCE_MODEL","target":"TARGET_USER","text":""}}';
    expect(parseStepUpdate(line)).toEqual({
      trajectoryId: "s1",
      state: "STATE_DONE",
      target: "TARGET_USER",
      source: "SOURCE_MODEL",
    });
  });

  it("handles environment tool calls", () => {
    const line =
      'RAW WS MSG: {"stepUpdate":{"trajectoryId":"s1","state":"STATE_ACTIVE","target":"TARGET_ENVIRONMENT","source":"SOURCE_MODEL"}}';
    expect(parseStepUpdate(line)).toEqual({
      trajectoryId: "s1",
      state: "STATE_ACTIVE",
      target: "TARGET_ENVIRONMENT",
      source: "SOURCE_MODEL",
    });
  });

  it("returns null for non-stepUpdate lines", () => {
    expect(parseStepUpdate("regular log line")).toBeNull();
    expect(parseStepUpdate('RAW WS MSG: {"usageUpdate":{}}')).toBeNull();
  });
});

describe("HangDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("defaults to 5000ms grace and 30,000ms inactivity", () => {
    const detector = new HangDetector();
    expect(detector.graceMs).toBe(DEFAULT_HANG_GRACE_MS);
    expect(detector.inactivityMs).toBe(DEFAULT_HANG_INACTIVITY_MS);
    detector.dispose();
  });

  it("stepUpdate targeting TARGET_USER with STATE_DONE does not declare a hang", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ graceMs: 1000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 201,
      method: "session/prompt",
      params: { sessionId: "sess_user_turn" },
    } as unknown as AcpStreamMessage);

    detector.processStderrLine(
      'RAW WS MSG: {"stepUpdate":{"trajectoryId":"sess_user_turn","state":"STATE_DONE","target":"TARGET_USER","source":"SOURCE_MODEL"}}',
    );

    vi.advanceTimersByTime(2000);
    expect(onHangDeclared).not.toHaveBeenCalled();
    expect(detector.isHung("sess_user_turn")).toBe(false);

    detector.dispose();
  });

  it("STATE_WAITING_FOR_TASKS triggers grace timer and calls onHang on expiration", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ graceMs: 1000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 101,
      method: "session/prompt",
      params: { sessionId: "sess_hang" },
    } as unknown as AcpStreamMessage);

    detector.processStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_hang","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    expect(detector.lastStates.get("sess_hang")).toBe("STATE_WAITING_FOR_TASKS");
    expect(onHangDeclared).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(onHangDeclared).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onHangDeclared).toHaveBeenCalledTimes(1);
    expect(onHangDeclared).toHaveBeenCalledWith("sess_hang", 101);
    expect(detector.isHung("sess_hang")).toBe(true);

    detector.dispose();
  });

  it("Early response before grace timer clears the timer and does NOT trigger onHang", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ graceMs: 1000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 102,
      method: "session/prompt",
      params: { sessionId: "sess_ok" },
    } as unknown as AcpStreamMessage);

    detector.processStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_ok","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    vi.advanceTimersByTime(500);

    // Prompt finishes before grace timer expires
    detector.processInbound({
      jsonrpc: "2.0",
      id: 102,
      result: { ok: true },
    } as unknown as AcpStreamMessage);

    expect(detector.pendingPrompts.has(102)).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(onHangDeclared).not.toHaveBeenCalled();
    expect(detector.isHung("sess_ok")).toBe(false);

    detector.dispose();
  });

  it("Early error response before grace timer clears the timer and does NOT trigger onHang", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ graceMs: 1000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 103,
      method: "session/prompt",
      params: { sessionId: "sess_err" },
    } as unknown as AcpStreamMessage);

    detector.processStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_err","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    vi.advanceTimersByTime(300);

    // Inbound error response
    detector.processInbound({
      jsonrpc: "2.0",
      id: 103,
      error: { code: -32000, message: "Cancelled" },
    } as unknown as AcpStreamMessage);

    expect(detector.pendingPrompts.has(103)).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(onHangDeclared).not.toHaveBeenCalled();

    detector.dispose();
  });

  it("session/update refreshes lastActivityAt", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ inactivityMs: 5000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 104,
      method: "session/prompt",
      params: { sessionId: "sess_active" },
    } as unknown as AcpStreamMessage);

    const initialActivity = detector.pendingPrompts.get(104)?.lastActivityAt;

    vi.advanceTimersByTime(3000);

    detector.processInbound({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_active",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk" } },
      },
    } as unknown as AcpStreamMessage);

    const refreshedActivity = detector.pendingPrompts.get(104)?.lastActivityAt;
    expect(refreshedActivity).toBe((initialActivity ?? 0) + 3000);

    // At 6000ms total, initial 5000ms window has passed, but inactivity timer was refreshed at 3000ms
    vi.advanceTimersByTime(3000);
    expect(onHangDeclared).not.toHaveBeenCalled();

    // At 8000ms total (5000ms from last update), inactivity fires
    vi.advanceTimersByTime(2000);
    expect(onHangDeclared).toHaveBeenCalledTimes(1);
    expect(onHangDeclared).toHaveBeenCalledWith("sess_active", 104);

    detector.dispose();
  });

  it("Inactivity backstop fires if no updates arrive", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ inactivityMs: 2000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 105,
      method: "session/prompt",
      params: { sessionId: "sess_quiet" },
    } as unknown as AcpStreamMessage);

    vi.advanceTimersByTime(1999);
    expect(onHangDeclared).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onHangDeclared).toHaveBeenCalledTimes(1);
    expect(onHangDeclared).toHaveBeenCalledWith("sess_quiet", 105);
    expect(detector.isHung("sess_quiet")).toBe(true);

    expect(consoleSpy).toHaveBeenCalledWith(
      "[paseo-antigravity] Inactivity backstop fired for session sess_quiet, prompt 105",
    );

    detector.dispose();
  });

  it("cancels grace timer if state transitions away from STATE_WAITING_FOR_TASKS", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ graceMs: 1000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 106,
      method: "session/prompt",
      params: { sessionId: "sess_resume" },
    } as unknown as AcpStreamMessage);

    detector.processStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_resume","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    vi.advanceTimersByTime(500);

    // Harness resumes running
    detector.processStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_resume","state":"STATE_RUNNING"}}',
    );

    vi.advanceTimersByTime(1000);
    expect(onHangDeclared).not.toHaveBeenCalled();
    expect(detector.isHung("sess_resume")).toBe(false);

    detector.dispose();
  });

  it("dispose cancels pending timers", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ graceMs: 1000, inactivityMs: 2000, onHangDeclared });

    detector.processOutbound({
      jsonrpc: "2.0",
      id: 107,
      method: "session/prompt",
      params: { sessionId: "sess_dispose" },
    } as unknown as AcpStreamMessage);

    detector.processStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_dispose","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    detector.dispose();

    vi.advanceTimersByTime(5000);
    expect(onHangDeclared).not.toHaveBeenCalled();
    expect(detector.pendingPrompts.size).toBe(0);
  });
});

class MockChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  killSignals: string[] = [];

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killed = true;
    this.killSignals.push(String(signal));
    this.emit("close");
    return true;
  }
}

describe("ChildSlot & Process Recycling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits synthetic end_turn on hang declaration and suppresses late real response", async () => {
    const child1 = new MockChildProcess();
    const slot = new ChildSlot({
      cmd: "test-cmd",
      args: [],
      initialChild: child1 as unknown as ChildProcess,
      options: { graceMs: 1000 },
    });

    const receivedChunks: AcpStreamMessage[] = [];
    const readable = createAcpReadableStream(slot);
    const reader = readable.getReader();

    // Start reading in background
    const readPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        receivedChunks.push(value);
      }
    })();

    // 1. Send outbound prompt
    slot.hangDetector.processOutbound({
      jsonrpc: "2.0",
      id: 201,
      method: "session/prompt",
      params: { sessionId: "sess_hang_test" },
    } as unknown as AcpStreamMessage);

    // 2. Trajectory state update indicates STATE_WAITING_FOR_TASKS
    slot.hangDetector.processStderrLine(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_hang_test","state":"STATE_WAITING_FOR_TASKS"}}',
    );

    // 3. Fast forward time to trigger grace timer hang declaration
    await vi.advanceTimersByTimeAsync(1000);

    // Verify synthetic end_turn was enqueued
    await vi.waitFor(() => expect(receivedChunks.length).toBe(1));
    expect(receivedChunks[0]).toEqual({
      jsonrpc: "2.0",
      id: 201,
      result: { stopReason: "end_turn" },
    });

    // Session must be marked as needing recycle
    const session = slot.sessionCache.sessions.get("sess_hang_test");
    expect(session?.needsRecycle).toBe(true);

    // 4. Late real response arrives from child
    slot.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 201,
        result: { stopReason: "end_turn", extra: "late_response" },
      }),
    );

    // Late response must be dropped, not emitted to reader
    expect(receivedChunks.length).toBe(1);

    slot.close();
    await readPromise;
  });

  it("transparently recycles child process, swallows session/update history replay, and preserves stream", async () => {
    const child1 = new MockChildProcess();
    const child2 = new MockChildProcess();

    const spawnMock = vi.fn().mockImplementation(() => child2 as unknown as ChildProcess);

    const slot = new ChildSlot({
      cmd: "test-cmd",
      args: [],
      initialChild: child1 as unknown as ChildProcess,
      options: {
        spawnProcess: spawnMock,
        recycleTimeoutMs: 5000,
      },
    });

    const readable = createAcpReadableStream(slot);
    const writable = createAcpWritableStream(slot);
    const writer = writable.getWriter();
    const reader = readable.getReader();
    const receivedChunks: AcpStreamMessage[] = [];

    const readPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        receivedChunks.push(value);
      }
    })();

    // 1. Initialize session and cache metadata on child1
    await writer.write({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "test-client", version: "1.0" } },
    } as unknown as AcpStreamMessage);

    await writer.write({
      jsonrpc: "2.0",
      id: "new-1",
      method: "session/new",
      params: {
        cwd: "/workspace/project",
        mcpServers: [{ name: "srv1", url: "http://localhost:8080" }],
        _meta: { testKey: "testVal" },
      },
    } as unknown as AcpStreamMessage);

    // Child1 responds to session/new with sessionId
    slot.handleStdoutLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "new-1",
        result: { sessionId: "sess_recycle_123" },
      }),
    );

    await writer.write({
      jsonrpc: "2.0",
      id: "mode-1",
      method: "session/set_mode",
      params: { sessionId: "sess_recycle_123", modeId: "auto_edit" },
    } as unknown as AcpStreamMessage);

    await writer.write({
      jsonrpc: "2.0",
      id: "cfg-1",
      method: "session/set_config_option",
      params: { sessionId: "sess_recycle_123", configId: "model", value: "claude-3-5-sonnet" },
    } as unknown as AcpStreamMessage);

    // Verify session metadata is cached
    const cached = slot.sessionCache.sessions.get("sess_recycle_123");
    expect(cached?.cwd).toBe("/workspace/project");
    expect(cached?.lastModeId).toBe("auto_edit");
    expect(cached?.lastConfigOptions.get("model")?.value).toBe("claude-3-5-sonnet");

    // 2. Turn 1 hangs on prompt 301
    await writer.write({
      jsonrpc: "2.0",
      id: 301,
      method: "session/prompt",
      params: { sessionId: "sess_recycle_123", prompt: [{ type: "text", text: "do work" }] },
    } as unknown as AcpStreamMessage);

    slot.handleHangDeclared("sess_recycle_123", 301);

    // Reader receives synthetic end_turn
    await vi.waitFor(() => expect(receivedChunks.length).toBe(2)); // session/new response + synthetic end_turn
    expect(receivedChunks[1]).toEqual({
      jsonrpc: "2.0",
      id: 301,
      result: { stopReason: "end_turn" },
    });
    expect(cached?.needsRecycle).toBe(true);

    // 3. Turn 2 prompt arrives: triggers transparent process recycle
    // Setup child2 stdin monitor to respond to recycle sequence
    const child2Lines: string[] = [];
    const child2Rl = readline.createInterface({ input: child2.stdin, crlfDelay: Infinity });

    child2Rl.on("line", (line) => {
      child2Lines.push(line);
      const req = JSON.parse(line);

      if (req.id === RECYCLE_INIT_ID) {
        // Reply to initialize
        child2.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: RECYCLE_INIT_ID, result: {} }) + "\n",
        );
      } else if (req.id === RECYCLE_LOAD_ID) {
        // Before replying to session/load, emit 50 session/update history replay notifications!
        for (let i = 0; i < 50; i++) {
          child2.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "sess_recycle_123",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `hist ${i}` },
                },
              },
            }) + "\n",
          );
        }
        // Then reply to session/load
        child2.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: RECYCLE_LOAD_ID, result: {} }) + "\n",
        );
      } else if (req.id === RECYCLE_MODE_ID) {
        child2.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: RECYCLE_MODE_ID, result: {} }) + "\n",
        );
      } else if (req.id === `${RECYCLE_CONFIG_PREFIX}model`) {
        child2.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: `${RECYCLE_CONFIG_PREFIX}model`, result: {} }) +
            "\n",
        );
      }
    });

    // Write next outbound prompt
    const writeTurn2Promise = writer.write({
      jsonrpc: "2.0",
      id: 302,
      method: "session/prompt",
      params: {
        sessionId: "sess_recycle_123",
        prompt: [{ type: "text", text: "second question" }],
      },
    } as unknown as AcpStreamMessage);

    // Give microtasks / I/O a moment to process
    await vi.waitFor(() => expect(child1.killed).toBe(true));
    expect(child1.killSignals).toContain("SIGKILL");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await writeTurn2Promise;

    // Verify all 50 history session/update notifications were dropped / swallowed!
    const historyUpdatesReceived = receivedChunks.filter(
      (c) => (c as { method?: string }).method === "session/update",
    );
    expect(historyUpdatesReceived.length).toBe(0);

    // Verify child2 received init, load (with cwd & mcpServers), mode, config, and then prompt 302
    const parsedRequests = child2Lines.map((l) => JSON.parse(l));
    expect(parsedRequests[0].id).toBe(RECYCLE_INIT_ID);
    expect(parsedRequests[1].id).toBe(RECYCLE_LOAD_ID);
    expect(parsedRequests[1].params.cwd).toBe("/workspace/project");
    expect(parsedRequests[2].id).toBe(RECYCLE_MODE_ID);
    expect(parsedRequests[2].params.modeId).toBe("auto_edit");
    expect(parsedRequests[3].id).toBe(`${RECYCLE_CONFIG_PREFIX}model`);
    expect(parsedRequests[3].params.value).toBe("claude-3-5-sonnet");
    expect(parsedRequests[4].id).toBe(302);

    // Child2 replies to prompt 302
    child2.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 302,
        result: { stopReason: "end_turn" },
      }) + "\n",
    );

    await vi.waitFor(() => expect(receivedChunks.length).toBe(3));
    expect(receivedChunks[2]).toEqual({
      jsonrpc: "2.0",
      id: 302,
      result: { stopReason: "end_turn" },
    });

    // Stream remains open and active
    expect(slot.state.isClosed).toBe(false);

    child2Rl.close();
    slot.close();
    await readPromise;
  });

  it("closes streams and throws on write if process recycle fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const child1 = new MockChildProcess();

    const spawnMock = vi.fn().mockRejectedValue(new Error("Spawn failure"));

    const slot = new ChildSlot({
      cmd: "test-cmd",
      args: [],
      initialChild: child1 as unknown as ChildProcess,
      options: { spawnProcess: spawnMock },
    });

    const readable = createAcpReadableStream(slot);
    const writable = createAcpWritableStream(slot);
    const writer = writable.getWriter();
    const reader = readable.getReader();

    // Mark session as needing recycle
    const session = slot.sessionCache.sessions.get("sess_fail") ?? {
      sessionId: "sess_fail",
      lastConfigOptions: new Map(),
      needsRecycle: true,
    };
    slot.sessionCache.sessions.set("sess_fail", session);

    let streamError: unknown = null;
    reader.read().catch((err) => {
      streamError = err;
    });

    await expect(
      writer.write({
        jsonrpc: "2.0",
        id: 401,
        method: "session/prompt",
        params: { sessionId: "sess_fail" },
      } as unknown as AcpStreamMessage),
    ).rejects.toThrow("Spawn failure");

    expect(consoleSpy).toHaveBeenCalledWith(
      "[paseo-antigravity] Process recycle failed:",
      expect.any(Error),
    );
    expect(slot.state.isClosed).toBe(true);

    await vi.waitFor(() => expect(streamError).toBeTruthy());
  });

  it("does not close readable stream on old child exit when isRecycling is true", () => {
    const child1 = new MockChildProcess();
    const slot = new ChildSlot({
      cmd: "test-cmd",
      args: [],
      initialChild: child1 as unknown as ChildProcess,
    });

    slot.isRecycling = true;
    child1.emit("close");

    expect(slot.state.isClosed).toBe(false);

    slot.isRecycling = false;
    child1.emit("close");
    expect(slot.state.isClosed).toBe(true);
  });
});
