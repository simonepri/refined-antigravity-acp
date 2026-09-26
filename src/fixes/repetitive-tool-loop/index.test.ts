import { describe, expect, it, vi } from "vitest";
import {
  ACP_METHODS,
  SESSION_UPDATES,
  STOP_REASONS,
  type AcpStreamMessage,
} from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import {
  canonicalizeValue,
  computeToolCallSignature,
  createRepetitiveToolLoopFix,
  detectCycle,
  extractPromptText,
  extractRequestedIterations,
  hasPollingIntent,
  inferToolNameFromUpdate,
  normalizeKey,
  RepetitiveToolLoopTracker,
} from "./index.js";

describe("repetitive-tool-loop unit tests", () => {
  describe("normalization & canonicalization", () => {
    it("normalizes keys across casing and underscores", () => {
      expect(normalizeKey("AbsolutePath")).toBe("absolutepath");
      expect(normalizeKey("start_line")).toBe("startline");
      expect(normalizeKey("EndLine")).toBe("endline");
      expect(normalizeKey("tool_action")).toBe("toolaction");
    });

    it("canonicalizes objects deterministically and filters UI metadata keys", () => {
      const obj1 = {
        AbsolutePath: "/tmp/foo.txt",
        StartLine: 1,
        EndLine: 10,
        toolAction: "Reading lines 1 to 10",
        toolSummary: "Read lines",
      };

      const obj2 = {
        end_line: 10,
        toolSummary: "Different description",
        start_line: 1,
        absolute_path: "/tmp/foo.txt",
      };

      expect(canonicalizeValue(obj1)).toEqual(canonicalizeValue(obj2));
      expect(canonicalizeValue(obj1)).toEqual({
        absolutepath: "/tmp/foo.txt",
        endline: 10,
        startline: 1,
      });
    });

    it("computes identical signatures for equivalent inputs regardless of key order or casing", () => {
      const sig1 = computeToolCallSignature("view_file", {
        AbsolutePath: "/tmp/foo.txt",
        StartLine: 1,
        EndLine: 10,
      });

      const sig2 = computeToolCallSignature("view_file", {
        start_line: 1,
        end_line: 10,
        absolute_path: "/tmp/foo.txt",
      });

      expect(sig1).toBe(sig2);
    });

    it("computes different signatures when functional arguments differ", () => {
      const sig1 = computeToolCallSignature("view_file", {
        AbsolutePath: "/tmp/foo.txt",
        StartLine: 1,
        EndLine: 10,
      });

      const sig2 = computeToolCallSignature("view_file", {
        AbsolutePath: "/tmp/foo.txt",
        StartLine: 11,
        EndLine: 20,
      });

      expect(sig1).not.toBe(sig2);
    });

    it("handles stringified JSON in rawInput", () => {
      const sig = computeToolCallSignature(
        "run_command",
        JSON.stringify({ CommandLine: "ls -la", Cwd: "/tmp" }),
      );
      expect(sig).toBe('run_command:{"commandline":"ls -la","cwd":"/tmp"}');
    });

    it("infers tool names from title, kind, or rawInput", () => {
      expect(inferToolNameFromUpdate("Running view_file")).toBe("view_file");
      expect(inferToolNameFromUpdate("Running: list_directory")).toBe("list_directory");
      expect(inferToolNameFromUpdate(undefined, "read")).toBe("read");
      expect(inferToolNameFromUpdate(undefined, undefined, { CommandLine: "echo 1" })).toBe(
        "run_command",
      );
    });
  });

  describe("polling intent detection", () => {
    it("detects polling keywords correctly", () => {
      expect(hasPollingIntent("Wait for server to start")).toBe(true);
      expect(hasPollingIntent("Check localhost:3000 until 200 OK")).toBe(true);
      expect(hasPollingIntent("Poll the health endpoint")).toBe(true);
      expect(hasPollingIntent("Retry the curl request")).toBe(true);
      expect(hasPollingIntent("Run pwd 10 times consecutively")).toBe(true);
      expect(hasPollingIntent("Inspect the package.json file")).toBe(false);
      expect(hasPollingIntent("Find the line where server starts")).toBe(false);
    });

    it("extracts requested iterations from prompt", () => {
      expect(extractRequestedIterations("Run pwd 10 times consecutively")).toBe(10);
      expect(extractRequestedIterations("Retry 5 times")).toBe(5);
      expect(extractRequestedIterations("Poll until ready")).toBeUndefined();
    });

    it("extracts prompt text from ACP messages", () => {
      const msg = {
        params: {
          prompt: [
            { type: "text", text: "Hello" },
            { type: "text", text: "world" },
          ],
        },
      } as unknown as AcpStreamMessage;
      expect(extractPromptText(msg)).toBe("Hello world");
    });
  });

  describe("detectCycle", () => {
    it("detects single-tool repetition (k=1, R=3)", () => {
      const result = detectCycle(["A", "A", "A"]);
      expect(result.isLoop).toBe(true);
      expect(result.cycleLength).toBe(1);
      expect(result.repetitions).toBe(3);
      expect(result.pattern).toEqual(["A"]);
    });

    it("does not trigger single-tool repetition when under threshold (R=2)", () => {
      const result = detectCycle(["A", "A"]);
      expect(result.isLoop).toBe(false);
    });

    it("detects 2-tool alternating cycles (k=2, R=3)", () => {
      const result = detectCycle(["A", "B", "A", "B", "A", "B"]);
      expect(result.isLoop).toBe(true);
      expect(result.cycleLength).toBe(2);
      expect(result.repetitions).toBe(3);
      expect(result.pattern).toEqual(["A", "B"]);
    });

    it("does not trigger 2-tool cycle when under threshold (R=2)", () => {
      const result = detectCycle(["A", "B", "A", "B"]);
      expect(result.isLoop).toBe(false);
    });

    it("detects 3-tool cycles (k=3, R=3)", () => {
      const result = detectCycle(["A", "B", "C", "A", "B", "C", "A", "B", "C"]);
      expect(result.isLoop).toBe(true);
      expect(result.cycleLength).toBe(3);
      expect(result.repetitions).toBe(3);
      expect(result.pattern).toEqual(["A", "B", "C"]);
    });

    it("detects cycles even when preceded by non-cyclic tool calls", () => {
      const result = detectCycle(["X", "Y", "Z", "A", "B", "A", "B", "A", "B"]);
      expect(result.isLoop).toBe(true);
      expect(result.cycleLength).toBe(2);
      expect(result.pattern).toEqual(["A", "B"]);
    });

    it("does not trigger on diverse, non-repeating tool calls", () => {
      const result = detectCycle(["A", "B", "C", "D", "E", "F", "G"]);
      expect(result.isLoop).toBe(false);
    });
  });

  describe("RepetitiveToolLoopTracker", () => {
    it("uses conservative single threshold for mutating tools and lower threshold for read-only tools", () => {
      const tracker = new RepetitiveToolLoopTracker();
      const session = "s1";

      // view_file is read-only -> threshold 3
      tracker.recordToolCall(session, "view_file", { path: "f1" });
      tracker.recordToolCall(session, "view_file", { path: "f1" });
      const r3 = tracker.recordToolCall(session, "view_file", { path: "f1" });
      expect(r3.isLoop).toBe(true);

      tracker.startTurn(session);
      // run_command is mutating -> default threshold 5 without polling intent
      tracker.recordToolCall(session, "run_command", { CommandLine: "curl localhost" });
      tracker.recordToolCall(session, "run_command", { CommandLine: "curl localhost" });
      const r3Mutating = tracker.recordToolCall(session, "run_command", {
        CommandLine: "curl localhost",
      });
      expect(r3Mutating.isLoop).toBe(false);

      tracker.recordToolCall(session, "run_command", { CommandLine: "curl localhost" });
      const r5Mutating = tracker.recordToolCall(session, "run_command", {
        CommandLine: "curl localhost",
      });
      expect(r5Mutating.isLoop).toBe(true);
    });

    it("allows polling repetitions when prompt contains polling intent", () => {
      const tracker = new RepetitiveToolLoopTracker();
      const session = "s-poll";

      // Turn with explicit polling intent: "Poll until ready"
      tracker.startTurn(session, 1, "Poll http://localhost:3000 until ready");

      // Should allow 10 repetitions without flagging as a loop
      for (let i = 1; i <= 10; i++) {
        const res = tracker.recordToolCall(session, "run_command", {
          CommandLine: "curl localhost",
        });
        expect(res.isLoop).toBe(false);
      }
    });

    it("allows user-requested iteration counts (e.g. '10 times')", () => {
      const tracker = new RepetitiveToolLoopTracker();
      const session = "s-times";

      tracker.startTurn(session, 1, "Run pwd 10 times consecutively");

      for (let i = 1; i <= 10; i++) {
        const res = tracker.recordToolCall(session, "run_command", { CommandLine: "pwd" });
        expect(res.isLoop).toBe(false);
      }
    });

    it("resets history on new prompt turn", () => {
      const tracker = new RepetitiveToolLoopTracker();
      const session = "s1";

      tracker.startTurn(session, 100);
      tracker.recordToolCall(session, "view_file", { path: "f1" });
      tracker.recordToolCall(session, "view_file", { path: "f1" });

      tracker.startTurn(session, 101);
      const r = tracker.recordToolCall(session, "view_file", { path: "f1" });
      expect(r.isLoop).toBe(false);
    });
  });

  describe("createRepetitiveToolLoopFix hook", () => {
    it("intercepts repetitive tool call, completes tool, sends cancel, and delivers automated steering without polluting chat", async () => {
      const fix = createRepetitiveToolLoopFix();
      const context = createMockContext();
      const writtenToChild: AcpStreamMessage[] = [];
      const forwardedInbound: AcpStreamMessage[] = [];

      context.writeToChild = vi.fn().mockImplementation(async (msg) => {
        writtenToChild.push(msg);
      });
      context.forwardInbound = vi.fn().mockImplementation((msg) => {
        forwardedInbound.push(msg);
      });

      const sessionId = "s-test-1";

      // Start turn without polling intent
      await fix.onOutbound?.(
        {
          jsonrpc: "2.0",
          id: 1,
          method: ACP_METHODS.SESSION_PROMPT,
          params: { sessionId, prompt: [{ type: "text", text: "Find the port in the config" }] },
        } as unknown as AcpStreamMessage,
        context,
      );

      const makeToolCallMsg = (callId: string, line: number): AcpStreamMessage => ({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId,
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL,
            toolCallId: callId,
            title: "Running view_file",
            rawInput: { AbsolutePath: "/tmp/data.txt", StartLine: line, EndLine: line + 5 },
          },
        },
      });

      // Alternate: 1, 10, 1, 10, 1
      await fix.onInbound?.(makeToolCallMsg("c1", 1), context);
      await fix.onInbound?.(makeToolCallMsg("c2", 10), context);
      await fix.onInbound?.(makeToolCallMsg("c3", 1), context);
      await fix.onInbound?.(makeToolCallMsg("c4", 10), context);
      await fix.onInbound?.(makeToolCallMsg("c5", 1), context);

      expect(writtenToChild).toHaveLength(0);

      // 6th call completes the 3rd repetition of cycle [1, 10]
      const finalRes = await fix.onInbound?.(makeToolCallMsg("c6", 10), context);

      // Tool call dropped from stream
      expect(finalRes).toEqual([]);

      // Cancel sent upstream to child
      expect(writtenToChild).toHaveLength(1);
      expect(writtenToChild[0]).toMatchObject({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_CANCEL,
        params: { sessionId },
      });

      // Tool call marked completed in UI, but NO warning chunk leaked into chat
      expect(forwardedInbound).toHaveLength(1);
      expect(forwardedInbound[0]).toMatchObject({
        method: ACP_METHODS.SESSION_UPDATE,
        params: {
          sessionId,
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
            toolCallId: "c6",
            status: "completed",
          },
        },
      });

      // When upstream settles cancelled response, fix intercepts it and sends automated steering prompt
      const cancelledResponse: AcpStreamMessage = {
        jsonrpc: "2.0",
        id: 1,
        result: { stopReason: STOP_REASONS.CANCELLED },
      };
      const steerRes = await fix.onInbound?.(cancelledResponse, context);

      // Response suppressed from client so turn remains active
      expect(steerRes).toEqual([]);

      // Steering prompt sent upstream to child
      expect(writtenToChild).toHaveLength(2);
      expect(writtenToChild[1]).toMatchObject({
        jsonrpc: "2.0",
        method: ACP_METHODS.SESSION_PROMPT,
        params: {
          sessionId,
          prompt: [
            {
              type: "text",
            },
          ],
        },
      });

      const steerPromptText = (
        writtenToChild[1] as unknown as { params: { prompt: Array<{ text: string }> } }
      ).params.prompt[0]?.text;
      expect(steerPromptText).toContain("[Automated Steering]");
      expect(steerPromptText).toContain("repeatedly executed 'view_file'");

      // When child completes steering prompt, fix maps response back to original prompt id 1
      const steerPromptId = (writtenToChild[1] as unknown as { id: string }).id;
      const steerCompleteMsg: AcpStreamMessage = {
        jsonrpc: "2.0",
        id: steerPromptId,
        result: { stopReason: STOP_REASONS.END_TURN },
      };
      const finalTurnRes = await fix.onInbound?.(steerCompleteMsg, context);
      expect(finalTurnRes).toHaveLength(1);
      expect(finalTurnRes?.[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 1, // Restored original prompt ID!
        result: { stopReason: STOP_REASONS.END_TURN },
      });
    });
  });
});
