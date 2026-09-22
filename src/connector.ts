import fs from "node:fs";
import path from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import type { AcpConnector, AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { agyCommand, ensureAntigravityBinary } from "./command.js";
import { ensurePatchedBinary } from "./agy-patch.js";
import { formatSystemContext, sanitizeAssistantText, StreamSanitizer } from "./sanitize.js";
import { ensureAuthenticated } from "./auth.js";
import { type McpProxyPool, sharedMcpProxyPool } from "./mcp-proxy.js";

export const DEFAULT_HANG_GRACE_MS = 5000;
export const DEFAULT_HANG_INACTIVITY_MS = 30_000;
export const DEFAULT_RECYCLE_TIMEOUT_MS = 30_000;

export const RECYCLE_ID_PREFIX = "paseo-antigravity:recycle:";
export const RECYCLE_INIT_ID = `${RECYCLE_ID_PREFIX}init`;
export const RECYCLE_LOAD_ID = `${RECYCLE_ID_PREFIX}load`;
export const RECYCLE_MODE_ID = `${RECYCLE_ID_PREFIX}mode`;
export const RECYCLE_CONFIG_PREFIX = `${RECYCLE_ID_PREFIX}config:`;

function parseEnvMs(val: string | undefined, defaultMs: number): number {
  if (!val) return defaultMs;
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : defaultMs;
}

function extractJsonCandidate(line: string): string | null {
  const marker = "RAW WS MSG:";
  const idx = line.indexOf(marker);
  if (idx !== -1) {
    return line.slice(idx + marker.length).trim();
  }
  const keyIdx = line.indexOf('"trajectoryStateUpdate"');
  if (keyIdx === -1) return null;
  const braceIdx = line.lastIndexOf("{", keyIdx);
  if (braceIdx === -1) return null;
  return line.slice(braceIdx).trim();
}

function parseTsuObject(parsed: unknown): { trajectoryId: string; state: string } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const tsu = (parsed as { trajectoryStateUpdate?: unknown }).trajectoryStateUpdate;
  if (!tsu || typeof tsu !== "object") return null;
  const o = tsu as { trajectoryId?: unknown; state?: unknown };
  if (typeof o.trajectoryId !== "string" || typeof o.state !== "string") return null;
  return { trajectoryId: o.trajectoryId, state: o.state };
}

export function parseTrajectoryStateUpdate(
  line: string,
): { trajectoryId: string; state: string } | null {
  const candidate = extractJsonCandidate(line);
  if (!candidate) return null;

  try {
    return parseTsuObject(JSON.parse(candidate));
  } catch {
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace === -1) return null;
    try {
      return parseTsuObject(JSON.parse(candidate.slice(0, lastBrace + 1)));
    } catch {
      return null;
    }
  }
}

