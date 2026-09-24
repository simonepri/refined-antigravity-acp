import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import {
  ACP_METHODS,
  STOP_REASONS,
  type AcpStreamMessage,
  type CachedSessionMetadata,
  type CoreContext,
  type InboundContext,
  type OutboundContext,
  type StderrContext,
  type SessionCache,
  type UrlRewriter,
} from "./types.js";
import type { AcpPipeline } from "./pipeline.js";
import {
  createSessionCache,
  extractSessionId,
  getSession,
  getOrCreateSession,
  recordAllocatedSessionMeta,
  recordPendingSessionMetadata,
  resolveResponseSession,
  trackPendingRequestSession,
  clearPendingRequestSessions,
} from "./session-cache.js";

import { defaultSpawnProcess, traceAcp, writeJsonMessage } from "./transport.js";

export const RECYCLE_ID_PREFIX = "__refined_agy_recycle_";
export const RECYCLE_INIT_ID = `${RECYCLE_ID_PREFIX}init`;
export const RECYCLE_LOAD_ID = `${RECYCLE_ID_PREFIX}load`;
export const RECYCLE_MODE_ID = `${RECYCLE_ID_PREFIX}mode`;
export const RECYCLE_CONFIG_PREFIX = `${RECYCLE_ID_PREFIX}config_`;

const DEFAULT_RECYCLE_TIMEOUT_MS = 10_000;
const DEFAULT_RECYCLE_SPAWN_ATTEMPTS = 3;
const DEFAULT_RECYCLE_RETRY_DELAY_MS = 500;

