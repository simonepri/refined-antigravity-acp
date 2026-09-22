import { describe, expect, it } from "vitest";
import { extractUserMessage, readConversationHistory } from "./history.js";
import { formatSystemContext } from "./sanitize.js";
import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("readConversationHistory", () => {
  it("returns empty array for non-existent session", () => {
    const history = readConversationHistory("non-existent-session-id");
    expect(history).toEqual([]);
  });

  it("can read existing session if available", () => {
    const history = readConversationHistory("bb2bf99a-ec9e-4d4a-9924-6aec7b7291cf");
    if (history.length > 0) {
      const userMsg = history.find((entry) => entry.item.type === "user_message");
      if (userMsg && userMsg.item.type === "user_message") {
        expect(userMsg.item.text).toBeTruthy();
      }
    }
  });
  it("sanitizes assistant messages and does not leak task_notification", () => {
    const history = readConversationHistory("528dc461-72a0-4c97-a5d5-d24b66eb6d6c");
    for (const entry of history) {
      if (entry.item.type === "assistant_message") {
        expect(entry.item.text).not.toContain("<task_notification>");
        expect(entry.item.text).not.toContain("</task_notification>");
      }
    }
  });
});

function encodeVarint(val: number): Buffer {
  const bytes: number[] = [];
  let v = val;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNum: number, data: Uint8Array): Buffer {
  const tag = (fieldNum << 3) | 2;
  return Buffer.concat([encodeVarint(tag), encodeVarint(data.length), Buffer.from(data)]);
}

function makeUserPayload(text: string): Uint8Array {
  const f2 = encodeLengthDelimited(2, Buffer.from(text, "utf-8"));
  const f19 = encodeLengthDelimited(19, f2);
  return new Uint8Array(f19);
}

describe("user message replay system context stripping", () => {
  it("extractUserMessage strips injected system context and formatting guidance", () => {
    const raw = `${formatSystemContext("Act as an SRE.")}\n\nInspect deployment health`;
    const payload = makeUserPayload(raw);
    const item = extractUserMessage(payload, 1);
    expect(item).not.toBeNull();
    expect(item?.type).toBe("user_message");
    expect((item as { text: string }).text).toBe("Inspect deployment health");
    expect((item as { text: string }).text).not.toContain("[System Context]");
    expect((item as { text: string }).text).not.toContain("[Formatting Guidance]");
  });

  it("extractUserMessage strips formatting guidance when no system prompt was present", () => {
    const raw = `${formatSystemContext(undefined)}\n\nShow me the pods`;
    const payload = makeUserPayload(raw);
    const item = extractUserMessage(payload, 2);
    expect(item).not.toBeNull();
    expect((item as { text: string }).text).toBe("Show me the pods");
    expect((item as { text: string }).text).not.toContain("[Formatting Guidance]");
  });

  it("readConversationHistory strips injected system context on SQLite replay", () => {
    const tempDbPath = join(
      tmpdir(),
      `test-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      const db = new DatabaseSync(tempDbPath);
      db.exec(
        "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);",
      );
      const stmt = db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)");

      const raw = `${formatSystemContext("Act as an SRE.")}\n\nInspect deployment health`;
      stmt.run(1, 14, makeUserPayload(raw));
      db.close();

      const events = readConversationHistory("test-session", tempDbPath);
      expect(events).toHaveLength(1);
      expect(events[0].item.type).toBe("user_message");
      expect((events[0].item as { text: string }).text).toBe("Inspect deployment health");
      expect((events[0].item as { text: string }).text).not.toContain("[System Context]");
      expect((events[0].item as { text: string }).text).not.toContain("[Formatting Guidance]");
    } finally {
      try {
        unlinkSync(tempDbPath);
      } catch {
        // ignore
      }
    }
  });

  it("readConversationHistory strips both mid-turn steering prefix and injected system context", () => {
    const tempDbPath = join(
      tmpdir(),
      `test-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    try {
      const db = new DatabaseSync(tempDbPath);
      db.exec(
        "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);",
      );
      const stmt = db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)");

      const raw = `[Mid-turn update]: ${formatSystemContext("Act as an SRE.")}\n\nUpdate: stop and check logs`;
      stmt.run(1, 14, makeUserPayload(raw));
      db.close();

      const events = readConversationHistory("test-session", tempDbPath);
      expect(events).toHaveLength(1);
      expect(events[0].item.type).toBe("user_message");
      expect((events[0].item as { text: string }).text).toBe("Update: stop and check logs");
      expect((events[0].item as { text: string }).text).not.toContain("[Mid-turn update]");
      expect((events[0].item as { text: string }).text).not.toContain("[System Context]");
    } finally {
      try {
        unlinkSync(tempDbPath);
      } catch {
        // ignore
      }
    }
  });
});