function parseStepUpdateObject(
  parsed: unknown,
): { trajectoryId: string; state: string; target?: string; source?: string } | null {
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

export function parseStepUpdate(
  line: string,
): { trajectoryId: string; state: string; target?: string; source?: string } | null {
  const candidate = extractJsonCandidate(line);
  if (!candidate) return null;

  try {
    return parseStepUpdateObject(JSON.parse(candidate));
  } catch {
    const lastBrace = candidate.lastIndexOf("}");
    if (lastBrace === -1) return null;
    try {
      return parseStepUpdateObject(JSON.parse(candidate.slice(0, lastBrace + 1)));
    } catch {
      return null;
    }
  }
}

export interface PendingPrompt {
  nativeSessionId: string;
  sentAt: number;
  lastActivityAt: number;
  timer?: NodeJS.Timeout;
  inactivityTimer?: NodeJS.Timeout;
}

export interface HangDetectorOptions {
  graceMs?: number;
  inactivityMs?: number;
  onHangDeclared?: (nativeSessionId: string, promptId: string | number) => void;
  now?: () => number;
}

export class HangDetector {
  public readonly graceMs: number;
  public readonly inactivityMs: number;
  public onHangDeclared?: (nativeSessionId: string, promptId: string | number) => void;
  public readonly pendingPrompts: Map<string | number, PendingPrompt> = new Map();
  public readonly lastStates: Map<string, string> = new Map();
  public readonly hungSessions: Set<string> = new Set();
  private readonly now: () => number;

  constructor(options?: HangDetectorOptions) {
    this.graceMs =
      options?.graceMs ?? parseEnvMs(process.env.PASEO_AGY_HANG_GRACE_MS, DEFAULT_HANG_GRACE_MS);
    this.inactivityMs =
      options?.inactivityMs ??
      parseEnvMs(process.env.PASEO_AGY_HANG_INACTIVITY_MS, DEFAULT_HANG_INACTIVITY_MS);
    this.onHangDeclared = options?.onHangDeclared;
    this.now = options?.now ?? Date.now;
  }

  isHung(nativeSessionId: string): boolean {
    return this.hungSessions.has(nativeSessionId);
  }

  clearHung(nativeSessionId: string): void {
    this.hungSessions.delete(nativeSessionId);
    this.lastStates.delete(nativeSessionId);
  }

  private scheduleInactivityTimer(
    nativeSessionId: string,
    promptId: string | number,
    prompt: PendingPrompt,
  ): void {
    if (prompt.inactivityTimer) {
      clearTimeout(prompt.inactivityTimer);
    }
    prompt.inactivityTimer = setTimeout(() => {
      this.checkInactivity(nativeSessionId, promptId);
    }, this.inactivityMs);
  }

  private startGraceTimer(
    nativeSessionId: string,
    id: string | number,
    prompt: PendingPrompt,
  ): void {
    if (prompt.timer) return;
    prompt.timer = setTimeout(() => {
      this.onGraceTimerFired(nativeSessionId, id);
    }, this.graceMs);
  }

  recordPrompt(id: string | number, nativeSessionId: string): void {
    const now = this.now();
    const prompt: PendingPrompt = {
      nativeSessionId,
      sentAt: now,
      lastActivityAt: now,
    };
    this.pendingPrompts.set(id, prompt);
    this.scheduleInactivityTimer(nativeSessionId, id, prompt);

    if (this.lastStates.get(nativeSessionId) === "STATE_WAITING_FOR_TASKS") {
      this.startGraceTimer(nativeSessionId, id, prompt);
    }
  }

  recordActivity(nativeSessionId: string): void {
    const now = this.now();
    for (const [id, prompt] of this.pendingPrompts.entries()) {
      if (prompt.nativeSessionId === nativeSessionId) {
        prompt.lastActivityAt = now;
        this.scheduleInactivityTimer(nativeSessionId, id, prompt);
      }
    }
  }

  resolvePrompt(id: string | number): void {
    const prompt = this.pendingPrompts.get(id);
    if (!prompt) return;

    if (prompt.timer) {
      clearTimeout(prompt.timer);
    }
    if (prompt.inactivityTimer) {
      clearTimeout(prompt.inactivityTimer);
    }
    this.pendingPrompts.delete(id);
  }

  private clearPromptTimers(prompt: PendingPrompt): void {
    if (prompt.timer) {
      clearTimeout(prompt.timer);
      prompt.timer = undefined;
    }
    if (prompt.inactivityTimer) {
      clearTimeout(prompt.inactivityTimer);
      prompt.inactivityTimer = undefined;
    }
  }

  private logHangReason(
    nativeSessionId: string,
    promptId: string | number,
    reason: "grace" | "inactivity",
  ): void {
    if (reason === "inactivity") {
      console.error(
        `[paseo-antigravity] Inactivity backstop fired for session ${nativeSessionId}, prompt ${promptId}`,
      );
    } else {
      console.error(
        `[paseo-antigravity] Hang declared for session ${nativeSessionId}, prompt ${promptId} (STATE_WAITING_FOR_TASKS)`,
      );
    }
  }

  private declareHang(
    nativeSessionId: string,
    promptId: string | number,
    reason: "grace" | "inactivity",
  ): void {
    this.hungSessions.add(nativeSessionId);
    const prompt = this.pendingPrompts.get(promptId);
    if (prompt) {
      this.clearPromptTimers(prompt);
      this.pendingPrompts.delete(promptId);
    }
    this.logHangReason(nativeSessionId, promptId, reason);
    this.onHangDeclared?.(nativeSessionId, promptId);
  }

  private onGraceTimerFired(nativeSessionId: string, promptId: string | number): void {
    const prompt = this.pendingPrompts.get(promptId);
    if (!prompt) return;
    prompt.timer = undefined;
    this.declareHang(nativeSessionId, promptId, "grace");
  }

  private checkInactivity(nativeSessionId: string, promptId: string | number): void {
    const prompt = this.pendingPrompts.get(promptId);
    if (!prompt) return;

    const elapsed = this.now() - prompt.lastActivityAt;
    if (elapsed >= this.inactivityMs) {
      this.declareHang(nativeSessionId, promptId, "inactivity");
      return;
    }
    const remaining = this.inactivityMs - elapsed;
    prompt.inactivityTimer = setTimeout(() => {
      this.checkInactivity(nativeSessionId, promptId);
    }, remaining);
  }

  private handleWaitingForTasks(nativeSessionId: string): void {
    for (const [id, prompt] of this.pendingPrompts.entries()) {
      if (prompt.nativeSessionId === nativeSessionId) {
        this.startGraceTimer(nativeSessionId, id, prompt);
      }
    }
  }

  private clearGraceTimersForSession(nativeSessionId: string): void {
    for (const prompt of this.pendingPrompts.values()) {
      if (prompt.nativeSessionId === nativeSessionId && prompt.timer) {
        clearTimeout(prompt.timer);
        prompt.timer = undefined;
      }
    }
  }

  processStderrLine(line: string): void {
    const tsu = parseTrajectoryStateUpdate(line);
    if (tsu) {
      const { trajectoryId, state } = tsu;
      this.lastStates.set(trajectoryId, state);

      if (state === "STATE_WAITING_FOR_TASKS") {
        this.handleWaitingForTasks(trajectoryId);
      } else {
        this.clearGraceTimersForSession(trajectoryId);
      }
      return;
    }

    const su = parseStepUpdate(line);
    if (su) {
      const { trajectoryId, state, target } = su;
      if (state === "STATE_ACTIVE" && target === "TARGET_ENVIRONMENT") {
        // Active environment step (e.g. running a tool) clears grace timer
        this.clearGraceTimersForSession(trajectoryId);
      }
    }
  }

  processOutbound(msg: AcpStreamMessage): void {
    if (!("method" in msg) || msg.method !== "session/prompt") return;
    const m = msg as { id?: unknown; params?: { sessionId?: unknown } };
    if (typeof m.id !== "string" && typeof m.id !== "number") return;
    if (typeof m.params?.sessionId !== "string") return;

    this.recordPrompt(m.id, m.params.sessionId);
  }

  processInbound(msg: AcpStreamMessage): void {
    if ("method" in msg && msg.method === "session/update") {
      const sessionId = (msg as { params?: { sessionId?: unknown } }).params?.sessionId;
      if (typeof sessionId === "string") {
        this.recordActivity(sessionId);
      }
      return;
    }

    if (("result" in msg || "error" in msg) && "id" in msg) {
      const id = (msg as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") {
        this.resolvePrompt(id);
      }
    }
  }

  dispose(): void {
    for (const prompt of this.pendingPrompts.values()) {
      this.clearPromptTimers(prompt);
    }
    this.pendingPrompts.clear();
  }
}

/**
 * Strips duplicate mode configuration options from ACP session/new and session/load responses.
 *
 * agy_acp_server returns modes both in `result.modes` and as a setting option with `id: "mode"`
 * in `result.configOptions`. Filtering out `id: "mode"` prevents duplicate controls in the Paseo UI.
 */
export function filterConfigOptions(result: unknown): void {
  if (!result || typeof result !== "object" || !("configOptions" in result)) return;
  const res = result as { configOptions?: unknown[] };
  if (!Array.isArray(res.configOptions)) return;

  res.configOptions = res.configOptions.filter((opt) => {
    if (!opt || typeof opt !== "object") return true;
    const o = opt as { id?: string; category?: string };
    return o.id !== "mode" && o.category !== "mode";
  });
}

function fallbackSanitizeBlock(block: unknown): void {
  if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
    block.text = sanitizeAssistantText(block.text);
  }
}

