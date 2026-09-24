import { describe, expect, it } from "vitest";
import type * as AcpSdk from "@agentclientprotocol/sdk";
import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_METHODS } from "@agentclientprotocol/sdk";
import { ACP_METHODS, SESSION_UPDATES, STOP_REASONS } from "./types.js";
import type { SessionPlanEntry, SessionUpdateParams, SessionUpdatePayload } from "./types.js";
import type { AvailableCommand } from "../fixes/missing-slash-skills/skills.js";
import { createUsageUpdateMessage } from "../fixes/missing-usage-metrics/index.js";
import { createPlanUpdateMessage } from "../fixes/silent-background-tasks/index.js";
import {
  validateAcpSchema,
  validateSessionNotification,
  validateSessionUpdate,
  validateUsageUpdate,
  validatePlan,
  validateToolCallUpdate,
  validateAvailableCommandsUpdate,
} from "../test-utils/acp-validator.js";

/* -------------------------------------------------------------------------- */
/* Compile-Time Type Assertion Tests                                          */
/* -------------------------------------------------------------------------- */

type AssertAssignable<_T extends _U, _U> = true;

export type _CompileTimeTypeAssertions = [
  AssertAssignable<SessionPlanEntry, AcpSdk.PlanEntry>,
  AssertAssignable<AvailableCommand, AcpSdk.AvailableCommand>,
  AssertAssignable<SessionPlanEntry["priority"], AcpSdk.PlanEntryPriority>,
  AssertAssignable<SessionPlanEntry["status"], AcpSdk.PlanEntryStatus>,
  AssertAssignable<AcpSdk.SessionNotification, SessionUpdateParams>,
  AssertAssignable<AcpSdk.SessionUpdate, SessionUpdatePayload>,
];

