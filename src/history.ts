import { sanitizeAssistantText, stripSteeringPrefix, stripSystemContext } from "./sanitize.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

export interface ReplayedTimelineEvent {
  readonly item: ProviderTimelineItem;
  readonly timestamp?: string;
}

interface StepRow {
  readonly idx: number;
  readonly step_type: number;
  readonly step_payload: Uint8Array | null;
}

function decodeVarint(buffer: Uint8Array, start: number): [number, number] {
  let res = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.length) {
    const b = buffer[offset++];
    res |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [res, offset];
}

function getField(buffer: Uint8Array, targetField: number): Uint8Array | null {
  let offset = 0;
  while (offset < buffer.length) {
    let tag = 0;
    let nextOffset = 0;
    try {
      [tag, nextOffset] = decodeVarint(buffer, offset);
    } catch {
      break;
    }
    offset = nextOffset;
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (wireType === 2) {
      const [len, afterLen] = decodeVarint(buffer, offset);
      offset = afterLen;
      const slice = buffer.subarray(offset, offset + len);
      offset += len;
      if (fieldNum === targetField) return slice;
    } else if (wireType === 0) {
      const [, afterVal] = decodeVarint(buffer, offset);
      offset = afterVal;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return null;
}

function extractTimestamp(payload: Uint8Array): string | undefined {
  const f5 = getField(payload, 5);
  if (!f5) return undefined;
  const f1 = getField(f5, 1);
  if (!f1) return undefined;
  let offset = 0;
  let seconds = 0;
  let nanos = 0;
  while (offset < f1.length) {
    const [tag, nextOffset] = decodeVarint(f1, offset);
    offset = nextOffset;
    const fieldNum = tag >> 3;
    const [val, afterVal] = decodeVarint(f1, offset);
    offset = afterVal;
    if (fieldNum === 1) seconds = val;
    else if (fieldNum === 2) nanos = val;
  }
  if (!seconds) return undefined;
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

export function extractUserMessage(payload: Uint8Array, idx: number): ProviderTimelineItem | null {
  const f19 = getField(payload, 19);
  if (!f19) return null;
  const textBytes = getField(f19, 2);
  if (!textBytes || textBytes.length === 0) return null;
  // Steered turns are persisted with the mid-turn marker baked into the user message,
  // so replay has to strip it back out before the text reaches the Paseo timeline.
  const rawText = Buffer.from(textBytes).toString("utf-8");
  const text = stripSystemContext(stripSteeringPrefix(rawText)).trim();
  if (!text) return null;
  return { id: `hist-user-${idx}`, type: "user_message", text };
}

function extractAssistantMessage(payload: Uint8Array, idx: number): ProviderTimelineItem | null {
  const f20 = getField(payload, 20);
  if (!f20) return null;
  const textBytes = getField(f20, 1);
  if (!textBytes || textBytes.length === 0) return null;
  const rawText = Buffer.from(textBytes).toString("utf-8");
  const text = sanitizeAssistantText(rawText);
  if (!text) return null;
  return { id: `hist-asst-${idx}`, type: "assistant_message", text };
}

function extractTimelineItem(
  stepType: number,
  payload: Uint8Array,
  idx: number,
): ProviderTimelineItem | null {
  if (stepType === 14) return extractUserMessage(payload, idx);
  if (stepType === 15) return extractAssistantMessage(payload, idx);
  return null;
}

/**
 * Reads and replays historic conversation events from Antigravity SQLite DB.
 * Database is located at ~/.gemini/antigravity-acp/conversations/<sessionId>.db.
 */
export function readConversationHistory(
  sessionId: string,
  customDbPath?: string,
): ReplayedTimelineEvent[] {
  const dbPath =
    customDbPath ??
    join(homedir(), ".gemini", "antigravity-acp", "conversations", `${sessionId}.db`);
  if (!existsSync(dbPath)) return [];

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(
      "SELECT idx, step_type, step_payload FROM steps WHERE step_type IN (14, 15) ORDER BY idx ASC;",
    );
    const rows = stmt.all() as unknown as StepRow[];
    const events: ReplayedTimelineEvent[] = [];

    for (const row of rows) {
      if (!row.step_payload) continue;
      const payload = new Uint8Array(row.step_payload);
      const item = extractTimelineItem(row.step_type, payload, row.idx);
      if (!item) continue;
      const timestamp = extractTimestamp(payload);
      events.push({ item, timestamp });
    }
    return events;
  } catch (err) {
    console.error(`[paseo-antigravity] Failed to read conversation history for ${sessionId}:`, err);
    return [];
  } finally {
    db?.close();
  }
}
