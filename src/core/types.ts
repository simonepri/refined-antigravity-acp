import type { ChildProcess } from "node:child_process";

export const ACP_METHODS = {
  INITIALIZE: "initialize",
  AUTHENTICATE: "authenticate",
  LOGOUT: "logout",
  SESSION_NEW: "session/new",
  SESSION_LOAD: "session/load",
  SESSION_LIST: "session/list",
  SESSION_RESUME: "session/resume",
  SESSION_CLOSE: "session/close",
  SESSION_DELETE: "session/delete",
  SESSION_FORK: "session/fork",
  SESSION_PROMPT: "session/prompt",
  SESSION_SET_MODE: "session/set_mode",
  SESSION_SET_MODEL: "session/set_model",
  SESSION_SET_CONFIG_OPTION: "session/set_config_option",
  SESSION_CANCEL: "session/cancel",
  SESSION_UPDATE: "session/update",
  SESSION_REQUEST_PERMISSION: "session/request_permission",
  CANCEL_REQUEST: "$/cancel_request",
} as const;

export const SESSION_UPDATES = {
  AGENT_MESSAGE_CHUNK: "agent_message_chunk",
  USER_MESSAGE_CHUNK: "user_message_chunk",
  AGENT_THOUGHT_CHUNK: "agent_thought_chunk",
  TOOL_CALL: "tool_call",
  TOOL_CALL_UPDATE: "tool_call_update",
  PLAN: "plan",
  PLAN_UPDATE: "plan_update",
  PLAN_REMOVED: "plan_removed",
  AVAILABLE_COMMANDS_UPDATE: "available_commands_update",
  CURRENT_MODE_UPDATE: "current_mode_update",
  CONFIG_OPTION_UPDATE: "config_option_update",
  SESSION_INFO_UPDATE: "session_info_update",
  USAGE_UPDATE: "usage_update",
  NOTICE: "notice",
  COMPACTION_UPDATE: "compaction_update",
  COMPACTION_SUMMARY_CHUNK: "compaction_summary_chunk",
} as const;

export const STOP_REASONS = {
  END_TURN: "end_turn",
  CANCELLED: "cancelled",
} as const;

/**
 * Standard JSON-RPC 2.0 message variants in ACP
 */