function fallbackSanitizeInboundText(msg: AcpStreamMessage): void {
  if (!("method" in msg) || msg.method !== "session/update") return;
  const content = (msg as { params?: { update?: { content?: unknown } } }).params?.update?.content;
  if (!content) return;

  if (Array.isArray(content)) {
    for (const block of content) fallbackSanitizeBlock(block);
  } else {
    fallbackSanitizeBlock(content);
  }
}

function sanitizeBlock(block: unknown, sanitizer: StreamSanitizer): boolean {
  if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
    block.text = sanitizer.process(block.text);
    return block.text !== "";
  }
  return true;
}

function extractUpdateContent(
  msg: AcpStreamMessage,
): { content: unknown; isMessageChunk: boolean } | null {
  if (!("method" in msg) || msg.method !== "session/update") return null;
  const update = (msg as { params?: { update?: unknown } }).params?.update;
  if (!update || typeof update !== "object") return null;
  const content = (update as { content?: unknown }).content;
  if (!content) return null;
  const isMessageChunk =
    (update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk";
  return { content, isMessageChunk };
}

function sanitizeInboundText(msg: AcpStreamMessage, sanitizer: StreamSanitizer): boolean {
  const target = extractUpdateContent(msg);
  if (!target) return true;

  let hasNonEmpty = false;
  if (Array.isArray(target.content)) {
    for (const block of target.content) {
      if (sanitizeBlock(block, sanitizer)) hasNonEmpty = true;
    }
  } else {
    hasNonEmpty = sanitizeBlock(target.content, sanitizer);
  }

  return !target.isMessageChunk || hasNonEmpty;
}

export interface SystemPromptState {
  pendingSystemPrompts: Map<string | number, string | undefined>;
  sessionSystemPrompts: Map<string, string | undefined>;
  injectedSessions: Set<string>;
}

export function createSystemPromptState(): SystemPromptState {
  return {
    pendingSystemPrompts: new Map(),
    sessionSystemPrompts: new Map(),
    injectedSessions: new Set(),
  };
}

const defaultSystemPromptState = createSystemPromptState();

export function resetSystemPromptState(): void {
  defaultSystemPromptState.pendingSystemPrompts.clear();
  defaultSystemPromptState.sessionSystemPrompts.clear();
  defaultSystemPromptState.injectedSessions.clear();
}

/** Tracks the session a turn belongs to so flushed text can be attributed to it. */
export interface InboundState {
  lastSessionId: string | null;
}

function sessionIdOf(msg: AcpStreamMessage): string | null {
  if (!("method" in msg) || msg.method !== "session/update") return null;
  const sessionId = (msg as { params?: { sessionId?: unknown } }).params?.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

function agentMessageChunk(sessionId: string, text: string): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  } as unknown as AcpStreamMessage;
}

/**
 * Processes an inbound ACP message received from `agy_acp_server`:
 * 1. Filters duplicate mode controls from `configOptions`.
 * 2. Sanitizes assistant streaming text notifications across chunk boundaries.
 * 3. Flushes text still held in the sanitizer's look-ahead buffer at a turn boundary.
 *
 * Returns the messages to forward. A streaming chunk that sanitizes to nothing is
 * dropped, and a turn boundary may yield an extra chunk carrying the flushed tail.
 */
function closeTurn(
  msg: AcpStreamMessage,
  sanitizer?: StreamSanitizer,
  state?: InboundState,
): AcpStreamMessage[] {
  filterConfigOptions((msg as { result: unknown }).result);
  // A response ends the turn. Whatever is still buffered was a suspected harness tag
  // that never materialized, so it is real text and must be emitted, not discarded.
  const tail = sanitizer?.flush() ?? "";
  sanitizer?.reset();
  const sessionId = state?.lastSessionId;
  return tail && sessionId ? [agentMessageChunk(sessionId, tail), msg] : [msg];
}