describe("ACP Official Protocol Conformance", () => {
  describe("Method Names and Protocol Constants", () => {
    it.each([
      [ACP_METHODS.INITIALIZE, AGENT_METHODS.initialize],
      [ACP_METHODS.AUTHENTICATE, AGENT_METHODS.authenticate],
      [ACP_METHODS.LOGOUT, AGENT_METHODS.logout],
      [ACP_METHODS.SESSION_NEW, AGENT_METHODS.session_new],
      [ACP_METHODS.SESSION_LOAD, AGENT_METHODS.session_load],
      [ACP_METHODS.SESSION_LIST, AGENT_METHODS.session_list],
      [ACP_METHODS.SESSION_RESUME, AGENT_METHODS.session_resume],
      [ACP_METHODS.SESSION_CLOSE, AGENT_METHODS.session_close],
      [ACP_METHODS.SESSION_DELETE, AGENT_METHODS.session_delete],
      [ACP_METHODS.SESSION_FORK, AGENT_METHODS.session_fork],
      [ACP_METHODS.SESSION_PROMPT, AGENT_METHODS.session_prompt],
      [ACP_METHODS.SESSION_SET_MODE, AGENT_METHODS.session_set_mode],
      [ACP_METHODS.SESSION_SET_CONFIG_OPTION, AGENT_METHODS.session_set_config_option],
      [ACP_METHODS.SESSION_CANCEL, AGENT_METHODS.session_cancel],
      [ACP_METHODS.SESSION_UPDATE, CLIENT_METHODS.session_update],
      [ACP_METHODS.SESSION_REQUEST_PERMISSION, CLIENT_METHODS.session_request_permission],
      [ACP_METHODS.CANCEL_REQUEST, PROTOCOL_METHODS.cancel_request],
    ])("method %s matches official spec %s", (internal, official) => {
      expect(internal).toBe(official);
    });

    it("matches standard ACP stop reasons and session updates", () => {
      expect(STOP_REASONS.END_TURN).toBe("end_turn");
      expect(STOP_REASONS.CANCELLED).toBe("cancelled");

      const validVariants = new Set<string>([
        "agent_message_chunk",
        "user_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "plan_update",
        "plan_removed",
        "available_commands_update",
        "current_mode_update",
        "config_option_update",
        "session_info_update",
        "usage_update",
        "notice",
        "compaction_update",
        "compaction_summary_chunk",
      ]);

      for (const updateType of Object.values(SESSION_UPDATES)) {
        expect(validVariants.has(updateType)).toBe(true);
      }
    });
  });

  describe("Synthesized Fix Messages Conform to Official JSON Schema", () => {
    it.each([
      [
        "usage_update via createUsageUpdateMessage",
        () =>
          createUsageUpdateMessage("sess-100", {
            usedTokens: 4200,
            maxTokens: 1000000,
            promptTokens: 3000,
            candidateTokens: 1200,
          }),
      ],
      [
        "plan via createPlanUpdateMessage",
        () =>
          createPlanUpdateMessage("sess-plan-1", [
            { content: "Explore repo", priority: "high", status: "completed" },
            { content: "Implement feature", priority: "high", status: "in_progress" },
            { content: "Run verification tests", priority: "medium", status: "pending" },
          ]),
      ],
      [
        "tool_call_update completion",
        () => ({
          sessionId: "sess-tc-1",
          update: {
            sessionUpdate: SESSION_UPDATES.TOOL_CALL_UPDATE,
            toolCallId: "call_abc123",
            status: "completed",
          },
        }),
      ],
      [
        "available_commands_update",
        () => ({
          sessionId: "sess-skills-1",
          update: {
            sessionUpdate: SESSION_UPDATES.AVAILABLE_COMMANDS_UPDATE,
            availableCommands: [
              { name: "test-runner", description: "Runs the test suite" },
              { name: "build-pkg", description: "Builds package" },
            ],
          },
        }),
      ],
      [
        "agent_message_chunk",
        () => ({
          sessionId: "sess-chunk-1",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_MESSAGE_CHUNK,
            content: { type: "text", text: "Hello, world!" },
          },
        }),
      ],
      [
        "agent_thought_chunk",
        () => ({
          sessionId: "sess-thought-1",
          update: {
            sessionUpdate: SESSION_UPDATES.AGENT_THOUGHT_CHUNK,
            content: { type: "text", text: "Analyzing codebase..." },
          },
        }),
      ],
      [
        "user_message_chunk",
        () => ({
          sessionId: "sess-user-1",
          update: {
            sessionUpdate: SESSION_UPDATES.USER_MESSAGE_CHUNK,
            content: { type: "text", text: "User input streamed" },
          },
        }),
      ],
    ])("validates %s against SessionNotification schema", (_name, makePayload) => {
      const data = makePayload();
      const params = "params" in data ? (data as { params: unknown }).params : data;
      const res = validateSessionNotification(params);
      expect(res.valid).toBe(true);
      expect(res.errors).toBeUndefined();
    });

    it.each([
      [
        "UsageUpdate",
        validateUsageUpdate,
        { used: 5000, size: 1000000 },
        { used: "5000" }, // missing size, invalid type
      ],
      [
        "Plan",
        validatePlan,
        { entries: [{ content: "Task 1", priority: "low", status: "completed" }] },
        { entries: [{ content: "Task 1", priority: "super-urgent", status: "done" }] },
      ],
      [
        "ToolCallUpdate",
        validateToolCallUpdate,
        { toolCallId: "call_test", status: "completed" },
        { status: "completed" }, // missing toolCallId
      ],
      [
        "AvailableCommandsUpdate",
        validateAvailableCommandsUpdate,
        { availableCommands: [{ name: "cmd1", description: "desc1" }] },
        { availableCommands: [{ description: "missing name" }] },
      ],
      [
        "SessionUpdate",
        validateSessionUpdate,
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk" } },
        { sessionUpdate: "unsupported_random_variant", data: "test" },
      ],
    ])(
      "validates %s schema against valid and invalid payloads",
      (_name, validator, validPayload, invalidPayload) => {
        expect(validator(validPayload).valid).toBe(true);
        expect(validator(invalidPayload).valid).toBe(false);
      },
    );

    it.each([
      [
        "InitializeRequest",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      ],
      [
        "PromptRequest",
        {
          sessionId: "sess-prompt-1",
          prompt: [{ type: "text", text: "What is the answer?" }],
        },
      ],
    ])("validates core request %s against official schema", (schemaDef, payload) => {
      expect(validateAcpSchema(schemaDef, payload).valid).toBe(true);
    });
  });
});