export interface JsonRpcRequest<TMethod extends string = string, TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcNotification<TMethod extends string = string, TParams = unknown> {
  jsonrpc: "2.0";
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type AcpStreamMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export function isJsonRpcRequest(msg: AcpStreamMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg && msg.id !== null && msg.id !== undefined;
}

export function isJsonRpcNotification(msg: AcpStreamMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export function isJsonRpcSuccessResponse<T = unknown>(
  msg: AcpStreamMessage,
): msg is JsonRpcSuccessResponse<T> {
  return "result" in msg && "id" in msg;
}

export function isJsonRpcErrorResponse(msg: AcpStreamMessage): msg is JsonRpcErrorResponse {
  return "error" in msg && "id" in msg && typeof msg.error === "object" && msg.error !== null;
}

export function isMethod<M extends string>(
  msg: AcpStreamMessage,
  method: M,
): msg is (JsonRpcRequest<M> | JsonRpcNotification<M>) & { method: M } {
  return "method" in msg && msg.method === method;
}

export interface AcpStream {
  writable: WritableStream<AcpStreamMessage>;
  readable: ReadableStream<AcpStreamMessage>;
}

export type AcpConnector = () => AcpStream | Promise<AcpStream>;

export interface UrlRewriter {
  rewriteUrl: (url: string) => Promise<string> | string;
}

export interface CachedConfigOption {
  value: unknown;
  type?: string | undefined;
}

export interface CachedSessionMetadata {
  sessionId: string;
  cwd?: string;
  _meta?: unknown;
  lastModeId?: string;
  lastConfigOptions: Map<string, CachedConfigOption>;
  needsRecycle?: boolean;
  /** Fixes can store arbitrary session-scoped state here */
  fixData?: Map<string, unknown>;
}

export function getFixData<T>(
  session: CachedSessionMetadata | undefined,
  key: string,
): T | undefined {
  return session?.fixData?.get(key) as T | undefined;
}

export function setFixData<T>(session: CachedSessionMetadata, key: string, value: T): void {
  if (!session.fixData) {
    session.fixData = new Map<string, unknown>();
  }
  session.fixData.set(key, value);
}

export function getOrCreateFixData<T>(
  session: CachedSessionMetadata,
  key: string,
  factory: () => T,
): T {
  if (!session.fixData) {
    session.fixData = new Map<string, unknown>();
  }
  let data = session.fixData.get(key) as T | undefined;
  if (data === undefined) {
    data = factory();
    session.fixData.set(key, data);
  }
  return data;
}

export interface SessionCache {
  sessions: Map<string, CachedSessionMetadata>;
  pendingSessionMetadata: Map<string | number, Partial<CachedSessionMetadata>>;
  /** Session a pending request's response belongs to, by request id. */
  pendingRequestSessions: Map<string | number, string>;
  cachedInitializeParams?: unknown;
}

export interface CoreContext {
  sessionCache: SessionCache;
  proxies?: UrlRewriter | undefined;
  forwardInbound: (msg: AcpStreamMessage) => void;
  writeToChild: (msg: AcpStreamMessage) => Promise<void>;
  sendInternalRequest: (
    msg: AcpStreamMessage,
    timeoutMs?: number | undefined,
  ) => Promise<AcpStreamMessage>;
  triggerRecycle: (session: CachedSessionMetadata) => Promise<void>;
  declareHang: (sessionId: string, promptId: string | number, reason: string) => void;
}

export interface OutboundContext extends CoreContext {
  session?: CachedSessionMetadata | undefined;
  fixes?: readonly AcpFix[] | undefined;
}

export interface InboundContext extends CoreContext {
  session?: CachedSessionMetadata | undefined;
  isRecycling?: boolean | undefined;
}

export interface StderrContext extends CoreContext {
  session?: CachedSessionMetadata | undefined;
}

/**
 * Interface that each hardening fix implements.
 * To add a fix, implement this interface and add to active fixes list.
 * To remove a fix, delete the file and remove from active fixes list.
 */
export interface AcpFix {
  /** Unique name of the fix matching the Readme issue (e.g. "flattened-model-efforts") */
  readonly name: string;

  /** Optional human-readable description */
  readonly description?: string;

  /** Hook called during child process spawning to modify environment or command */
  onSpawn?: (env: NodeJS.ProcessEnv, cmd: string, args: string[]) => void;

  /**
   * Intercept or modify an outbound message from the client before it is written to the child process.
   * Return null or undefined to drop the message.
   */
  onOutbound?: (
    msg: AcpStreamMessage,
    context: OutboundContext,
  ) => Promise<AcpStreamMessage | null | undefined> | AcpStreamMessage | null | undefined;

  /**
   * Intercept or modify an inbound message from the child process before it reaches the client.
   * Return an array of messages (empty to drop, multiple to expand).
   */
  onInbound?: (
    msg: AcpStreamMessage,
    context: InboundContext,
  ) => Promise<AcpStreamMessage[]> | AcpStreamMessage[];

  /**
   * Hook called when a turn completes (e.g. response with result arrived),
   * allowing fixes to flush buffered items or emit synthesized end chunks.
   */
  onTurnEnd?: (sessionId: string, context: InboundContext) => AcpStreamMessage[];

  /**
   * Intercept a line of stderr output from the child process.
   * Return true to suppress/drop the line from stderr.
   */
  onStderrLine?: (line: string, context: StderrContext) => boolean;

  /**
   * Hook called when a child process is recycled to resynchronize fix state.
   */
  onRecycle?: (
    session: CachedSessionMetadata,
    newChild: ChildProcess,
    context: CoreContext,
  ) => Promise<void> | void;

  /**
   * Optional hook allowing a fix to contribute domain-specific system instructions or guidelines
   * (e.g. formatting requirements, steering behavior) to the session prompt.
   */
  getSystemInstructions?: (
    session?: CachedSessionMetadata,
    context?: OutboundContext,
  ) => readonly string[] | undefined;

  /** Clean up timers, locks, or resources when the connector closes */
  dispose?: () => void;
}

/**
 * Structured ACP protocol payloads
 */
export interface McpServerConfig {
  name: string;
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: unknown;
}

export interface PromptContentItem {
  type: string;
  text?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface SessionPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: {
    name: string;
    version: string;
  };
  [key: string]: unknown;
}

export interface SessionNewParams {
  cwd?: string;
  modeId?: string;
  _meta?: unknown;
  mcpServers?: McpServerConfig[];
  [key: string]: unknown;
}

export interface SessionLoadParams {
  sessionId: string;
  cwd?: string;
  modeId?: string;
  _meta?: unknown;
  mcpServers?: McpServerConfig[];
  [key: string]: unknown;
}

export interface SessionSetModeParams {
  sessionId: string;
  modeId: string;
  [key: string]: unknown;
}

export interface SessionSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: unknown;
  type?: string;
  [key: string]: unknown;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: string | PromptContentItem[];
  [key: string]: unknown;
}

export interface SessionCancelParams {
  sessionId: string;
  [key: string]: unknown;
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface SessionUpdatePayload {
  sessionUpdate?: string;
  content?:
    | TextContentBlock
    | TextContentBlock[]
    | { type?: string; text?: string }
    | Array<{ type?: string; text?: string }>
    | unknown[]
    | null;
  toolCallId?: string;
  name?: string | null;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  arguments?: unknown;
  entries?: SessionPlanEntry[];
  availableCommands?: Array<{ name: string; description: string }>;
  [key: string]: unknown;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdatePayload;
  [key: string]: unknown;
}

export interface SessionAllocationResult {
  sessionId: string;
  [key: string]: unknown;
}

export interface SessionPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export type InitializeRequest = JsonRpcRequest<"initialize", InitializeParams>;
export type SessionNewRequest = JsonRpcRequest<"session/new", SessionNewParams>;
export type SessionLoadRequest = JsonRpcRequest<"session/load", SessionLoadParams>;
export type SessionPromptRequest = JsonRpcRequest<"session/prompt", SessionPromptParams>;
export type SessionSetModeRequest = JsonRpcRequest<"session/set_mode", SessionSetModeParams>;
export type SessionSetConfigOptionRequest = JsonRpcRequest<
  "session/set_config_option",
  SessionSetConfigOptionParams
>;
export type SessionCancelNotification = JsonRpcNotification<"session/cancel", SessionCancelParams>;
export type SessionUpdateNotification = JsonRpcNotification<"session/update", SessionUpdateParams>;