export interface CachedConfigOption {
  value: unknown;
  type?: string;
}

export interface CachedSessionMetadata {
  sessionId: string;
  cwd?: string;
  mcpServers?: unknown[];
  _meta?: unknown;
  lastModeId?: string;
  lastConfigOptions: Map<string, CachedConfigOption>;
  needsRecycle?: boolean;
}

export interface SessionCache {
  sessions: Map<string, CachedSessionMetadata>;
  pendingSessionMetadata: Map<string | number, Partial<CachedSessionMetadata>>;
  cachedInitializeParams?: unknown;
}

export function createSessionCache(): SessionCache {
  return {
    sessions: new Map(),
    pendingSessionMetadata: new Map(),
    cachedInitializeParams: undefined,
  };
}

const defaultSessionCache = createSessionCache();

export function resetSessionCache(): void {
  defaultSessionCache.sessions.clear();
  defaultSessionCache.pendingSessionMetadata.clear();
  defaultSessionCache.cachedInitializeParams = undefined;
}

export function getOrCreateSession(cache: SessionCache, sessionId: string): CachedSessionMetadata {
  let session = cache.sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      lastConfigOptions: new Map(),
    };
    cache.sessions.set(sessionId, session);
  }
  return session;
}

function recordAllocatedSessionPrompt(
  id: string | number,
  sessionId: string,
  promptState: SystemPromptState,
): void {
  if (promptState.pendingSystemPrompts.has(id)) {
    const systemPrompt = promptState.pendingSystemPrompts.get(id);
    promptState.pendingSystemPrompts.delete(id);
    promptState.sessionSystemPrompts.set(sessionId, systemPrompt);
  }
}

function recordAllocatedSessionMeta(
  id: string | number,
  sessionId: string,
  cache: SessionCache,
): void {
  if (cache.pendingSessionMetadata.has(id)) {
    const pending = cache.pendingSessionMetadata.get(id);
    cache.pendingSessionMetadata.delete(id);
    const session = getOrCreateSession(cache, sessionId);
    if (pending?.cwd !== undefined) session.cwd = pending.cwd;
    if (pending?.mcpServers !== undefined) session.mcpServers = pending.mcpServers;
    if (pending?._meta !== undefined) session._meta = pending._meta;
  }
}

function recordAllocatedSession(
  msg: AcpStreamMessage,
  promptState: SystemPromptState,
  cache: SessionCache,
): void {
  if (!("result" in msg) || !msg.result || typeof msg.result !== "object") return;
  if (!("sessionId" in msg.result)) return;
  const sessionId = (msg.result as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || !("id" in msg) || msg.id === null || msg.id === undefined) {
    return;
  }

  recordAllocatedSessionPrompt(msg.id, sessionId, promptState);
  recordAllocatedSessionMeta(msg.id, sessionId, cache);
}

export function processInboundMessage(
  msg: AcpStreamMessage,
  sanitizer?: StreamSanitizer,
  state?: InboundState,
  promptState: SystemPromptState = defaultSystemPromptState,
  sessionCache: SessionCache = defaultSessionCache,
): AcpStreamMessage[] {
  if ("result" in msg && msg.result) {
    recordAllocatedSession(msg, promptState, sessionCache);
    return closeTurn(msg, sanitizer, state);
  }

  if (state) {
    const sessionId = sessionIdOf(msg);
    if (sessionId) state.lastSessionId = sessionId;
  }

  if (sanitizer) {
    return sanitizeInboundText(msg, sanitizer) ? [msg] : [];
  }
  fallbackSanitizeInboundText(msg);
  return [msg];
}

interface McpHeader {
  name: string;
  value: string;
}

function normalizeMcpHeaders(headers: unknown): McpHeader[] | undefined {
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    return headers.flatMap((h) => {
      if (!h || typeof h !== "object") return [];
      const name = typeof h.name === "string" ? h.name : typeof h.key === "string" ? h.key : "";
      const value = typeof h.value === "string" ? h.value : "";
      return name ? [{ name, value }] : [];
    });
  }
  if (typeof headers === "object") {
    return Object.entries(headers as Record<string, unknown>).flatMap(([name, val]) =>
      typeof val === "string" ? [{ name, value: val }] : [],
    );
  }
  return undefined;
}

/**
 * Rewrites Paseo MCP server declarations for agy_acp_server:
 * 1. Routes the URL through a local proxy that normalizes the MCP protocol version.
 * 2. Normalizes headers to array shape [{ name, value }].
 *
 * The transport type is passed through untouched. agy advertises
 * `mcpCapabilities: {http: true, sse: true}` and issues streamable-HTTP POSTs either
 * way, so declaring Paseo's streamable-HTTP endpoint as "sse" only misdescribed it.
 */
export async function rewriteMcpServers(servers: unknown[], proxies?: McpProxyPool): Promise<void> {
  for (const s of servers) {
    if (!s || typeof s !== "object") continue;
    const server = s as { type?: string; url?: string; headers?: unknown };
    if (server.url && proxies) {
      server.url = await proxies.rewriteUrl(server.url);
    }
    const normalized = normalizeMcpHeaders(server.headers);
    if (normalized) {
      server.headers = normalized;
    }
  }
}

/**
 * Processes an outbound ACP message sent from Paseo to `agy_acp_server`:
 * 1. Rewrites MCP server declarations (URL proxying, headers normalization).
 * 2. Maps legacy / generic mode IDs ("accept-edits" -> "auto_edit", "dangerously-skip-permissions" -> "yolo").
 */
