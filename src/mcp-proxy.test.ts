import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpProxy, McpProxyPool } from "./mcp-proxy.js";

interface Received {
  method: string;
  url: string;
  protocolVersion?: string;
  authorization?: string;
  accept?: string;
  contentType?: string;
  body: string;
}

describe("McpProxy", () => {
  const started: Array<McpProxy | McpProxyPool> = [];
  let upstream: http.Server | null = null;
  const received: Received[] = [];
  const tempFiles: string[] = [];

  afterEach(async () => {
    for (const s of started.splice(0)) {
      await (s instanceof McpProxy ? s.stop() : s.stopAll());
    }
    if (upstream) {
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      upstream = null;
    }
    received.length = 0;
    for (const f of tempFiles.splice(0)) fs.rmSync(f, { force: true });
  });

  async function startUpstream(
    handler?: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => boolean | void,
  ): Promise<string> {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({
          method: req.method ?? "",
          url: req.url ?? "",
          protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
          authorization: req.headers.authorization as string | undefined,
          accept: req.headers.accept as string | undefined,
          contentType: req.headers["content-type"] as string | undefined,
          body,
        });
        if (handler && handler(req, res, body)) return;
        // Mirror Paseo: only the MCP endpoint exists, everything else is a 404.
        if (!req.url?.startsWith("/mcp/agents")) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
    });
    const port = await new Promise<number>((resolve) => {
      upstream!.listen(0, "127.0.0.1", () => {
        resolve((upstream!.address() as { port: number }).port);
      });
    });
    return `http://127.0.0.1:${port}`;
  }

  function track<T extends McpProxy | McpProxyPool>(value: T): T {
    started.push(value);
    return value;
  }

  it("starts and assigns a port", async () => {
    const proxy = track(new McpProxy("http://127.0.0.1:6767", { portFile: null }));
    const port = await proxy.start();
    expect(port).toBeGreaterThan(0);
    expect(proxy.getPort()).toBe(port);
  });

  it("downgrades an unsupported protocol version and preserves path, query and body", async () => {
    const origin = await startUpstream();
    const proxy = track(new McpProxy(origin, { portFile: null }));
    await proxy.start();

    const response = await fetch(proxy.rewriteUrl(`${origin}/mcp/agents?callerAgentId=abc123`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].protocolVersion).toBe("2025-11-25");
    expect(received[0].url).toBe("/mcp/agents?callerAgentId=abc123");
    expect(received[0].authorization).toBe("Bearer token");
    expect(received[0].body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("leaves a supported protocol version untouched", async () => {
    const origin = await startUpstream();
    const proxy = track(new McpProxy(origin, { portFile: null }));
    await proxy.start();

    await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
      headers: { "mcp-protocol-version": "2024-11-05" },
    });

    expect(received[0].protocolVersion).toBe("2024-11-05");
  });

  it("forwards unrelated paths to the upstream path rather than the MCP endpoint", async () => {
    // agy probes OAuth discovery before using an MCP server. Collapsing that onto the
    // MCP endpoint would answer 200 where the client must see a 404 to conclude that
    // the resource is not OAuth-protected.
    const origin = await startUpstream();
    const proxy = track(new McpProxy(origin, { portFile: null }));
    const port = await proxy.start();

    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp/agents`,
    );

    expect(response.status).toBe(404);
    expect(received[0].url).toBe("/.well-known/oauth-protected-resource/mcp/agents");
  });

  it("absorbs upstream 4xx on notification (no id) and responds with 202, logging method and status", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const origin = await startUpstream((_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Bad Request" },
            id: null,
          }),
        );
        return true;
      });
      const proxy = track(new McpProxy(origin, { portFile: null }));
      await proxy.start();

      const notificationPayload = {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
      };

      const response = await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notificationPayload),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0].body)).toEqual(notificationPayload);
      expect(spy).toHaveBeenCalledWith(
        '[paseo-antigravity][mcp-proxy] Absorbed upstream 400 on notification "notifications/cancelled"; replied 202 so go-sdk does not tear the session down',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("absorbs upstream 4xx on non-cancelled notification and logs investigation warning", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const origin = await startUpstream((_req, res) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Bad Request" },
            id: null,
          }),
        );
        return true;
      });
      const proxy = track(new McpProxy(origin, { portFile: null }));
      await proxy.start();

      const notificationPayload = {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      };

      const response = await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notificationPayload),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe("");
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0].body)).toEqual(notificationPayload);
      expect(spy).toHaveBeenCalledWith(
        '[paseo-antigravity][mcp-proxy] Absorbed upstream 400 on notification "notifications/initialized"; replied 202 so go-sdk does not tear the session down (indicates proxy normalization bug; investigate)',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("passes through upstream 4xx unchanged on call (with id)", async () => {
    const upstreamErrorBody = {
      jsonrpc: "2.0",
      id: 42,
      error: { code: -32602, message: "Invalid params" },
    };
    const origin = await startUpstream((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(upstreamErrorBody));
      return true;
    });
    const proxy = track(new McpProxy(origin, { portFile: null }));
    await proxy.start();

    const callPayload = {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "test_tool" },
    };

    const response = await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(callPayload),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(upstreamErrorBody);
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0].body)).toEqual(callPayload);
  });

  it("injects Accept header when missing or incomplete and sets Content-Type for request body", async () => {
    const origin = await startUpstream();
    const proxy = track(new McpProxy(origin, { portFile: null }));
    await proxy.start();

    // 1. Missing Accept header and missing Content-Type with body
    await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
      method: "POST",
      body: Buffer.from(JSON.stringify({ ping: 1 })),
    });
    expect(received[0].accept).toBe("application/json, text/event-stream");
    expect(received[0].contentType).toBe("application/json");

    // 2. Incomplete Accept header (only application/json)
    await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ping: 2 }),
    });
    expect(received[1].accept).toBe("application/json, text/event-stream");

    // 3. Incomplete Accept header (only text/event-stream)
    await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ping: 3 }),
    });
    expect(received[2].accept).toBe("application/json, text/event-stream");

    // 4. Complete Accept header containing both is preserved
    await fetch(proxy.rewriteUrl(`${origin}/mcp/agents`), {
      method: "POST",
      headers: {
        Accept: "text/event-stream, application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ping: 4 }),
    });
    expect(received[3].accept).toBe("text/event-stream, application/json");
  });

  it("formats proxy connection errors as JSON-RPC error body with application/json", async () => {
    const deadServer = http.createServer();
    await new Promise<void>((resolve) => deadServer.listen(0, "127.0.0.1", () => resolve()));
    const deadPort = (deadServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    const deadOrigin = `http://127.0.0.1:${deadPort}`;
    const proxy = track(new McpProxy(deadOrigin, { portFile: null }));
    await proxy.start();

    const response = await fetch(proxy.rewriteUrl(`${deadOrigin}/mcp/agents`));

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    const json = await response.json();
    expect(json).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: expect.stringContaining("MCP proxy error:"),
      },
      id: null,
    });
  });

  it("throws instead of returning an un-normalized URL when not running", async () => {
    const proxy = track(new McpProxy("http://127.0.0.1:6767", { portFile: null }));
    const original = "http://127.0.0.1:6767/mcp/agents?callerAgentId=a1";

    expect(() => proxy.rewriteUrl(original)).toThrow(/not running/);

    await proxy.start();
    expect(proxy.rewriteUrl(original)).not.toBe(original);

    await proxy.stop();
    expect(() => proxy.rewriteUrl(original)).toThrow(/not running/);
  });

  it("reuses the port remembered from a previous run", async () => {
    const portFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "paseo-agy-proxy-")),
      "ports.json",
    );
    tempFiles.push(portFile);

    const first = track(new McpProxy("http://127.0.0.1:6767", { portFile }));
    const port = await first.start();
    await first.stop();

    const second = track(new McpProxy("http://127.0.0.1:6767", { portFile }));
    expect(await second.start()).toBe(port);
  });
});

describe("McpProxyPool", () => {
  const pools: McpProxyPool[] = [];

  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.stopAll();
  });

  it("shares one proxy per upstream origin", async () => {
    const pool = new McpProxyPool({ portFile: null });
    pools.push(pool);

    const a = await pool.rewriteUrl("http://127.0.0.1:6767/mcp/agents?callerAgentId=a");
    const b = await pool.rewriteUrl("http://127.0.0.1:6767/mcp/agents?callerAgentId=b");
    const other = await pool.rewriteUrl("http://127.0.0.1:6868/mcp/agents");

    expect(new URL(a).port).toBe(new URL(b).port);
    expect(new URL(a).port).not.toBe(new URL(other).port);
    expect(new URL(a).pathname + new URL(a).search).toBe("/mcp/agents?callerAgentId=a");
    expect(new URL(b).pathname + new URL(b).search).toBe("/mcp/agents?callerAgentId=b");
  });
});
