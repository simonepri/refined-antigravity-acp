import { describe, expect, it } from "vitest";
import { questionOptionsFix, createQuestionOptionsFix } from "./index.js";
import type { AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";

describe("missing-question-fallback fix", () => {
  const dummyContext = createMockContext();

  it("passes non-question tool calls and unrelated messages through unmodified", () => {
    const commandMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_cmd1",
          name: "run_command",
          rawInput: { CommandLine: "ls -la" },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = questionOptionsFix.onInbound?.(commandMsg, dummyContext) as AcpStreamMessage[];
    expect(res).toEqual([commandMsg]);
  });

  it("unblocks pending request_permission question when user sends a chat prompt", async () => {
    const fix = createQuestionOptionsFix();
    const writtenToChild: AcpStreamMessage[] = [];
    const forwardedInbound: AcpStreamMessage[] = [];

    const mockContext = {
      ...createMockContext(),
      writeToChild: async (msg: AcpStreamMessage) => {
        writtenToChild.push(msg);
      },
      forwardInbound: (msg: AcpStreamMessage) => {
        forwardedInbound.push(msg);
      },
    };

    const questionPermissionMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: "perm_req_1",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: {
          toolCallId: "call_q_pending",
          title: "Select deployment option",
          status: "pending",
        },
        options: [
          { optionId: "1", name: "Option 1" },
          { optionId: "2", name: "Option 2" },
        ],
      },
    } as unknown as AcpStreamMessage;

    // Inbound: agy asks user a question via request_permission
    fix.onInbound?.(questionPermissionMsg, mockContext);

    // User ignores options and types their own answer / redirection in the chat
    const userPromptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 201,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [{ type: "text", text: "Neither option, do this instead" }],
      },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(userPromptMsg, mockContext);

    // Child must receive cancellation for the pending question to unblock upstream turn
    expect(writtenToChild).toHaveLength(1);
    expect(writtenToChild[0]).toEqual({
      jsonrpc: "2.0",
      id: "perm_req_1",
      result: { outcome: { outcome: "cancelled" } },
    });

    // Editor UI must receive completion for the question tool call to close spinner
    expect(forwardedInbound).toHaveLength(1);
    expect(forwardedInbound[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_q_pending",
          status: "completed",
        },
      },
    });
  });

  it("unblocks pending question when user sends session/cancel", async () => {
    const fix = createQuestionOptionsFix();
    const writtenToChild: AcpStreamMessage[] = [];

    const mockContext = {
      ...createMockContext(),
      writeToChild: async (msg: AcpStreamMessage) => {
        writtenToChild.push(msg);
      },
    };

    const questionPermissionMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: "perm_req_cancel",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: {
          toolCallId: "call_q_cancel",
          title: "Select branch strategy",
          status: "pending",
        },
        options: [{ optionId: "1", name: "Rebase" }],
      },
    } as unknown as AcpStreamMessage;

    fix.onInbound?.(questionPermissionMsg, mockContext);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 202,
      method: "session/cancel",
      params: { sessionId: "s1" },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(cancelMsg, mockContext);

    expect(writtenToChild).toHaveLength(1);
    expect(writtenToChild[0]).toEqual({
      jsonrpc: "2.0",
      id: "perm_req_cancel",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  it("clears pending question when user selects an option directly", async () => {
    const fix = createQuestionOptionsFix();
    const writtenToChild: AcpStreamMessage[] = [];

    const mockContext = {
      ...createMockContext(),
      writeToChild: async (msg: AcpStreamMessage) => {
        writtenToChild.push(msg);
      },
    };

    const questionPermissionMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 999,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: {
          toolCallId: "call_q_direct",
          title: "Select an option",
          status: "pending",
        },
        options: [{ optionId: "opt_1", name: "First" }],
      },
    } as unknown as AcpStreamMessage;

    fix.onInbound?.(questionPermissionMsg, mockContext);

    // User selects option directly via permission response
    const permissionResponseMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 999,
      result: { outcome: { outcome: "selected", optionId: "opt_1" } },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(permissionResponseMsg, mockContext);

    // Subsequent prompt does NOT synthesize an extra cancel since question was already answered
    const nextPromptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1000,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [{ type: "text", text: "Proceed" }],
      },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(nextPromptMsg, mockContext);
    expect(writtenToChild).toHaveLength(0);
  });
});
