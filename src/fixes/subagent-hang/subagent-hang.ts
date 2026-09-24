/**
 * Problem:
 * Subprocesses can enter unmonitored deadlocks or panic (`could not find doneCh for checkpoint`)
 * during background subagent execution, causing turns to hang indefinitely with no client response.
 *
 * Solution:
 * Monitors telemetry stream events and stderr panic signatures in real-time, declaring hangs
 * to trigger automatic supervisor process recycling and turn re-execution.
 */

import {
  ACP_METHODS,
  isJsonRpcRequest,
  type AcpStreamMessage,
  type AcpFix,
  type StderrContext,
} from "../../core/types.js";
import { extractSessionId } from "../../core/session-cache.js";
import {
  RAW_WS_MSG_MARKER,
  TELEMETRY_STATES,
  TARGET_ENVIRONMENT,
  parseTrajectoryStateUpdate,
  parseStepUpdate,
  type TrajectoryStateUpdate,
  type StepUpdate,
} from "../../core/telemetry.js";
import { DONE_CH_PANIC_MARKER } from "../orphaned-checkpoints/index.js";

export {
  RAW_WS_MSG_MARKER,
  TELEMETRY_STATES,
  TARGET_ENVIRONMENT,
  DONE_CH_PANIC_MARKER,
  parseTrajectoryStateUpdate,
  parseStepUpdate,
};
export type { TrajectoryStateUpdate, StepUpdate };

export interface HangDetectorOptions {
  onHangDeclared?: ((nativeSessionId: string, promptId: string | number) => void) | undefined;
  onSessionIdle?: ((nativeSessionId: string) => void) | undefined;
}

export class HangDetector {
  public onHangDeclared?:
    | ((nativeSessionId: string, promptId: string | number) => void)
    | undefined;
  public onSessionIdle?: ((nativeSessionId: string) => void) | undefined;
  public readonly pendingPrompts = new Map<string | number, string>();
  public readonly lastStates = new Map<string, string>();

  constructor(options?: HangDetectorOptions) {
    this.onHangDeclared = options?.onHangDeclared;
    this.onSessionIdle = options?.onSessionIdle;
  }

  getPendingPrompt(id: string | number): string | undefined {
    return this.pendingPrompts.get(id);
  }

  isWaitingForTasks(nativeSessionId: string): boolean {
    return this.lastStates.get(nativeSessionId) === TELEMETRY_STATES.WAITING_FOR_TASKS;
  }

  recordPrompt(id: string | number, nativeSessionId: string): void {
    this.pendingPrompts.set(id, nativeSessionId);
  }

  resolvePrompt(id: string | number): void {
    this.pendingPrompts.delete(id);
  }

  public declareHang(nativeSessionId: string, promptId: string | number): void {
    this.pendingPrompts.delete(promptId);
    console.error(
      `[refined-antigravity-acp] Harness crash detected for session ${nativeSessionId}, prompt ${promptId} (doneCh for checkpoint)`,
    );
    this.onHangDeclared?.(nativeSessionId, promptId);
  }

  private declareCrashForAllPending(): void {
    for (const [promptId, nativeSessionId] of Array.from(this.pendingPrompts.entries())) {
      this.declareHang(nativeSessionId, promptId);
    }
  }

  private handleTrajectoryState(trajectoryId: string, state: string): void {
    this.lastStates.set(trajectoryId, state);
    if (
      state === TELEMETRY_STATES.FULLY_IDLE ||
      state === TELEMETRY_STATES.COMPLETE ||
      state === TELEMETRY_STATES.IDLE
    ) {
      this.onSessionIdle?.(trajectoryId);
    }
  }

  processStderrLine(line: string): void {
    if (line.includes(DONE_CH_PANIC_MARKER)) {
      this.declareCrashForAllPending();
      return;
    }

    const tsu = parseTrajectoryStateUpdate(line);
    if (tsu) {
      this.handleTrajectoryState(tsu.trajectoryId, tsu.state);
    }
  }

  processOutbound(msg: AcpStreamMessage): void {
    if (!isJsonRpcRequest(msg) || msg.method !== ACP_METHODS.SESSION_PROMPT) return;
    const sessionId = extractSessionId(msg);
    if (sessionId) {
      this.recordPrompt(msg.id, sessionId);
    }
  }

  processInbound(msg: AcpStreamMessage): void {
    if ("id" in msg && msg.id !== null && msg.id !== undefined) {
      this.resolvePrompt(msg.id);
    }
  }

  dispose(): void {
    this.pendingPrompts.clear();
    this.lastStates.clear();
  }
}

export function createSubagentHangFix(
  options?: HangDetectorOptions,
): AcpFix & { detector: HangDetector } {
  const detector = new HangDetector(options);

  return {
    name: "subagent-hang",
    description: "Subagent crash recovery and telemetry watchdog",
    detector,

    onOutbound(msg: AcpStreamMessage): AcpStreamMessage {
      detector.processOutbound(msg);
      return msg;
    },

    onInbound(msg: AcpStreamMessage): AcpStreamMessage[] {
      detector.processInbound(msg);
      return [msg];
    },

    onStderrLine(line: string, context: StderrContext): boolean {
      if (detector.onHangDeclared === undefined) {
        detector.onHangDeclared = (sessionId, promptId) => {
          context.declareHang(sessionId, promptId, "hang");
        };
      }
      detector.processStderrLine(line);
      return false;
    },

    onRecycle(): void {
      detector.dispose();
    },

    dispose(): void {
      detector.dispose();
    },
  };
}

export const subagentHangFix = createSubagentHangFix();
