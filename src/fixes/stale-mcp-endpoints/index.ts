/**
 * Problem:
 * When an upstream process hangs or panics and is recycled, resending client `mcpServers`
 * with stale ephemeral localhost ports fails because proxy endpoints have moved or closed.
 *
 * Solution:
 * Establishes a dynamic loopback MCP proxy pool that intercepts outbound `mcpServers` URLs,
 * remaps ephemeral ports to stable virtual endpoints, and rewrites headers across process restarts.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import {
  ACP_METHODS,
  getFixData,
  setFixData,
  type AcpStreamMessage,
  type AcpFix,
  type CachedSessionMetadata,
  type CoreContext,
  type OutboundContext,
  type UrlRewriter,
} from "../../core/types.js";
import { getOrCreateSession, extractSessionId } from "../../core/session-cache.js";

/**
 * Protocol versions the target MCP server understands. Standard MCP servers embed
 * `@modelcontextprotocol/sdk`, whose streamable-HTTP transport rejects any request
 * carrying an `MCP-Protocol-Version` header outside this list with HTTP 400.
 */

export const DEFAULT_SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

/** Headers that are meaningful only for a single hop and must not be forwarded. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface McpProxyOptions {
  /** Versions the upstream accepts. Anything else is rewritten to `fallbackProtocolVersion`. */
  supportedProtocolVersions?: readonly string[];
  /** Version substituted when the client asks for one the upstream does not support. */
  fallbackProtocolVersion?: string;
  /**
   * File used to remember the listening port across restarts. Antigravity persists the
   * MCP server URL into its per-session SQLite database, so a session resumed after a
   * daemon restart still points at whatever port we used when it was created.
   */
  portFile?: string | null;
}

function defaultPortFile(): string {
  const base = process.env.REFINED_AGY_DATA_DIR ?? path.join(os.homedir(), ".refined-antigravity");
  return path.join(base, "mcp-proxy-ports.json");
}

function readPortFile(file: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, v]) => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536,
      ) as Array<[string, number]>,
    );
  } catch {
    return {};
  }
}

function writePortFile(file: string, origin: string, port: number): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...readPortFile(file), [origin]: port }, null, 2));
  } catch {
    // A missing port file only costs us port stability, never correctness.
  }
}

function sendJsonRpcError(res: http.ServerResponse, statusCode: number, message: string): void {
  if (res.headersSent) return;
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32603,
      message,
    },
    id: null,
  });
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

interface JsonRpcDescription {
  isNotification: boolean;
  method: string | null;
}

function describeJsonRpc(body: Buffer): JsonRpcDescription {
  if (body.length === 0) return { isNotification: false, method: null };
  try {
    const parsed: unknown = JSON.parse(body.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { isNotification: false, method: null };
    }
    const { method, id } = parsed as Record<string, unknown>;
    const methodName = typeof method === "string" ? method : null;
    return {
      isNotification: methodName !== null && id === undefined,
      method: methodName,
    };
  } catch {
    return { isNotification: false, method: null };
  }
}

function formatNotificationAbsorbLog(statusCode: number, method: string | null): string {
  const methodLabel = method ? '"' + method + '"' : "unknown";
  const base =
    "[refined-antigravity-acp][mcp-proxy] Absorbed upstream " +
    statusCode +
    " on notification " +
    methodLabel +
    "; replied 202 so go-sdk does not tear the session down";
  if (method === "notifications/cancelled") {
    return base;
  }
  return base + " (indicates proxy normalization bug; investigate)";
}

function normalizeAccept(rawAccept: string | string[] | undefined): string {
  const accept = Array.isArray(rawAccept) ? rawAccept.join(", ") : rawAccept;
  if (!accept || !accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return "application/json, text/event-stream";
  }
  return accept;
}

/**
 * A loopback reverse proxy for a single upstream MCP origin.
 *
 * Google's `agy_acp_server` ships an MCP client that advertises protocol version
 * `2026-07-28`, which standard MCP daemons reject with HTTP 400 on every request after
 * `initialize`. This proxy normalizes that header down to a version the upstream

 * accepts, turning a hard transport failure into ordinary version negotiation.
 *
 * It is origin-bound and forwards the request path and query verbatim, so
 * `?callerAgentId=...` survives and the client's OAuth discovery probes
 * (`/.well-known/oauth-protected-resource/...`) reach the real upstream path
 * instead of being collapsed onto the MCP endpoint.
 */
