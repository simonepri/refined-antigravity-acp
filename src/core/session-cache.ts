import type { AcpStreamMessage, CachedSessionMetadata, SessionCache } from "./types.js";

export function createSessionCache(): SessionCache {
  return {
    sessions: new Map(),
    pendingSessionMetadata: new Map(),
    pendingRequestSessions: new Map(),
    cachedInitializeParams: undefined,
  };
}

export { getFixData, getOrCreateFixData, setFixData } from "./types.js";

export function getSession(
  cache: SessionCache,
  sessionId?: string | null,
): CachedSessionMetadata | undefined {
  return sessionId ? cache.sessions.get(sessionId) : undefined;
}

export function getOrCreateSession(cache: SessionCache, sessionId: string): CachedSessionMetadata {
  let session = cache.sessions.get(sessionId);
  if (!session) {
    session = {
      sessionId,
      lastConfigOptions: new Map(),
      fixData: new Map(),
    };
    cache.sessions.set(sessionId, session);
  } else if (!session.fixData) {
    session.fixData = new Map();
  }
  return session;
}

export function resolveResponseSession(
  msg: AcpStreamMessage,
  cache?: SessionCache,
): string | undefined {
  if (!cache || !("id" in msg) || msg.id === null || msg.id === undefined) return undefined;
  const sessionId = cache.pendingRequestSessions.get(msg.id);
  if (sessionId !== undefined) cache.pendingRequestSessions.delete(msg.id);
  return sessionId;
}

export function extractSessionId(msg: AcpStreamMessage): string | undefined {
  if (!("params" in msg) || !msg.params || typeof msg.params !== "object") return undefined;
  const params = msg.params as { sessionId?: unknown };
  return typeof params.sessionId === "string" ? params.sessionId : undefined;
}

function applyPendingSessionMetadata(
  session: CachedSessionMetadata,
  pending: Partial<CachedSessionMetadata>,
): void {
  if (pending.cwd !== undefined) session.cwd = pending.cwd;
  if (pending._meta !== undefined) session._meta = pending._meta;
  if (pending.lastModeId !== undefined) session.lastModeId = pending.lastModeId;
  if (pending.fixData) {
    session.fixData ??= new Map();
    for (const [key, value] of pending.fixData.entries()) {
      session.fixData.set(key, value);
    }
  }
}

const MAX_PENDING_REQUEST_SESSIONS = 1000;
const MAX_PENDING_SESSION_METADATA = 200;

export function trackPendingRequestSession(
  cache: SessionCache,
  id: string | number,
  sessionId: string,
): void {
  if (cache.pendingRequestSessions.size >= MAX_PENDING_REQUEST_SESSIONS) {
    const oldest = cache.pendingRequestSessions.keys().next().value;
    if (oldest !== undefined) cache.pendingRequestSessions.delete(oldest);
  }
  cache.pendingRequestSessions.set(id, sessionId);
}

export function clearPendingRequestSessions(cache: SessionCache): void {
  cache.pendingRequestSessions.clear();
}

export function recordPendingSessionMetadata(
  cache: SessionCache,
  id: string | number,
  metadata: Partial<CachedSessionMetadata>,
): void {
  if (cache.pendingSessionMetadata.size >= MAX_PENDING_SESSION_METADATA) {
    const oldest = cache.pendingSessionMetadata.keys().next().value;
    if (oldest !== undefined) cache.pendingSessionMetadata.delete(oldest);
  }
  cache.pendingSessionMetadata.set(id, metadata);
}

export function recordAllocatedSessionMeta(
  id: string | number,
  sessionId: string,
  cache: SessionCache,
): void {
  const pending = cache.pendingSessionMetadata.get(id);
  if (!pending) return;
  cache.pendingSessionMetadata.delete(id);
  const session = getOrCreateSession(cache, sessionId);
  applyPendingSessionMetadata(session, pending);
}
