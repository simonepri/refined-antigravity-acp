import { afterEach, describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "../../core/types.js";
import { spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";

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
  agent_message_chunk?: MessageChunk;
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

describe("malformed-stream-syntax e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

  it("solution: strips internal harness tags across streaming chunks and turn ends", async () => {
    const client = await spawnWrapped();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession();

    await client.send({
      jsonrpc: "2.0",
      id: 7771,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Explain briefly what 2 + 2 is in one short sentence without markdown.",
          },
        ],
      },
    } as unknown as AcpStreamMessage);

    await client.waitForResponse(7771, 45000);

    const updates = (client.allMessages() as unknown as SessionUpdateMsg[]).filter(
      (m) => m.method === "session/update",
    );
    const assistantText = updates
      .map(
        (u) =>
          u.params?.update?.content?.text ?? u.params?.update?.agent_message_chunk?.delta ?? "",
      )
      .join("");

    expect(assistantText).not.toMatch(
      /<\/?(?:system_message|system_notification|system_instruction|task_notification|task_output|scratchpad|context|messaging)>/i,
    );
    expect(assistantText).not.toContain("The following is a <SYSTEM_MESSAGE>");
    expect(assistantText.trim().length).toBeGreaterThan(0);
    await client.close();
  });
});
