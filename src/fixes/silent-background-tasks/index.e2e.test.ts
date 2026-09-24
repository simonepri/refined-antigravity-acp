import { describe, expect, it } from "vitest";
import type { AcpStreamMessage, StderrContext } from "../../core/types.js";
import { createBackgroundTasksFix } from "./index.js";

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
});
