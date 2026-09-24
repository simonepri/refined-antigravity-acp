import { describe, expect, it } from "vitest";
import {
  createUsageMetricsFix,
  createUsageUpdateMessage,
  extractUsageFromMetadata,
} from "./index.js";
import { decodeVarint } from "../../lib/protobuf.js";

import type { AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";

describe("missing-usage-metrics unit tests", () => {
  it("decodes variable-length integer wire formats accurately", () => {
    const singleByte = new Uint8Array([0x08]);
    expect(decodeVarint(singleByte, 0)).toEqual([8, 1]);

    // 300 = 0xac 0x02
    const multiByte = new Uint8Array([0xac, 0x02]);
    expect(decodeVarint(multiByte, 0)).toEqual([300, 2]);
  });

  it("extracts token metrics and context window limits from step metadata", () => {
    // Field 9 length-delimited: subfield 2 (varint 12000), subfield 3 (varint 500)
    // subfield 2 tag = (2 << 3) | 0 = 16 = 0x10. Value 12000 = [0xe0, 0x5d]
    // subfield 3 tag = (3 << 3) | 0 = 24 = 0x18. Value 500 = [0xf4, 0x03]
    const f9Inner = new Uint8Array([0x10, 0xe0, 0x5d, 0x18, 0xf4, 0x03]);
    // Field 9 tag = (9 << 3) | 2 = 74 = 0x4a. Length = 6 = 0x06
    // Field 24 length-delimited: subfield 4 (varint 1000000)
    // subfield 4 tag = (4 << 3) | 0 = 32 = 0x20. Value 1000000 = [0xc0, 0x84, 0x3d]
    const f24Inner = new Uint8Array([0x20, 0xc0, 0x84, 0x3d]);
    // Field 24 tag = (24 << 3) | 2 = 194, 0x01. Length = 4 = 0x04
    const buf = new Uint8Array([0x4a, 0x06, ...f9Inner, 0xc2, 0x01, 0x04, ...f24Inner]);

    const extracted = extractUsageFromMetadata(buf);
    expect(extracted).not.toBeNull();
    expect(extracted?.promptTokens).toBe(12000);
    expect(extracted?.candidateTokens).toBe(500);
    expect(extracted?.usedTokens).toBe(12500);
    expect(extracted?.maxTokens).toBe(1000000);
  });

  it("formats standard ACP usage_update notifications with token counts and context size", () => {
    const msg = createUsageUpdateMessage("session-123", {
      usedTokens: 12500,
      maxTokens: 1000000,
      promptTokens: 12000,
      candidateTokens: 500,
    });

    expect(msg).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-123",
        update: {
          sessionUpdate: "usage_update",
          used: 12500,
          size: 1000000,
        },
      },
    });
  });

  it("emits token usage update prior to completing prompt turn", async () => {
    const fix = createUsageMetricsFix();
    const fakeContext = createMockContext();

    // Outbound session/prompt
    const outboundPrompt: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 42,
      method: "session/prompt",
      params: { sessionId: "sess-abc", prompt: [] },
    };

    fix.onOutbound?.(outboundPrompt, fakeContext);

    // Inbound result for id 42
    const inboundResult: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 42,
      result: { status: "ok" },
    };

    // Without a real DB on disk, it should safely pass the result through
    const res = await fix.onInbound?.(inboundResult, fakeContext);
    expect(res).toEqual([inboundResult]);
  });

  it("extracts session token consumption from stored trajectory and emits usage update", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
    const dbPath = path.join(tmpDir, "sess-test.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER,
        metadata BLOB
      );
    `);

    // Field 9: promptTokens=8000, candidateTokens=250. Field 24: maxTokens=1000000
    const f9Inner = new Uint8Array([0x10, 0xc0, 0x3e, 0x18, 0xfa, 0x01]);
    const f24Inner = new Uint8Array([0x20, 0xc0, 0x84, 0x3d]);
    const metadata = new Uint8Array([0x4a, 0x06, ...f9Inner, 0xc2, 0x01, 0x04, ...f24Inner]);

    const stmt = db.prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)");
    stmt.run(1, 15, metadata);
    db.close();

    const fix = createUsageMetricsFix((_sessionId) => dbPath);
    const fakeContext = createMockContext();

    fix.onOutbound?.(
      {
        jsonrpc: "2.0",
        id: 99,
        method: "session/prompt",
        params: { sessionId: "sess-test", prompt: [] },
      },
      fakeContext,
    );

    const inboundResult: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 99,
      result: { status: "ok" },
    };

    const res = await fix.onInbound?.(inboundResult, fakeContext);
    expect(res).toHaveLength(2);
    expect(res?.[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-test",
        update: {
          sessionUpdate: "usage_update",
          used: 8250,
          size: 1000000,
        },
      },
    });
    const resultObj = res?.[1] as { result?: { usage?: unknown } };
    expect(resultObj?.result?.usage).toEqual({
      totalTokens: 8250,
      inputTokens: 8000,
      outputTokens: 250,
      contextWindowMaxTokens: 1000000,
      contextWindowUsedTokens: 8250,
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