function remapModeId(modeId: string): string {
  if (modeId === "accept-edits") return "auto_edit";
  if (modeId === "dangerously-skip-permissions") return "yolo";
  if (modeId === "plan") return "default";
  return modeId;
}

interface OutboundParams {
  mcpServers?: unknown[];
  modeId?: string;
  sessionId?: unknown;
  prompt?: unknown;
  cwd?: string;
  configId?: string;
  value?: unknown;
  type?: string;
  _meta?: {
    _paseo?: {
      systemPrompt?: string;
    };
  };
}

function captureSessionNewPrompt(msg: AcpStreamMessage, promptState: SystemPromptState): void {
  if (!("id" in msg) || msg.id === null || msg.id === undefined) return;
  const params = (msg as { params?: OutboundParams }).params;
  const systemPrompt = params?._meta?._paseo?.systemPrompt;
  promptState.pendingSystemPrompts.set(msg.id, systemPrompt);
}

function injectSystemContext(prompt: unknown, systemPrompt?: string): void {
  if (!Array.isArray(prompt)) return;
  const textPart = prompt.find((p): p is { type: "text"; text: string } =>
    Boolean(
      p &&
      typeof p === "object" &&
      (p as { type?: unknown }).type === "text" &&
      typeof (p as { text?: unknown }).text === "string",
    ),
  );
  const formatted = `${formatSystemContext(systemPrompt)}

`;
  if (textPart) {
    textPart.text = `${formatted}${textPart.text}`;
  } else {
    prompt.unshift({ type: "text", text: formatted.trimEnd() });
  }
}

function handleSessionPrompt(
  params: OutboundParams | undefined,
  promptState: SystemPromptState,
): void {
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
  if (!sessionId) return;
  if (!promptState.sessionSystemPrompts.has(sessionId)) return;
  if (promptState.injectedSessions.has(sessionId)) return;

  promptState.injectedSessions.add(sessionId);
  const systemPrompt = promptState.sessionSystemPrompts.get(sessionId);
  injectSystemContext(params?.prompt, systemPrompt);
}

function captureSessionNewMetadata(msg: AcpStreamMessage, cache: SessionCache): void {
  if (!("id" in msg) || msg.id === null || msg.id === undefined) return;
  const params = (msg as { params?: OutboundParams }).params;
  cache.pendingSessionMetadata.set(msg.id, {
    cwd: typeof params?.cwd === "string" ? params.cwd : undefined,
    mcpServers: Array.isArray(params?.mcpServers) ? params?.mcpServers : undefined,
    _meta: params?._meta,
  });
}

function captureSessionLoadMetadata(msg: AcpStreamMessage, cache: SessionCache): void {
  const params = (msg as { params?: OutboundParams }).params;
  if (typeof params?.sessionId !== "string") return;
  const session = getOrCreateSession(cache, params.sessionId);
  if (typeof params.cwd === "string") session.cwd = params.cwd;
  if (Array.isArray(params.mcpServers)) session.mcpServers = params.mcpServers;
  if (params._meta !== undefined) session._meta = params._meta;
}

function captureSetMode(msg: AcpStreamMessage, cache: SessionCache): void {
  const params = (msg as { params?: OutboundParams }).params;
  if (typeof params?.sessionId !== "string" || typeof params?.modeId !== "string") return;
  const session = getOrCreateSession(cache, params.sessionId);
  session.lastModeId = params.modeId;
}

function captureSetConfigOption(msg: AcpStreamMessage, cache: SessionCache): void {
  const params = (msg as { params?: OutboundParams }).params;
  if (typeof params?.sessionId !== "string" || typeof params?.configId !== "string") return;
  const session = getOrCreateSession(cache, params.sessionId);
  session.lastConfigOptions.set(params.configId, {
    value: params.value,
    type: typeof params.type === "string" ? params.type : undefined,
  });
}

function cacheInitializeParams(msg: AcpStreamMessage, cache: SessionCache): void {
  if ("params" in msg) {
    cache.cachedInitializeParams = (msg as { params?: unknown }).params;
  }
}

export function extractSessionId(msg: AcpStreamMessage): string | null {
  if (!("params" in msg) || !msg.params || typeof msg.params !== "object") {
    return null;
  }
  const sid = (msg.params as { sessionId?: unknown }).sessionId;
  return typeof sid === "string" ? sid : null;
}

async function adaptOutboundParams(params?: OutboundParams, proxies?: McpProxyPool): Promise<void> {
  if (params?.mcpServers && Array.isArray(params.mcpServers)) {
    await rewriteMcpServers(params.mcpServers, proxies);
  }
  if (params?.modeId) {
    params.modeId = remapModeId(params.modeId);
  }
}

function dispatchOutboundMethod(
  msg: AcpStreamMessage & { method: string },
  params: OutboundParams | undefined,
  promptState: SystemPromptState,
  sessionCache: SessionCache,
): void {
  switch (msg.method) {
    case "initialize":
      cacheInitializeParams(msg, sessionCache);
      break;
    case "session/new":
      captureSessionNewPrompt(msg, promptState);
      captureSessionNewMetadata(msg, sessionCache);
      break;
    case "session/load":
      captureSessionLoadMetadata(msg, sessionCache);
      break;
    case "session/set_mode":
      captureSetMode(msg, sessionCache);
      break;
    case "session/set_config_option":
      captureSetConfigOption(msg, sessionCache);
      break;
    case "session/prompt":
      handleSessionPrompt(params, promptState);
      break;
  }
}