function parseEnvMs(val: string | undefined, defaultMs: number): number {
  if (!val) return defaultMs;
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : defaultMs;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingInternalRequest {
  resolve: (msg: AcpStreamMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SupervisorOptions {
  cmd: string;
  args: string[];
  initialChild: ChildProcess;
  pipeline: AcpPipeline;
  sessionCache?: SessionCache | undefined;
  proxies?: UrlRewriter | undefined;
  spawnProcess?:
    | ((cmd: string, args: string[]) => ChildProcess | Promise<ChildProcess>)
    | undefined;
  recycleTimeoutMs?: number | undefined;
  /** Total spawn+resync attempts per recycle before giving up (including the first). */
  recycleSpawnAttempts?: number | undefined;
  /** Delay between failed respawn attempts. */
  recycleRetryDelayMs?: number | undefined;
}

export class ProcessSupervisor implements CoreContext {
  public currentChild: ChildProcess;
  public isRecycling = false;
  public isClosed = false;
  public readonly sessionCache: SessionCache;
  public proxies?: UrlRewriter | undefined;
  public readonly pipeline: AcpPipeline;

  private readonly cmd: string;
  private readonly args: string[];
  private readonly spawnFn: (cmd: string, args: string[]) => ChildProcess | Promise<ChildProcess>;
  private readonly recycleTimeoutMs: number;
  private readonly recycleSpawnAttempts: number;
  private readonly recycleRetryDelayMs: number;
  private readonly pendingRequests = new Map<string | number, PendingInternalRequest>();
  private readonly suppressedResponseIds = new Set<string | number>();
  private activeRecycle: Promise<void> | null = null;
  private rlOut: readline.Interface | null = null;
  private rlErr: readline.Interface | null = null;
  private readableController: ReadableStreamDefaultController<AcpStreamMessage> | null = null;
  private readonly baseContext: CoreContext;
  private readonly stderrContext: StderrContext;

  constructor(options: SupervisorOptions) {
    this.cmd = options.cmd;
    this.args = options.args;
    this.currentChild = options.initialChild;
    this.pipeline = options.pipeline;
    this.sessionCache = options.sessionCache ?? createSessionCache();
    this.proxies = options.proxies;
    this.spawnFn =
      options.spawnProcess ?? ((cmd, args) => defaultSpawnProcess(cmd, args, this.pipeline));
    this.recycleTimeoutMs =
      options.recycleTimeoutMs ??
      parseEnvMs(process.env.REFINED_AGY_RECYCLE_TIMEOUT_MS, DEFAULT_RECYCLE_TIMEOUT_MS);
    this.recycleSpawnAttempts = options.recycleSpawnAttempts ?? DEFAULT_RECYCLE_SPAWN_ATTEMPTS;
    this.recycleRetryDelayMs = options.recycleRetryDelayMs ?? DEFAULT_RECYCLE_RETRY_DELAY_MS;

    this.baseContext = {
      sessionCache: this.sessionCache,
      forwardInbound: (m: AcpStreamMessage) => this.forwardInbound(m),
      writeToChild: (m: AcpStreamMessage) => this.writeToChild(m),
      sendInternalRequest: (m: AcpStreamMessage, t?: number) => this.sendInternalRequest(m, t),
      triggerRecycle: (s: CachedSessionMetadata) => this.triggerRecycle(s),
      declareHang: (s: string, p: string | number, r: string) => this.declareHang(s, p, r),
    };
    Object.defineProperty(this.baseContext, "proxies", {
      get: () => this.proxies,
      enumerable: true,
      configurable: true,
    });
    this.stderrContext = this.baseContext;

    this.bindChild(this.currentChild);
  }

  setController(controller: ReadableStreamDefaultController<AcpStreamMessage>): void {
    this.readableController = controller;
  }

  forwardInbound(msg: AcpStreamMessage): void {
    try {
      this.readableController?.enqueue(msg);
    } catch {
      // Controller may already be closed
    }
  }

  async writeToChild(msg: AcpStreamMessage): Promise<void> {
    if (this.activeRecycle) {
      await this.activeRecycle;
    }
    if (this.isClosed) return;
    traceAcp("client->agy", msg);
    await writeJsonMessage(this.currentChild, msg);
  }

  declareHang(sessionId: string, promptId: string | number, reason: string): void {
    console.error(
      `[refined-antigravity-acp] Session ${sessionId} hung on prompt ${promptId} (${reason}); emitting synthetic end_turn & scheduling recycle`,
    );
    if (this.suppressedResponseIds.size >= 1000) {
      const oldest = this.suppressedResponseIds.keys().next().value;
      if (oldest !== undefined) this.suppressedResponseIds.delete(oldest);
    }
    this.suppressedResponseIds.add(promptId);
    const session = getOrCreateSession(this.sessionCache, sessionId);
    session.needsRecycle = true;

    const syntheticMsg = {
      jsonrpc: "2.0",
      id: promptId,
      result: { stopReason: STOP_REASONS.END_TURN },
    } as unknown as AcpStreamMessage;

    this.forwardInbound(syntheticMsg);
  }

  async triggerRecycle(session: CachedSessionMetadata): Promise<void> {
    if (this.activeRecycle) {
      await this.activeRecycle;
      return;
    }
    this.activeRecycle = this.recycleProcess(session);
    try {
      await this.activeRecycle;
    } finally {
      this.activeRecycle = null;
    }
  }

  sendInternalRequest(
    msg: AcpStreamMessage,
    timeoutMs: number = this.recycleTimeoutMs,
  ): Promise<AcpStreamMessage> {
    const id = (msg as { id?: string | number }).id;
    if (id === undefined || id === null) {
      return Promise.reject(new Error("Internal request missing id"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `Internal request ${String((msg as { method?: unknown }).method)} (${id}) timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      if (!this.currentChild.stdin?.writable) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error("Child stdin not writable for internal request"));
        return;
      }

      writeJsonMessage(this.currentChild, msg).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
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
      console.error(`[refined-antigravity-acp] Dropped late response for hung prompt ${msg.id}`);
      return true;
    }
    return false;
  }

  private createContext(
    session?: CachedSessionMetadata,
    proxies?: UrlRewriter,
    isRecycling?: boolean,
  ): InboundContext & OutboundContext {
    return {
      ...this.baseContext,
      proxies: proxies ?? this.proxies,
      session,
      isRecycling,
    };
  }

  private recordOutboundSessionNew(msg: AcpStreamMessage): void {
    if (!("id" in msg) || msg.id === null || msg.id === undefined) return;
    const p = (msg as { params?: { cwd?: string; modeId?: string; _meta?: unknown } }).params;
    if (!p) return;
    const pending = this.sessionCache.pendingSessionMetadata.get(msg.id) ?? {};
    if (p.cwd !== undefined) pending.cwd = p.cwd;
    if (p._meta !== undefined) pending._meta = p._meta;
    if (p.modeId !== undefined) pending.lastModeId = p.modeId;
    recordPendingSessionMetadata(this.sessionCache, msg.id, pending);
  }

  private recordOutboundSessionLoad(msg: AcpStreamMessage): void {
    const p = (
      msg as { params?: { sessionId?: string; cwd?: string; modeId?: string; _meta?: unknown } }
    ).params;
    if (!p?.sessionId) return;
    const session = getOrCreateSession(this.sessionCache, p.sessionId);
    if (p.cwd !== undefined) session.cwd = p.cwd;
    if (p._meta !== undefined) session._meta = p._meta;
    const mode =
      p.modeId ??
      (p._meta && typeof p._meta === "object" && "modeId" in p._meta
        ? (p._meta as { modeId?: string }).modeId
        : undefined);
    if (mode !== undefined) session.lastModeId = mode;
  }

  private recordOutboundSetMode(msg: AcpStreamMessage): void {
    const p = (msg as { params?: { sessionId?: string; modeId?: string } }).params;
    if (p?.sessionId && p.modeId) {
      getOrCreateSession(this.sessionCache, p.sessionId).lastModeId = p.modeId;
    }
  }

  private recordOutboundSetConfigOption(msg: AcpStreamMessage): void {
    const p = (
      msg as { params?: { sessionId?: string; configId?: string; value?: unknown; type?: string } }
    ).params;
    if (p?.sessionId && p.configId) {
      getOrCreateSession(this.sessionCache, p.sessionId).lastConfigOptions.set(p.configId, {
        value: p.value,
        type: p.type,
      });
    }
  }

  private handleSessionLifecycleMetadata(msg: AcpStreamMessage): void {
    if (!("method" in msg)) return;
    const isClose = msg.method === ACP_METHODS.SESSION_CLOSE;
    const isDelete = msg.method === ACP_METHODS.SESSION_DELETE;
    if (!isClose && !isDelete) return;
    const p = (msg as { params?: { sessionId?: string } }).params;
    if (p?.sessionId) {
      this.sessionCache.sessions.delete(p.sessionId);
    }
  }

  private recordOutboundMetadata(msg: AcpStreamMessage): void {
    if (!("method" in msg)) return;
    switch (msg.method) {
      case ACP_METHODS.INITIALIZE:
        this.sessionCache.cachedInitializeParams = (msg as { params?: unknown }).params;
        break;
      case ACP_METHODS.SESSION_NEW:
        this.recordOutboundSessionNew(msg);
        break;
      case ACP_METHODS.SESSION_LOAD:
        this.recordOutboundSessionLoad(msg);
        break;
      case ACP_METHODS.SESSION_SET_MODE:
        this.recordOutboundSetMode(msg);
        break;
      case ACP_METHODS.SESSION_SET_CONFIG_OPTION:
        this.recordOutboundSetConfigOption(msg);
        break;
      default:
        this.handleSessionLifecycleMetadata(msg);
        break;
    }
  }

  private trackPendingRequestSession(msg: AcpStreamMessage, sessionId?: string): void {
    if (!sessionId || !("id" in msg) || msg.id === null || msg.id === undefined) return;
    trackPendingRequestSession(this.sessionCache, msg.id, sessionId);
  }

  private async prepareOutboundSession(session?: CachedSessionMetadata): Promise<boolean> {
    if (this.activeRecycle) {
      await this.activeRecycle;
      if (this.isClosed) return false;
    }
    if (session?.needsRecycle) {
      await this.triggerRecycle(session);
    }
    return !this.isClosed;
  }

  async handleOutbound(msg: AcpStreamMessage, proxies?: UrlRewriter): Promise<void> {
    if (this.isClosed) return;
    if (proxies && !this.proxies) this.proxies = proxies;

    this.recordOutboundMetadata(msg);
    const sessionId = extractSessionId(msg);
    const session = getSession(this.sessionCache, sessionId);
    const ready = await this.prepareOutboundSession(session);
    if (!ready) return;

    const context = this.createContext(session, proxies);
    const transformed = await this.pipeline.applyOutbound(msg, context);
    if (transformed === null) return;

    this.trackPendingRequestSession(msg, sessionId);
    await this.writeToChild(transformed);
  }

  private recordInboundSessionAllocation(msg: AcpStreamMessage): void {
    if (!("result" in msg) || !msg.result || typeof msg.result !== "object") return;
    const res = msg.result as { sessionId?: unknown };
    if (
      typeof res.sessionId === "string" &&
      "id" in msg &&
      msg.id !== null &&
      msg.id !== undefined
    ) {
      recordAllocatedSessionMeta(msg.id, res.sessionId, this.sessionCache);
    }
  }

  private async dispatchInboundPipeline(
    msg: AcpStreamMessage,
    sessionId: string | undefined,
    context: InboundContext,
  ): Promise<void> {
    try {
      const messages = await this.pipeline.applyInbound(msg, context);
      for (const m of messages) this.forwardInbound(m);

      if ("result" in msg && sessionId) {
        const turnEndMessages = this.pipeline.applyTurnEnd(sessionId, context);
        for (const m of turnEndMessages) this.forwardInbound(m);
      }
    } catch (err) {
      console.error(
        "[refined-antigravity-acp] Inbound handling failed; forwarding raw message:",
        err,
      );
      this.forwardInbound(msg);
    }
  }

  async handleStdoutLine(line: string): Promise<void> {
    if (this.isClosed) return;
    let msg: AcpStreamMessage;
    try {
      msg = JSON.parse(line) as AcpStreamMessage;
    } catch {
      return;
    }
    traceAcp("agy->client", msg);
    if (this.tryHandleInternalRecycle(msg) || this.tryHandleSuppressedResponse(msg)) return;

    const responseSessionId = resolveResponseSession(msg, this.sessionCache);
    const sessionId = responseSessionId ?? extractSessionId(msg);
    this.recordInboundSessionAllocation(msg);
    const session = getSession(this.sessionCache, sessionId);

    const context = this.createContext(session, undefined, this.isRecycling);
    await this.dispatchInboundPipeline(msg, sessionId, context);
  }

  handleStderrLine(line: string): void {
    const suppressed = this.pipeline.applyStderrLine(line, this.stderrContext);
    if (!suppressed) {
      process.stderr.write(line + "\n");
    }
  }

  private bindChild(child: ChildProcess): void {
    if (child.stdout) {
      this.rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.rlOut.on("line", (line) => {
        this.handleStdoutLine(line).catch((err) => {
          console.error("[refined-antigravity-acp] Error in handleStdoutLine:", err);
        });
      });
    }

    if (child.stderr) {
      this.rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
      this.rlErr.on("line", (line) => this.handleStderrLine(line));
    }

    child.on("close", () => this.handleChildClose());
    child.on("error", (err) => this.handleChildClose(err));
  }

  private rejectPendingRequests(err?: Error): void {
    const error = err ?? new Error("Child process closed");
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.suppressedResponseIds.clear();
    clearPendingRequestSessions(this.sessionCache);
  }

  private closeController(err?: Error): void {
    try {
      if (err) this.readableController?.error(err);
      else this.readableController?.close();
    } catch {
      // Controller may already be closed
    }
  }

  private handleChildClose(err?: Error): void {
    if (this.isRecycling || this.isClosed) return;

    this.isClosed = true;
    this.pipeline.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    this.rejectPendingRequests(err);
    this.closeController(err);
  }

  private async resyncSessionLoad(
    session: CachedSessionMetadata,
    context: OutboundContext,
  ): Promise<void> {
    const loadParams: Record<string, unknown> = { sessionId: session.sessionId };
    if (session.cwd !== undefined) loadParams.cwd = session.cwd;
    if (session._meta !== undefined) loadParams._meta = session._meta;

    const loadMsg = {
      jsonrpc: "2.0",
      id: RECYCLE_LOAD_ID,
      method: ACP_METHODS.SESSION_LOAD,
      params: loadParams,
    } as unknown as AcpStreamMessage;

    const transformedLoad = await this.pipeline.applyOutbound(loadMsg, context);
    await this.sendInternalRequest(transformedLoad ?? loadMsg);
  }

  private async resyncSessionMode(
    session: CachedSessionMetadata,
    context: OutboundContext,
  ): Promise<void> {
    if (!session.lastModeId) return;
    const modeMsg = {
      jsonrpc: "2.0",
      id: RECYCLE_MODE_ID,
      method: ACP_METHODS.SESSION_SET_MODE,
      params: { sessionId: session.sessionId, modeId: session.lastModeId },
    } as unknown as AcpStreamMessage;
    const transformedMode = await this.pipeline.applyOutbound(modeMsg, context);
    await this.sendInternalRequest(transformedMode ?? modeMsg);
  }

  private async resyncSessionConfig(
    session: CachedSessionMetadata,
    context: OutboundContext,
  ): Promise<void> {
    if (!session.lastConfigOptions) return;
    for (const [configId, opt] of session.lastConfigOptions.entries()) {
      const configParams: Record<string, unknown> = {
        sessionId: session.sessionId,
        configId,
        value: opt.value,
      };
      if (opt.type !== undefined) configParams.type = opt.type;
      const cfgMsg = {
        jsonrpc: "2.0",
        id: `${RECYCLE_CONFIG_PREFIX}${configId}`,
        method: ACP_METHODS.SESSION_SET_CONFIG_OPTION,
        params: configParams,
      } as unknown as AcpStreamMessage;
      const transformedCfg = await this.pipeline.applyOutbound(cfgMsg, context);
      await this.sendInternalRequest(transformedCfg ?? cfgMsg);
    }
  }

  private async performResync(
    session: CachedSessionMetadata,
    newChild: ChildProcess,
  ): Promise<void> {
    const initParams = this.sessionCache.cachedInitializeParams ?? {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "refined-antigravity-acp", version: "0.2.0" },
    };

    await this.sendInternalRequest({
      jsonrpc: "2.0",
      id: RECYCLE_INIT_ID,
      method: "initialize",
      params: initParams,
    } as unknown as AcpStreamMessage);

    await this.pipeline.applyRecycle(session, newChild, this);
    const context = this.createContext(session);

    await this.resyncSessionLoad(session, context);
    await this.resyncSessionMode(session, context);
    await this.resyncSessionConfig(session, context);
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
    this.suppressedResponseIds.clear();
    clearPendingRequestSessions(this.sessionCache);
  }

  async recycleProcess(session: CachedSessionMetadata): Promise<void> {
    this.isRecycling = true;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.recycleSpawnAttempts; attempt++) {
      this.cleanupOldChild();
      try {
        const newChild = await this.spawnFn(this.cmd, this.args);
        this.currentChild = newChild;
        this.bindChild(newChild);

        await this.performResync(session, newChild);

        session.needsRecycle = false;
        this.isRecycling = false;
        return;
      } catch (err) {
        lastErr = err;
        const attemptsLeft = this.recycleSpawnAttempts - attempt;
        console.error(
          `[refined-antigravity-acp] Process recycle attempt ${attempt}/${this.recycleSpawnAttempts} failed` +
            (attemptsLeft > 0
              ? `; retrying in ${this.recycleRetryDelayMs}ms (${attemptsLeft} attempt(s) left):`
              : ", no attempts left:"),
          err,
        );
        if (attemptsLeft > 0) {
          await delay(this.recycleRetryDelayMs);
        }
      }
    }

    this.isRecycling = false;
    this.failRecycle(session, lastErr);
  }

  /**
   * Gives up on recycling after every spawn attempt failed: tears down whatever
   * child is left and fatally closes the stream with a clear, aggregated error
   * instead of leaving callers to interpret a raw timeout from the last attempt.
   */
  private failRecycle(session: CachedSessionMetadata, err: unknown): never {
    this.isClosed = true;
    this.pipeline.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill("SIGKILL");
    }

    const reason = err instanceof Error ? err.message : String(err);
    const errorObj = new Error(
      `Process recycle for session ${session.sessionId} failed after ${this.recycleSpawnAttempts} attempt(s): ${reason}`,
    );
    console.error(`[refined-antigravity-acp] ${errorObj.message}`);
    try {
      this.readableController?.error(errorObj);
    } catch {
      // Controller may already be closed
    }
    throw errorObj;
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.pipeline.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    this.currentChild.stdin?.end();
    if (!this.currentChild.killed) {
      this.currentChild.kill("SIGTERM");
    }
    this.rejectPendingRequests(new Error("Supervisor closed"));
    this.closeController();
  }

  abort(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.pipeline.dispose();
    this.rlErr?.close();
    this.rlOut?.close();
    this.currentChild.stdin?.end();
    if (!this.currentChild.killed) {
      this.currentChild.kill("SIGKILL");
    }
    this.rejectPendingRequests(new Error("Supervisor aborted"));
    this.closeController();
  }

  createStreams(): {
    readable: ReadableStream<AcpStreamMessage>;
    writable: WritableStream<AcpStreamMessage>;
  } {
    const readable = new ReadableStream<AcpStreamMessage>({
      start: (controller) => {
        this.setController(controller);
      },
      cancel: () => {
        this.close();
      },
    });

    const writable = new WritableStream<AcpStreamMessage>({
      write: async (msg) => {
        await this.handleOutbound(msg);
      },
      close: () => {
        this.close();
      },
      abort: () => {
        this.abort();
      },
    });

    return { readable, writable };
  }
}
