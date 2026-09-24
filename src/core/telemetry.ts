export const RAW_WS_MSG_MARKER = "RAW WS MSG:";

export const TELEMETRY_STATES = {
  WAITING_FOR_TASKS: "STATE_WAITING_FOR_TASKS",
  FULLY_IDLE: "STATE_FULLY_IDLE",
  IDLE: "STATE_IDLE",
  RUNNING: "STATE_RUNNING",
  COMPLETE: "STATE_COMPLETE",
  ACTIVE: "STATE_ACTIVE",
} as const;

export const TARGET_ENVIRONMENT = "TARGET_ENVIRONMENT";

export interface TrajectoryStateUpdate {
  trajectoryId: string;
  state: string;
}

export interface StepUpdate {
  trajectoryId: string;
  state: string;
  target?: string | undefined;
  source?: string | undefined;
}

function extractJsonCandidate(line: string): string | null {
  const idx = line.indexOf(RAW_WS_MSG_MARKER);
  if (idx !== -1) {
    return line.slice(idx + RAW_WS_MSG_MARKER.length).trim();
  }
  const keyIdx = line.indexOf('"trajectoryStateUpdate"');
  if (keyIdx === -1) return null;
  const braceIdx = line.lastIndexOf("{", keyIdx);
  if (braceIdx === -1) return null;
  return line.slice(braceIdx).trim();
}

function tryParseJsonCandidate<T>(
  candidate: string | null,
  parser: (obj: unknown) => T | null,
): T | null {
  if (!candidate) return null;
  try {
    return parser(JSON.parse(candidate));
  } catch {
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace === -1) return null;
    try {
      return parser(JSON.parse(candidate.slice(0, lastBrace + 1)));
    } catch {
      return null;
    }
  }
}

function parseTsuObject(parsed: unknown): TrajectoryStateUpdate | null {
  if (!parsed || typeof parsed !== "object") return null;
  const tsu = (parsed as { trajectoryStateUpdate?: unknown }).trajectoryStateUpdate;
  if (!tsu || typeof tsu !== "object") return null;
  const o = tsu as { trajectoryId?: unknown; state?: unknown };
  if (typeof o.trajectoryId !== "string" || typeof o.state !== "string") return null;
  return { trajectoryId: o.trajectoryId, state: o.state };
}

export function parseTrajectoryStateUpdate(line: string): TrajectoryStateUpdate | null {
  return tryParseJsonCandidate(extractJsonCandidate(line), parseTsuObject);
}

function parseStepUpdateObject(parsed: unknown): StepUpdate | null {
  if (!parsed || typeof parsed !== "object") return null;
  const su = (parsed as { stepUpdate?: unknown }).stepUpdate;
  if (!su || typeof su !== "object") return null;
  const o = su as {
    trajectoryId?: unknown;
    state?: unknown;
    target?: unknown;
    source?: unknown;
  };
  if (typeof o.trajectoryId !== "string" || typeof o.state !== "string") return null;
  return {
    trajectoryId: o.trajectoryId,
    state: o.state,
    target: typeof o.target === "string" ? o.target : undefined,
    source: typeof o.source === "string" ? o.source : undefined,
  };
}

export function parseStepUpdate(line: string): StepUpdate | null {
  return tryParseJsonCandidate(extractJsonCandidate(line), parseStepUpdateObject);
}
