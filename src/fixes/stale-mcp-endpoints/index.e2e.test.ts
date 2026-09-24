import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpProxyServer } from "./index.js";

describe("stale-mcp-endpoints e2e", () => {
  let upstream: http.Server | null = null;
  let proxy: McpProxyServer | null = null;

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
    if (upstream) {
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
      upstream = null;
    }
  });

  it("solution: proxy intercepts requests, downgrades unsupported protocol version, and preserves path", async () => {
    let receivedVersion: string | undefined;
    let receivedUrl: string | undefined;

    upstream = http.createServer((req, res) => {
      receivedVersion = req.headers["mcp-protocol-version"] as string | undefined;
      receivedUrl = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    const upstreamPort = await new Promise<number>((resolve) => {
      upstream!.listen(0, "127.0.0.1", () => {
        resolve((upstream!.address() as { port: number }).port);
      });
    });

    const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
    proxy = new McpProxyServer(upstreamOrigin, { portFile: null });
    await proxy.start();

    const targetUrl = proxy.rewriteUrl(`${upstreamOrigin}/mcp/agents?callerAgentId=test123`);
    expect(targetUrl).not.toBe(`${upstreamOrigin}/mcp/agents?callerAgentId=test123`);

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({ ping: true }),
    });

    expect(response.status).toBe(200);
    expect(receivedVersion).toBe("2025-11-25");
    expect(receivedUrl).toBe("/mcp/agents?callerAgentId=test123");
  });
});
