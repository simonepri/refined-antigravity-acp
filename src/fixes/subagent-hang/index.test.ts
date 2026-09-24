import { describe, expect, it, vi } from "vitest";
import { HangDetector, createSubagentHangFix, DONE_CH_PANIC_MARKER } from "./index.js";
import { ACP_METHODS, type AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";

describe("subagent-hang unit tests", () => {
  it("tracks pending prompts and cleans them up upon prompt completion", () => {
    const detector = new HangDetector();
    detector.recordPrompt("p1", "session-1");
    expect(detector.getPendingPrompt("p1")).toBe("session-1");

    detector.resolvePrompt("p1");
    expect(detector.getPendingPrompt("p1")).toBeUndefined();
  });

  it("detects subagent channel panics on stderr and declares hung turns for recovery", () => {
    const onHangDeclared = vi.fn();
    const detector = new HangDetector({ onHangDeclared });

    detector.recordPrompt("p1", "session-1");
    detector.recordPrompt("p2", "session-2");

    detector.processStderrLine(
      `E0924 10:00:00.000000 123 server.go:50] ${DONE_CH_PANIC_MARKER} 42`,
    );

    expect(onHangDeclared).toHaveBeenCalledTimes(2);
    expect(onHangDeclared).toHaveBeenCalledWith("session-1", "p1");
    expect(onHangDeclared).toHaveBeenCalledWith("session-2", "p2");
    expect(detector.pendingPrompts.size).toBe(0);
  });

  it("monitors trajectory state updates and triggers idle notifications when turns finish", () => {
    const onSessionIdle = vi.fn();
    const detector = new HangDetector({ onSessionIdle });

    // Simulate telemetry line: raw ws msg with trajectoryStateUpdate
    const telemetryLine =
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"traj-123","state":"STATE_FULLY_IDLE"}}';
    detector.processStderrLine(telemetryLine);

    expect(onSessionIdle).toHaveBeenCalledWith("traj-123");
    expect(detector.lastStates.get("traj-123")).toBe("STATE_FULLY_IDLE");
  });

  it("recovers pending session prompt requests when a subagent channel deadlock occurs", () => {
    const fix = createSubagentHangFix();
    const context = createMockContext();
    const declareHangSpy = vi.fn();
    context.declareHang = declareHangSpy;

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: "req-1",
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "s-1", prompt: [] },
    } as unknown as AcpStreamMessage;

    fix.onOutbound!(promptMsg, context);
    expect(fix.detector.getPendingPrompt("req-1")).toBe("s-1");

    // Stderr line with crash marker
    fix.onStderrLine!(`Fatal error: ${DONE_CH_PANIC_MARKER}`, context);
    expect(declareHangSpy).toHaveBeenCalledWith("s-1", "req-1", "hang");

    // Inbound response cleans up
    const responseMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: "req-1",
      result: { stopReason: "end_turn" },
    } as unknown as AcpStreamMessage;

    fix.onInbound!(responseMsg, context);
    expect(fix.detector.getPendingPrompt("req-1")).toBeUndefined();
  });
});
