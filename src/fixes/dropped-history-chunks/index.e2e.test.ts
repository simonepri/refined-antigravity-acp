import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { AcpStreamMessage } from "../../core/types.js";
import {
  encodeLengthDelimited,
  spawnRawAgy,
  spawnWrapped,
  type AcpTestClient,
} from "../../test-utils/index.js";

interface UpdateContent {
  text?: string;
  [key: string]: unknown;
}

interface MessageChunk {
  delta?: string;
  [key: string]: unknown;
}

interface SessionUpdatePayload {
  content?: UpdateContent;
  agent_thought_chunk?: MessageChunk;
  agent_message_chunk?: MessageChunk;
  thought?: unknown[];
  message?: unknown[];
  [key: string]: unknown;
}

interface SessionUpdateMsg {
  method?: string;
  params?: {
    update?: SessionUpdatePayload;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

describe("dropped-history-chunks e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

  it("problem: raw agy session/load drops thought & message chunks during replay", async () => {
    const setupClient = await spawnWrapped();
    activeClients.push(setupClient);
    await setupClient.initialize();
    const { sessionId } = await setupClient.newSession();
    await setupClient.close();

    const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
    const dbPath = path.join(geminiHome, "antigravity-acp", "conversations", sessionId + ".db");
    const d = new DatabaseSync(dbPath);

    const thoughtContent = encodeLengthDelimited(3, Buffer.from("Deep e2e analysis", "utf-8"));
    const msgContent = encodeLengthDelimited(1, Buffer.from("Here is the answer", "utf-8"));
    const agentPayload = encodeLengthDelimited(20, Buffer.concat([thoughtContent, msgContent]));

    d.prepare("INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 4, 15, ?);").run(
      agentPayload,
    );
    d.close();

    const rawClient = await spawnRawAgy();
    activeClients.push(rawClient);
    await rawClient.initialize();

    await rawClient.send({
      jsonrpc: "2.0",
      id: 701,
      method: "session/load",
      params: { sessionId, cwd: process.cwd(), mcpServers: [] },
    } as unknown as AcpStreamMessage);

    await rawClient.waitForResponse(701, 45000);
    const rawUpdates = (rawClient.allMessages() as unknown as SessionUpdateMsg[]).filter(
      (m) => m.method === "session/update",
    );
    const rawThoughts = rawUpdates.flatMap(
      (u) => u.params?.update?.agent_thought_chunk ?? u.params?.update?.thought ?? [],
    );
    const rawMessages = rawUpdates.flatMap(
      (u) => u.params?.update?.agent_message_chunk ?? u.params?.update?.message ?? [],
    );
    expect(rawThoughts).toHaveLength(0);
    expect(rawMessages).toHaveLength(0);
    await rawClient.close();
  });

  it("solution: wrapped connector restores complete thought and message history on session reload", async () => {
    const setupClient = await spawnWrapped();
    activeClients.push(setupClient);
    await setupClient.initialize();
    const { sessionId } = await setupClient.newSession();
    await setupClient.close();

    const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
    const dbPath = path.join(geminiHome, "antigravity-acp", "conversations", sessionId + ".db");
    const d = new DatabaseSync(dbPath);

    const thoughtContent = encodeLengthDelimited(3, Buffer.from("Deep e2e analysis", "utf-8"));
    const msgContent = encodeLengthDelimited(1, Buffer.from("Here is the answer", "utf-8"));
    const agentPayload = encodeLengthDelimited(20, Buffer.concat([thoughtContent, msgContent]));

    d.prepare("INSERT INTO steps (idx, status, step_type, step_payload) VALUES (1, 4, 15, ?);").run(
      agentPayload,
    );
    d.close();

    const wrappedClient = await spawnWrapped();
    activeClients.push(wrappedClient);
    await wrappedClient.initialize();

    await wrappedClient.send({
      jsonrpc: "2.0",
      id: 702,
      method: "session/load",
      params: { sessionId, cwd: process.cwd(), mcpServers: [] },
    } as unknown as AcpStreamMessage);

    await wrappedClient.waitForResponse(702, 45000);

    const wrappedUpdates = (wrappedClient.allMessages() as unknown as SessionUpdateMsg[]).filter(
      (m) => m.method === "session/update",
    );
    const allDelivered = wrappedUpdates
      .map(
        (u) =>
          u.params?.update?.content?.text ??
          u.params?.update?.agent_thought_chunk?.delta ??
          u.params?.update?.agent_message_chunk?.delta ??
          "",
      )
      .join("");

    expect(allDelivered).toContain("Deep e2e analysis");
    expect(allDelivered).toContain("Here is the answer");
    await wrappedClient.close();
  });
});
