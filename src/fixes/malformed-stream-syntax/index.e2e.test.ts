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

  it("problem: raw agy stream leaks background task notification and raw stdout into assistant output", () => {
    const rawOutput = `Got a message from a background task:
[b89e7e70-fe68-4203-95de-2308f73f7b62/task-1] Output:
[INFO] Scanning for projects...
Task task-1 completed successfully with exit code 0.
Everything is built and ready!`;

    // Without sanitization, raw background task banner and logs are present
    expect(rawOutput).toContain("Got a message from a background task:");
    expect(rawOutput).toContain("[INFO] Scanning for projects...");
  });

  it("solution: wrapped connector suppresses background task notification and logs from assistant stream", async () => {
    const client = await spawnWrapped();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession();

    // Prompt the agent to confirm sanitized streaming in live roundtrip
    await client.send({
      jsonrpc: "2.0",
      id: 7772,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Reply with 'Build succeeded.' without any quotes or extra words.",
          },
        ],
      },
    } as unknown as AcpStreamMessage);

    await client.waitForResponse(7772, 45000);

    const streamUpdates = (client.allMessages() as unknown as SessionUpdateMsg[]).filter(
      (m) => m.method === "session/update",
    );
    const assistantText = streamUpdates
      .map(
        (u) =>
          u.params?.update?.content?.text ?? u.params?.update?.agent_message_chunk?.delta ?? "",
      )
      .join("");

    expect(assistantText).not.toContain("Got a message from a background task:");
    expect(assistantText).not.toContain("Got a message from a subagent:");
    expect(assistantText).not.toMatch(/\[(?:task|subagent)-\S+\] Output:/i);
    expect(assistantText.trim().length).toBeGreaterThan(0);
  });
});