export class McpProxyServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private readonly origin: URL;
  private readonly supportedProtocolVersions: ReadonlySet<string>;
  private readonly fallbackProtocolVersion: string;
  private readonly portFile: string | null;

  constructor(origin: string, options: McpProxyOptions = {}) {
    this.origin = new URL(origin);
    this.supportedProtocolVersions = new Set(
      options.supportedProtocolVersions ?? DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
    );
    this.fallbackProtocolVersion =
      options.fallbackProtocolVersion ?? DEFAULT_SUPPORTED_PROTOCOL_VERSIONS[0];
    this.portFile = options.portFile === undefined ? defaultPortFile() : options.portFile;
  }

  private buildForwardHeaders(
    req: http.IncomingMessage,
    bodyLength: number,
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, val] of Object.entries(req.headers)) {
      if (name !== "host" && !HOP_BY_HOP_HEADERS.has(name) && val !== undefined) {
        headers[name] = val;
      }
    }

    const version = req.headers["mcp-protocol-version"];
    if (typeof version === "string" && !this.supportedProtocolVersions.has(version)) {
      headers["mcp-protocol-version"] = this.fallbackProtocolVersion;
    }

    headers.accept = normalizeAccept(req.headers.accept);

    if (bodyLength > 0) {
      if (!headers["content-type"]) {
        headers["content-type"] = "application/json";
      }
      headers["content-length"] = bodyLength;
    }

    return headers;
  }

  private handleProxyResponse(
    res: http.ServerResponse,
    proxyRes: http.IncomingMessage,
    rpcDesc: JsonRpcDescription,
  ): void {
    const statusCode = proxyRes.statusCode ?? 502;
    if (rpcDesc.isNotification && statusCode >= 400 && statusCode < 500) {
      console.error(formatNotificationAbsorbLog(statusCode, rpcDesc.method));
      proxyRes.resume();
      res.writeHead(202, { "Content-Length": "0" });
      res.end();
      return;
    }

    res.writeHead(statusCode, proxyRes.headers);
    // MCP responses are often `text/event-stream`; without an explicit flush the
    // headers can sit in Node's buffer until the first chunk, stalling the client.
    res.flushHeaders();
    proxyRes.pipe(res);
  }

  private forwardRequest(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const isTls = this.origin.protocol === "https:";
    const transport = isTls ? https : http;
    const rpcDesc = describeJsonRpc(body);

    const proxyReq = transport.request(
      {
        protocol: this.origin.protocol,
        hostname: this.origin.hostname,
        port: this.origin.port || (isTls ? 443 : 80),
        method: req.method,
        // Verbatim path + query. The upstream owns its own routing.
        path: req.url,
        headers: this.buildForwardHeaders(req, body.length),
      },
      (proxyRes) => this.handleProxyResponse(res, proxyRes, rpcDesc),
    );

    proxyReq.on("error", (err) => {
      sendJsonRpcError(res, 502, `MCP proxy error: ${err.message}`);
    });
    // Long-lived SSE streams must not be reaped by the default socket timeout.
    proxyReq.setTimeout(0);
    res.on("close", () => proxyReq.destroy());

    proxyReq.end(body);
  }

  /**
   * Buffering the request body in memory is safe and necessary because MCP JSON-RPC
   * messages are small (typically <1MB) and buffering allows us to inspect for
   * notifications (missing `id`) before forwarding or deciding whether to absorb 4xx
   * responses, while also enabling re-streaming the body to upstream.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", (err) => {
      sendJsonRpcError(res, 400, `MCP proxy request error: ${err.message}`);
    });
    req.on("end", () => {
      this.forwardRequest(req, res, Buffer.concat(chunks));
    });
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.keepAliveTimeout = 0;
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          server.removeListener("error", reject);
          this.server = server;
          this.port = addr.port;
          resolve(addr.port);
        } else {
          reject(new Error("MCP proxy failed to resolve a listening port"));
        }
      });
    });
  }

  /**
   * Starts the proxy on 127.0.0.1, preferring the port used on the previous run so
   * that URLs Antigravity persisted for existing sessions keep resolving.
   */
  async start(): Promise<number> {
    if (this.port !== null) return this.port;

    const remembered = this.portFile ? readPortFile(this.portFile)[this.origin.origin] : undefined;
    if (remembered !== undefined) {
      try {
        return await this.listen(remembered);
      } catch {
        // Port taken by something else; fall through to an ephemeral one.
      }
    }

    const port = await this.listen(0);
    if (this.portFile) writePortFile(this.portFile, this.origin.origin, port);
    return port;
  }

  getPort(): number | null {
    return this.port;
  }

  /**
   * Rewrites an upstream MCP URL to route through this proxy, preserving path and query.
   *
   * Throws when the proxy is not listening. Returning the original URL here would
   * silently hand Antigravity a direct upstream connection with no header
   * normalization, which is exactly the failure this class exists to prevent.
   */
  rewriteUrl(originalUrl: string): string {
    if (this.port === null) {
      throw new Error(
        `MCP proxy for ${this.origin.origin} is not running; refusing to expose an un-normalized MCP URL`,
      );
    }
    const target = new URL(originalUrl);
    return `http://127.0.0.1:${this.port}${target.pathname}${target.search}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Backward compatibility alias */
export { McpProxyServer as McpProxy };

/**
 * Process-wide pool of proxies keyed by upstream origin.
 *
 * Proxies deliberately outlive individual agent connections: Antigravity writes the
 * rewritten URL into its session database, so tearing a proxy down when one stream
 * ends would leave every resumed session pointing at a dead port.
 */
export class McpProxyPool {
  private readonly proxies = new Map<string, Promise<McpProxyServer>>();
  private readonly options: McpProxyOptions;

  constructor(options: McpProxyOptions = {}) {
    this.options = options;
  }

  async rewriteUrl(originalUrl: string): Promise<string> {
    const origin = new URL(originalUrl).origin;
    let pending = this.proxies.get(origin);
    if (!pending) {
      pending = (async () => {
        const proxy = new McpProxyServer(origin, this.options);
        await proxy.start();
        return proxy;
      })();
      this.proxies.set(origin, pending);
      pending.catch(() => this.proxies.delete(origin));
    }
    return (await pending).rewriteUrl(originalUrl);
  }

  async stopAll(): Promise<void> {
    const pending = Array.from(this.proxies.values());
    this.proxies.clear();
    await Promise.all(
      pending.map((p) =>
        p.then(
          (proxy) => proxy.stop(),
          () => undefined,
        ),
      ),
    );
  }
}

/** Shared pool. One proxy per upstream origin for the lifetime of the daemon process. */
export const sharedMcpProxyPool = new McpProxyPool();

export interface McpHeader {
  name: string;
  value: string;
}

function normalizeArrayHeaders(headers: unknown[]): McpHeader[] {
  const result: McpHeader[] = [];
  for (const h of headers) {
    if (!h || typeof h !== "object") continue;
    const entry = h as Record<string, unknown>;
    const name =
      typeof entry.name === "string" ? entry.name : typeof entry.key === "string" ? entry.key : "";
    const value = typeof entry.value === "string" ? entry.value : "";
    if (name) result.push({ name, value });
  }
  return result;
}

function normalizeObjectHeaders(headers: Record<string, unknown>): McpHeader[] {
  const result: McpHeader[] = [];
  for (const [name, val] of Object.entries(headers)) {
    if (typeof val === "string") result.push({ name, value: val });
  }
  return result;
}

export function normalizeMcpHeaders(headers: unknown): McpHeader[] | undefined {
  if (!headers) return undefined;
  if (Array.isArray(headers)) return normalizeArrayHeaders(headers);
  if (typeof headers === "object") {
    return normalizeObjectHeaders(headers as Record<string, unknown>);
  }
  return undefined;
}

export const MCP_SERVERS_KEY = "mcpServers";
export const MCP_SERVERS_ORIGINAL_KEY = "mcpServersOriginal";

export function getSessionMcpServers(session: CachedSessionMetadata): unknown[] | undefined {
  return getFixData<unknown[]>(session, MCP_SERVERS_KEY);
}

export function setSessionMcpServers(session: CachedSessionMetadata, servers: unknown[]): void {
  setFixData(session, MCP_SERVERS_KEY, servers);
}

export function getSessionMcpServersOriginal(
  session: CachedSessionMetadata,
): unknown[] | undefined {
  return getFixData<unknown[]>(session, MCP_SERVERS_ORIGINAL_KEY);
}

export function setSessionMcpServersOriginal(
  session: CachedSessionMetadata,
  servers: unknown[],
): void {
  setFixData(session, MCP_SERVERS_ORIGINAL_KEY, servers);
}

export async function rewriteMcpServers(servers: unknown[], proxies?: UrlRewriter): Promise<void> {
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

function handleSessionLoadMcp(
  params: { mcpServers?: unknown[]; sessionId?: unknown },
  context: OutboundContext,
): boolean {
  if (typeof params.sessionId !== "string" || params.mcpServers) return false;
  const session = getOrCreateSession(context.sessionCache, params.sessionId);
  const cachedServers = getSessionMcpServers(session);
  if (cachedServers) {
    params.mcpServers = structuredClone(cachedServers);
    return true;
  }
  return false;
}

function recordOutboundMcpServersOriginal(
  msg: AcpStreamMessage,
  context: OutboundContext,
  sessionId?: string,
  original?: unknown[],
): void {
  if (!original) return;
  if (sessionId) {
    const session = getOrCreateSession(context.sessionCache, sessionId);
    setSessionMcpServersOriginal(session, original);
  } else if ("id" in msg && msg.id !== null && msg.id !== undefined) {
    const pending = context.sessionCache.pendingSessionMetadata.get(msg.id) ?? {};
    pending.fixData ??= new Map();
    pending.fixData.set(MCP_SERVERS_ORIGINAL_KEY, original);
    context.sessionCache.pendingSessionMetadata.set(msg.id, pending);
  }
}

function recordOutboundMcpServers(
  msg: AcpStreamMessage,
  context: OutboundContext,
  sessionId?: string,
  servers?: unknown[],
): void {
  if (!servers) return;
  if (sessionId) {
    const session = getOrCreateSession(context.sessionCache, sessionId);
    setSessionMcpServers(session, servers);
  } else if ("id" in msg && msg.id !== null && msg.id !== undefined) {
    const pending = context.sessionCache.pendingSessionMetadata.get(msg.id) ?? {};
    pending.fixData ??= new Map();
    pending.fixData.set(MCP_SERVERS_KEY, servers);
    context.sessionCache.pendingSessionMetadata.set(msg.id, pending);
  }
}

export const staleMcpEndpointsFix: AcpFix = {
  name: "stale-mcp-endpoints",
  description:
    "Dynamic loopback proxy pool to maintain stable MCP tool URLs across child process recycling",

  async onOutbound(msg: AcpStreamMessage, context: OutboundContext): Promise<AcpStreamMessage> {
    if (!("method" in msg)) return msg;
    const params = (msg as { params?: { mcpServers?: unknown[]; sessionId?: unknown } }).params;
    if (!params) return msg;

    if (msg.method === ACP_METHODS.SESSION_LOAD && handleSessionLoadMcp(params, context)) {
      return msg;
    }

    if (Array.isArray(params.mcpServers)) {
      const sessionId = extractSessionId(msg);
      const original = structuredClone(params.mcpServers);
      recordOutboundMcpServersOriginal(msg, context, sessionId, original);
      await rewriteMcpServers(params.mcpServers, context.proxies);
      recordOutboundMcpServers(msg, context, sessionId, params.mcpServers);
    }

    return msg;
  },

  async onRecycle(session, _newChild, context: CoreContext): Promise<void> {
    const original = getSessionMcpServersOriginal(session);
    if (!original) return;
    const reRewritten = structuredClone(original);
    await rewriteMcpServers(reRewritten, context.proxies);
    setSessionMcpServers(session, reRewritten);
  },

  dispose(): void {
    void sharedMcpProxyPool.stopAll();
  },
};

export const mcpPortRemappingFix = staleMcpEndpointsFix;