export async function processOutboundMessage(
  msg: AcpStreamMessage,
  proxies?: McpProxyPool,
  promptState: SystemPromptState = defaultSystemPromptState,
  sessionCache: SessionCache = defaultSessionCache,
): Promise<AcpStreamMessage> {
  if (!("method" in msg)) return msg;
  const params = (msg as { params?: OutboundParams }).params;
  await adaptOutboundParams(params, proxies);
  dispatchOutboundMethod(msg, params, promptState, sessionCache);
  return msg;
}

export interface StreamState {
  isClosed: boolean;
}

const ACP_TRACE_ENABLED = process.env.PASEO_AGY_TRACE === "1";

/**
 * Logs ACP request/response ids when PASEO_AGY_TRACE=1.
 *
 * An ACP request that never receives a response leaves Paseo waiting out its 60s
 * session RPC timeout with no indication of which call stalled; this names it.
 */
function traceAcp(direction: "paseo->agy" | "agy->paseo", msg: AcpStreamMessage): void {
  if (!ACP_TRACE_ENABLED) return;
  const m = msg as { id?: unknown; method?: unknown; error?: unknown };
  const id = m.id === undefined ? "-" : String(m.id);
  const kind = m.method ? String(m.method) : m.error ? "error" : "result";
  console.error(`[paseo-antigravity][acp] ${direction} id=${id} ${kind}`);
}

export interface AntigravityConnectorOptions extends HangDetectorOptions {
  spawnProcess?: (cmd: string, args: string[]) => ChildProcess | Promise<ChildProcess>;
  recycleTimeoutMs?: number;
}

export interface ChildSlotParams {
  cmd: string;
  args: string[];
  initialChild: ChildProcess;
  proxies?: McpProxyPool;
  options?: AntigravityConnectorOptions;
}

interface PendingInternalRequest {
  resolve: (msg: AcpStreamMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function resolveHarnessPath(cmd: string): string | undefined {
  // The harness (`localharness_external`) ships next to the original Google
  // server binary, not next to our patched copy under plugin-data, so always
  // resolve it relative to the original (unpatched) executable.
  try {
    const [original] = agyCommand();
    const real = fs.realpathSync(original ?? cmd);
    const sibling = path.join(path.dirname(real), "localharness_external");
    if (fs.existsSync(sibling)) return sibling;
  } catch {
    // Ignore resolution errors
  }
  return undefined;
}

function defaultSpawnProcess(cmd: string, args: string[]): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: "false",
  };
  const harness = resolveHarnessPath(cmd);
  if (harness) {
    env.ANTIGRAVITY_HARNESS_PATH = harness;
  }
  return spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
}

export class ChildSlot {
  public currentChild: ChildProcess;
  public rlOut: readline.Interface | null = null;
  public rlErr: readline.Interface | null = null;
  public isRecycling = false;
  public isSwallowingUpdates = false;
  public readonly suppressedResponseIds: Set<string | number> = new Set();
  public readonly sessionCache: SessionCache = createSessionCache();
  public readonly promptState: SystemPromptState = createSystemPromptState();
  public readonly hangDetector: HangDetector;
  public readonly state: StreamState = { isClosed: false };
  public readableController: ReadableStreamDefaultController<AcpStreamMessage> | null = null;

  private readonly cmd: string;
  private readonly args: string[];
  private readonly spawnFn: (cmd: string, args: string[]) => ChildProcess | Promise<ChildProcess>;
  private readonly recycleTimeoutMs: number;
  private readonly sanitizer = new StreamSanitizer();
  private readonly inboundState: InboundState = { lastSessionId: null };
  private readonly pendingRequests: Map<string | number, PendingInternalRequest> = new Map();
  private activeRecycle: Promise<void> | null = null;

  constructor(params: ChildSlotParams) {
    this.cmd = params.cmd;
    this.args = params.args;
    this.currentChild = params.initialChild;
    this.spawnFn = params.options?.spawnProcess ?? defaultSpawnProcess;
    this.recycleTimeoutMs =
      params.options?.recycleTimeoutMs ??
      parseEnvMs(process.env.PASEO_AGY_RECYCLE_TIMEOUT_MS, DEFAULT_RECYCLE_TIMEOUT_MS);

    const userOnHang = params.options?.onHangDeclared;
    this.hangDetector = new HangDetector({
      ...params.options,
      onHangDeclared: (nativeSessionId, promptId) => {
        this.handleHangDeclared(nativeSessionId, promptId);
        userOnHang?.(nativeSessionId, promptId);
      },
    });

    this.bindChild(this.currentChild);
  }

  setReadableController(controller: ReadableStreamDefaultController<AcpStreamMessage>): void {
    this.readableController = controller;
  }

  private parseJsonLine(line: string): AcpStreamMessage | null {
    try {
      return JSON.parse(line) as AcpStreamMessage;
    } catch {
      return null;
    }
  }

