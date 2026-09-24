import { describe, expect, it } from "vitest";
import { questionOptionsFix, ensureOtherOption, QUESTION_OPTIONS_INSTRUCTIONS } from "./index.js";
import type { AcpStreamMessage } from "../../core/types.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";

interface QuestionUpdatePayload {
  update?: {
    rawInput?: {
      questions?: Array<{ options?: string[] }>;
    };
  };
}

describe("missing-question-fallback fix", () => {
  const dummyContext = createMockContext();

  it("provides system instructions requiring an Other option in multiple choice questions", () => {
    const instructions = questionOptionsFix.getSystemInstructions?.();
    expect(instructions).toEqual(QUESTION_OPTIONS_INSTRUCTIONS);
    expect(instructions?.[0]).toContain("'Other' option");
  });

  it("appends an Other option to questions lacking custom write-in choices in ask_question tool calls", () => {
    const toolCallMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_q1",
          name: "ask_question",
          rawInput: {
            questions: [
              {
                question: "Which database would you prefer to use?",
                options: ["PostgreSQL", "SQLite", "MongoDB"],
                is_multi_select: false,
              },
            ],
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = questionOptionsFix.onInbound?.(toolCallMsg, dummyContext) as AcpStreamMessage[];
    expect(res).toHaveLength(1);

    const firstMsg = res[0] as unknown as { params?: QuestionUpdatePayload };
    const questions = firstMsg.params?.update?.rawInput?.questions;
    expect(questions?.[0]?.options).toEqual(["PostgreSQL", "SQLite", "MongoDB", "Other"]);
  });

  it("preserves existing options when an Other or None option is already present", () => {
    const toolCallMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_q2",
          name: "ask_question",
          rawInput: {
            questions: [
              {
                question: "Do you want to proceed?",
                options: ["Yes", "No", "None of the above"],
              },
            ],
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = questionOptionsFix.onInbound?.(toolCallMsg, dummyContext) as AcpStreamMessage[];
    const firstMsg = res[0] as unknown as { params?: QuestionUpdatePayload };
    const questions = firstMsg.params?.update?.rawInput?.questions;
    expect(questions?.[0]?.options).toEqual(["Yes", "No", "None of the above"]);
  });

  it("handles serialized JSON string arguments in tool call updates", () => {
    const rawInputJson = JSON.stringify({
      questions: [
        {
          question: "Select deployment strategy",
          options: ["Blue-Green", "Canary", "Rolling"],
        },
      ],
    });

    const toolCallMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_q3",
          name: "ask_question",
          rawInput: rawInputJson,
        },
      },
    } as unknown as AcpStreamMessage;

    const res = questionOptionsFix.onInbound?.(toolCallMsg, dummyContext) as AcpStreamMessage[];
    const firstMsg = res[0] as unknown as { params?: { update?: { rawInput?: string } } };
    const rawString = firstMsg.params?.update?.rawInput;
    expect(rawString).toBeDefined();

    const parsed = JSON.parse(rawString!) as { questions?: Array<{ options?: string[] }> };
    expect(parsed.questions?.[0]?.options).toEqual(["Blue-Green", "Canary", "Rolling", "Other"]);
  });

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
});

describe("ensureOtherOption", () => {
  it("returns modified false when raw input is not an object or questions is not an array", () => {
    expect(ensureOtherOption(null)).toEqual({ modified: false, result: null });
    expect(ensureOtherOption(undefined)).toEqual({ modified: false, result: undefined });
    expect(ensureOtherOption("invalid json string")).toEqual({
      modified: false,
      result: "invalid json string",
    });
    expect(ensureOtherOption({})).toEqual({ modified: false, result: {} });
  });
});
