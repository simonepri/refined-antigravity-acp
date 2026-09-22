import { describe, expect, it, vi } from "vitest";

vi.mock("./history.js", () => ({
  readConversationHistory: vi.fn((sessionId: string) => {
    if (sessionId === "bb2bf99a-ec9e-4d4a-9924-6aec7b7291cf") {
      return [
        {
          type: "timeline.item",
          sessionId: "session-replay-1",
          item: {
            id: "item-1",
            type: "user_message",
            text: "test message",
          },
        },
      ];
    }
    return [];
  }),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SteeringConnection } from "./steering.js";
import type {
  ProviderConnectRequest,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";

describe("SteeringConnection", () => {
  function createMockBaseConnection(): {
    connection: ProviderConnection;
    emitBaseEvent: (event: ProviderEvent) => void;
    sentInputs: ProviderInput[];
    closed: boolean;
  } {
    let eventListener: ((event: ProviderEvent) => void) | null = null;
    const sentInputs: ProviderInput[] = [];
    let closed = false;

    const connection: ProviderConnection = {
      version: 1,
      capabilities: ["prompt.message", "session.configure"],
      async send(input: ProviderInput): Promise<void> {
        sentInputs.push(input);
      },
      onEvent(listener: (event: ProviderEvent) => void): () => void {
        eventListener = listener;
        return () => {
          if (eventListener === listener) {
            eventListener = null;
          }
        };
      },
      async close(): Promise<void> {
        closed = true;
      },
    };

    return {
      connection,
      emitBaseEvent: (event: ProviderEvent) => {
        eventListener?.(event);
      },
      sentInputs,
      get closed() {
        return closed;
      },
    };
  }

  it("advertises prompt.steer capability when requested", () => {
    const { connection } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    };

    const wrapped = new SteeringConnection(connection, request);
    expect(wrapped.capabilities).toContain("prompt.steer");
  });

  it("does not advertise prompt.steer capability when not requested", () => {
    const { connection } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message"],
    };

    const wrapped = new SteeringConnection(connection, request);
    expect(wrapped.capabilities).not.toContain("prompt.steer");
  });

  it("augments session.opened event with prompt.steer capability when requested", () => {
    const { connection, emitBaseEvent } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    };

    const wrapped = new SteeringConnection(connection, request);
    const receivedEvents: ProviderEvent[] = [];
    wrapped.onEvent((event) => receivedEvents.push(event));

    emitBaseEvent({
      type: "session.opened",
      sessionId: "session-1",
      capabilities: ["prompt.message"],
      restoration: "core",
      cwd: "/test",
    });

    const opened = receivedEvents.find((e) => e.type === "session.opened");
    expect(opened).toBeDefined();
    if (opened && opened.type === "session.opened") {
      expect(opened.capabilities).toContain("prompt.steer");
    }
  });

  it("handles mid-turn steer prompt by emitting completed session.prompt_result to trigger Paseo replacement", async () => {
    const { connection, emitBaseEvent, sentInputs } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    };

    const wrapped = new SteeringConnection(connection, request);
    const receivedEvents: ProviderEvent[] = [];
    wrapped.onEvent((event) => receivedEvents.push(event));

    emitBaseEvent({
      type: "session.turn",
      sessionId: "session-1",
      turnId: "turn-42",
      state: "started",
    });

    await wrapped.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "msg-steer-1",
        delivery: "steer",
        input: {
          type: "message",
          content: [{ type: "text", text: "Focus on unit tests" }],
        },
      },
    });

    expect(sentInputs).toHaveLength(0);
    const promptResults = receivedEvents.filter((e) => e.type === "session.prompt_result");
    expect(promptResults).toHaveLength(1);
    expect(promptResults[0]).toEqual({
      type: "session.prompt_result",
      sessionId: "session-1",
      clientMessageId: "msg-steer-1",
      result: {
        type: "completed",
      },
    });

    // Paseo follows up by cancelling the turn and re-dispatching the text. That
    // replacement must reach the agent marked as a mid-turn interruption.
    await wrapped.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "msg-replaced-1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "Focus on unit tests" }],
        },
      },
    });

    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]).toEqual({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "msg-replaced-1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "[Mid-turn update]: Focus on unit tests" }],
        },
      },
    });
  });

  it("does not mark an ordinary prompt that did not follow a steer", async () => {
    const { connection, sentInputs } = createMockBaseConnection();
    const wrapped = new SteeringConnection(connection, {
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    });

    await wrapped.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "msg-plain-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Focus on unit tests" }] },
      },
    });

    const sent = sentInputs[0] as { prompt: { input: { content: Array<{ text: string }> } } };
    expect(sent.prompt.input.content[0].text).toBe("Focus on unit tests");
  });

  it("expands slash skills in prompt input", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "steering-skills-test-"));
    const skillDir = path.join(tmpDir, ".agents", "skills", "test-steer");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: test-steer