  private tryHandleInternalRecycle(msg: AcpStreamMessage): boolean {
    if (!("id" in msg) || msg.id === null || msg.id === undefined) return false;
    const idStr = String(msg.id);
    if (!idStr.startsWith(RECYCLE_ID_PREFIX)) return false;

    const pending = this.pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if ("error" in msg && msg.error) {
        pending.reject(new Error(msg.error.message || "Recycle request failed"));
      } else {
        pending.resolve(msg);
      }
    }
    return true;
  }

  private tryHandleSuppressedResponse(msg: AcpStreamMessage): boolean {
    if (!("id" in msg) || msg.id === null || msg.id === undefined) return false;
    if (this.suppressedResponseIds.has(msg.id)) {
      this.suppressedResponseIds.delete(msg.id);
      console.error(`[paseo-antigravity] Dropped late response for hung prompt ${msg.id}`);
      return true;
    }
    return false;
  }

  private forwardInbound(msg: AcpStreamMessage): void {
    const list = processInboundMessage(
      msg,
      this.sanitizer,
      this.inboundState,
      this.promptState,
      this.sessionCache,
    );
    for (const processed of list) {
      try {
        this.readableController?.enqueue(processed);
      } catch {
        // Controller may already be closed
      }
    }
  }

  handleStdoutLine(line: string): void {
    if (this.state.isClosed) return;
    const msg = this.parseJsonLine(line);
    if (!msg) return;

    traceAcp("agy->paseo", msg);

    if (this.tryHandleInternalRecycle(msg)) return;
    if (this.tryHandleSuppressedResponse(msg)) return;
    if (this.isSwallowingUpdates && "method" in msg && msg.method === "session/update") return;

    this.hangDetector.processInbound(msg);
    this.forwardInbound(msg);
  }

  handleChildClose(err?: Error): void {
    if (this.isRecycling) return;
    if (this.state.isClosed) return;

    this.state.isClosed = true;
    this.hangDetector.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    try {
      if (err) this.readableController?.error(err);
      else this.readableController?.close();
    } catch {
      // Stream already closed
    }
  }

  handleHangDeclared(nativeSessionId: string, promptId: string | number): void {
    console.error(
      `[paseo-antigravity] Session ${nativeSessionId} hung on prompt ${promptId}; turn synthetic end_turn emitted, scheduled process recycle`,
    );
    this.suppressedResponseIds.add(promptId);
    const session = getOrCreateSession(this.sessionCache, nativeSessionId);
    session.needsRecycle = true;

    const syntheticMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: "end_turn" },
    } as unknown as AcpStreamMessage;

    try {
      this.readableController?.enqueue(syntheticMsg);
    } catch {
      // Controller may be closed
    }
  }

  sendInternalRequest(
    child: ChildProcess,
    id: string,
    method: string,
    params?: unknown,
  ): Promise<AcpStreamMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Recycle internal request ${method} (${id}) timed out after ${this.recycleTimeoutMs}ms`,
          ),
        );
      }, this.recycleTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      const req = { jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) };

      if (!child.stdin?.writable) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Child stdin not writable for ${method}`));
        return;
      }

      child.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private async resyncSessionLoad(
    session: CachedSessionMetadata,
    newChild: ChildProcess,
  ): Promise<void> {
    this.isSwallowingUpdates = true;
    try {
      const loadParams: Record<string, unknown> = { sessionId: session.sessionId };
      if (session.cwd !== undefined) loadParams.cwd = session.cwd;
      if (session.mcpServers !== undefined) loadParams.mcpServers = session.mcpServers;
      if (session._meta !== undefined) loadParams._meta = session._meta;
      await this.sendInternalRequest(newChild, RECYCLE_LOAD_ID, "session/load", loadParams);
    } finally {
      this.isSwallowingUpdates = false;
    }
  }

  private async resyncSessionMode(
    session: CachedSessionMetadata,
    newChild: ChildProcess,
  ): Promise<void> {
    if (!session.lastModeId) return;
    await this.sendInternalRequest(newChild, RECYCLE_MODE_ID, "session/set_mode", {
      sessionId: session.sessionId,
      modeId: session.lastModeId,
    });
  }

  private async resyncSessionConfig(
    session: CachedSessionMetadata,
    newChild: ChildProcess,
  ): Promise<void> {
    if (!session.lastConfigOptions || session.lastConfigOptions.size === 0) return;
    for (const [configId, opt] of session.lastConfigOptions.entries()) {
      const configParams: Record<string, unknown> = {
        sessionId: session.sessionId,
        configId,
        value: opt.value,
      };
      if (opt.type !== undefined) configParams.type = opt.type;
      await this.sendInternalRequest(
        newChild,
        `${RECYCLE_CONFIG_PREFIX}${configId}`,
        "session/set_config_option",
        configParams,
      );
    }
  }

  private async performResync(
    session: CachedSessionMetadata,
    newChild: ChildProcess,
  ): Promise<void> {
    const initParams = this.sessionCache.cachedInitializeParams ?? {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "paseo", version: "1.0.0" },
    };
    await this.sendInternalRequest(newChild, RECYCLE_INIT_ID, "initialize", initParams);
    await this.resyncSessionLoad(session, newChild);
    await this.resyncSessionMode(session, newChild);
    await this.resyncSessionConfig(session, newChild);
  }

  private cleanupOldChild(): void {
    const oldChild = this.currentChild;
    this.rlOut?.close();
    this.rlErr?.close();
    this.rlOut = null;
    this.rlErr = null;
    if (oldChild && !oldChild.killed) {
      oldChild.kill("SIGKILL");
    }
  }

  private handleRecycleFailure(err: unknown): void {
    console.error("[paseo-antigravity] Process recycle failed:", err);
    this.state.isClosed = true;
    this.hangDetector.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill("SIGKILL");
    }
    try {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this.readableController?.error(errorObj);
    } catch {
      // Controller may already be closed
    }
  }

  async recycleProcess(session: CachedSessionMetadata): Promise<void> {
    try {
      this.isRecycling = true;
      this.cleanupOldChild();

      const newChild = await this.spawnFn(this.cmd, this.args);
      this.currentChild = newChild;
      this.bindChild(newChild);

      await this.performResync(session, newChild);

      session.needsRecycle = false;
      this.hangDetector.clearHung(session.sessionId);
      this.sanitizer.reset();
      this.isRecycling = false;
    } catch (err) {
      this.handleRecycleFailure(err);
      throw err;
    }
  }

  private async writeToChild(msg: AcpStreamMessage): Promise<void> {
    if (this.state.isClosed || !this.currentChild.stdin?.writable) {
      throw new Error("Antigravity ACP stream is closed");
    }
    if (!this.currentChild.stdin.write(JSON.stringify(msg) + "\n")) {
      await once(this.currentChild.stdin, "drain");
    }
  }

  async write(msg: AcpStreamMessage, proxies?: McpProxyPool): Promise<void> {
    if (this.state.isClosed) {
      throw new Error("Antigravity ACP stream is closed");
    }

    const targetSessionId = extractSessionId(msg);
    const session = targetSessionId ? this.sessionCache.sessions.get(targetSessionId) : undefined;

    if (session?.needsRecycle) {
      if (!this.activeRecycle) {
        this.activeRecycle = this.recycleProcess(session);
      }
      try {
        await this.activeRecycle;
      } finally {
        this.activeRecycle = null;
      }
    }

    const processed = await processOutboundMessage(
      msg,
      proxies,
      this.promptState,
      this.sessionCache,
    );
    this.hangDetector.processOutbound(processed);
    traceAcp("paseo->agy", processed);
    await this.writeToChild(processed);
  }

  close(): void {
    if (this.state.isClosed) return;
    this.state.isClosed = true;
    this.hangDetector.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    this.currentChild.stdin?.end();
    if (!this.currentChild.killed) {
      this.currentChild.kill("SIGTERM");
    }
    try {
      this.readableController?.close();
    } catch {
      // Controller already closed
    }
  }

  abort(): void {
    if (this.state.isClosed) return;
    this.state.isClosed = true;
    this.hangDetector.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    this.currentChild.stdin?.end();
    if (!this.currentChild.killed) {
      this.currentChild.kill("SIGKILL");
    }
    try {
      this.readableController?.close();
    } catch {
      // Controller already closed
    }
  }

  bindChild(child: ChildProcess): void {
    if (child.stdout) {
      this.rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.rlOut.on("line", (line) => this.handleStdoutLine(line));
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => {
        process.stderr.write(chunk);
      });
      this.rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      this.rlErr.on("line", (line) => {
        this.hangDetector.processStderrLine(line);
      });
    }

    child.on("close", () => this.handleChildClose());
    child.on("error", (err) => this.handleChildClose(err));
  }
}

export function createAcpReadableStream(slot: ChildSlot): ReadableStream<AcpStreamMessage> {
  return new ReadableStream<AcpStreamMessage>({
    start(controller) {
      slot.setReadableController(controller);
    },
    cancel() {
      slot.close();
    },
  });
}

export function createAcpWritableStream(
  slot: ChildSlot,
  proxies?: McpProxyPool,
): WritableStream<AcpStreamMessage> {
  return new WritableStream<AcpStreamMessage>({
    async write(msg) {
      await slot.write(msg, proxies);
    },
    close() {
      slot.close();
    },
    abort() {
      slot.abort();
    },
  });
}

async function resolveBinaryCommand(): Promise<[string, ...string[]]> {
  const [initialCmd, ...args] = agyCommand();
  let cmd = initialCmd;
  if (!fs.existsSync(cmd)) {
    try {
      cmd = await ensureAntigravityBinary();
    } catch (err) {
      console.error("[paseo-antigravity] Failed to auto-download binary:", err);
    }
  }
  if (fs.existsSync(cmd)) {
    try {
      cmd = ensurePatchedBinary(cmd);
    } catch (err) {
      console.error("[paseo-antigravity] Failed to patch binary:", err);
    }
  }
  return [cmd, ...args];
}

/**
 * Creates an in-process ACP connector stream that launches the official `agy_acp_server` binary,
 * automatically downloading it if not present, and applies mode option filtering, outbound MCP adaptation,
 * text sanitization, hang detection, and transparent process recycling.
 *
 * MCP proxies come from a process-wide pool rather than being owned by this stream.
 * Antigravity persists the rewritten MCP URL into its per-session database, so a proxy
 * torn down with the stream would leave resumed sessions pointing at a dead port.
 */
export function createAntigravityConnector(
  proxies: McpProxyPool = sharedMcpProxyPool,
  options?: AntigravityConnectorOptions,
): AcpConnector {
  return async (): Promise<AcpStream> => {
    const [cmd, ...args] = await resolveBinaryCommand();
    ensureAuthenticated();

    const spawnFn = options?.spawnProcess ?? defaultSpawnProcess;
    const initialChild = await spawnFn(cmd, args);

    const slot = new ChildSlot({
      cmd,
      args,
      initialChild,
      proxies,
      options,
    });

    return {
      readable: createAcpReadableStream(slot),
      writable: createAcpWritableStream(slot, proxies),
    };
  };
}