description: Steer test
---
Running with $ARGUMENTS`,
    );

    const { connection, emitBaseEvent, sentInputs } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message"],
    };

    const wrapped = new SteeringConnection(connection, request);

    emitBaseEvent({
      type: "session.opened",
      sessionId: "sess_steer_1",
      capabilities: ["prompt.message"],
      restoration: "core",
      cwd: tmpDir,
    });

    await wrapped.send({
      type: "session.prompt",
      sessionId: "sess_steer_1",
      prompt: {
        clientMessageId: "msg_prompt_1",
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: "/test-steer arg1" }],
        },
      },
    });

    expect(sentInputs).toHaveLength(1);
    const sent = sentInputs[0] as {
      prompt: { input: { content: Array<{ type: string; text: string }> } };
    };
    expect(sent.prompt.input.content[0].text).toContain("[Skill: test-steer]");
    expect(sent.prompt.input.content[0].text).toContain("Running with arg1");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards non-steer inputs directly to the underlying connection", async () => {
    const { connection, sentInputs } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message", "prompt.steer"],
    };

    const wrapped = new SteeringConnection(connection, request);

    const normalInput: ProviderInput = {
      type: "catalog",
      requestId: "req-catalog-1",
    };

    await wrapped.send(normalInput);
    expect(sentInputs).toEqual([normalInput]);
  });

  it("records replay request on session.open and replays history on session.opened", async () => {
    const { connection, emitBaseEvent } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message"],
    };

    const wrapped = new SteeringConnection(connection, request);
    const receivedEvents: ProviderEvent[] = [];
    wrapped.onEvent((event) => receivedEvents.push(event));

    await wrapped.send({
      type: "session.open",
      requestId: "req-1",
      sessionId: "session-replay-1",
      history: "replay",
      config: {
        cwd: "/test",
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
    });

    emitBaseEvent({
      type: "session.opened",
      sessionId: "session-replay-1",
      capabilities: ["prompt.message"],
      restoration: "core",
      cwd: "/test",
      persistence: {
        version: 1,
        data: {
          sessionId: "bb2bf99a-ec9e-4d4a-9924-6aec7b7291cf",
        },
      },
    });

    const timelineItems = receivedEvents.filter((e) => e.type === "timeline.item");
    expect(timelineItems.length).toBeGreaterThan(0);
    expect(timelineItems[0].item.type).toBe("user_message");
  });

  it("forwards close call to underlying connection", async () => {
    const mock = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message"],
    };

    const wrapped = new SteeringConnection(mock.connection, request);
    await wrapped.close();
    expect(mock.closed).toBe(true);
  });
  it("augments session.commands from base connection with discovered workspace skills", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "steering-commands-test-"));
    const skillDir = path.join(tmpDir, ".agents", "skills", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---
name: test-skill
description: Workspace test skill
---
Skill instructions`,
    );

    const { connection, emitBaseEvent } = createMockBaseConnection();
    const request: ProviderConnectRequest = {
      versions: [1],
      capabilities: ["prompt.message"],
    };

    const wrapped = new SteeringConnection(connection, request);
    const receivedEvents: ProviderEvent[] = [];
    wrapped.onEvent((event) => receivedEvents.push(event));

    emitBaseEvent({
      type: "session.opened",
      sessionId: "sess-commands-1",
      capabilities: ["prompt.message"],
      restoration: "core",
      cwd: tmpDir,
    });

    emitBaseEvent({
      type: "session.commands",
      sessionId: "sess-commands-1",
      commands: [
        { name: "plan", description: "Plan mode" },
        { name: "logout", description: "Log out" },
      ],
    });

    const commandEvents = receivedEvents.filter(
      (e): e is Extract<ProviderEvent, { type: "session.commands" }> =>
        e.type === "session.commands",
    );
    expect(commandEvents).toHaveLength(2);

    // Initial commands emitted on session.opened include the workspace skill
    expect(commandEvents[0].commands).toContainEqual({
      name: "test-skill",
      description: "Workspace test skill",
    });

    // Subsequent session.commands from base connection is augmented with the workspace skill
    const augmentedCommands = commandEvents[1].commands;
    expect(augmentedCommands).toContainEqual({ name: "plan", description: "Plan mode" });
    expect(augmentedCommands).toContainEqual({ name: "logout", description: "Log out" });
    expect(augmentedCommands).toContainEqual({
      name: "test-skill",
      description: "Workspace test skill",
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
