import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACP_METHODS,
  type AcpStreamMessage,
  type JsonRpcRequest,
  type OutboundContext,
} from "../../core/types.js";
import { prunedBuiltinToolsFix } from "./index.js";

interface DisabledToolsParams {
  cwd?: string;
  sessionId?: string;
  prompt?: string;
  _meta?: {
    antigravity?: {
      disabledTools?: string[];
    };
  };
}

const dummyContext = {} as OutboundContext;

describe("prunedBuiltinToolsFix", () => {
  const originalEnv = process.env.REFINED_AGY_DISABLED_TOOLS;

  beforeEach(() => {
    delete process.env.REFINED_AGY_DISABLED_TOOLS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.REFINED_AGY_DISABLED_TOOLS = originalEnv;
    } else {
      delete process.env.REFINED_AGY_DISABLED_TOOLS;
    }
  });

  it("passes messages through unchanged when REFINED_AGY_DISABLED_TOOLS is unset", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: ACP_METHODS.SESSION_NEW,
      params: { cwd: "/tmp" },
    };

    const result = prunedBuiltinToolsFix.onOutbound?.(msg, dummyContext) as JsonRpcRequest<
      string,
      DisabledToolsParams
    >;
    expect(result).toBe(msg);
    expect(result.params?._meta).toBeUndefined();
  });

  it("passes messages through unchanged when REFINED_AGY_DISABLED_TOOLS is 'none' or '0'", () => {
    for (const val of ["none", "0", "false", "  none  "]) {
      process.env.REFINED_AGY_DISABLED_TOOLS = val;
      const msg: AcpStreamMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: ACP_METHODS.SESSION_NEW,
        params: { cwd: "/tmp" },
      };

      const result = prunedBuiltinToolsFix.onOutbound?.(msg, dummyContext) as JsonRpcRequest<
        string,
        DisabledToolsParams
      >;
      expect(result.params?._meta).toBeUndefined();
    }
  });

  it("injects disabledTools on session/new when REFINED_AGY_DISABLED_TOOLS is set", () => {
    process.env.REFINED_AGY_DISABLED_TOOLS = "generate_image, schedule, run_workflow";

    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: ACP_METHODS.SESSION_NEW,
      params: { cwd: "/tmp" },
    };

    const result = prunedBuiltinToolsFix.onOutbound?.(msg, dummyContext) as JsonRpcRequest<
      string,
      DisabledToolsParams
    >;
    expect(result.params?._meta?.antigravity?.disabledTools).toEqual([
      "generate_image",
      "schedule",
      "run_workflow",
    ]);
  });

  it("injects disabledTools on session/load and session/resume", () => {
    process.env.REFINED_AGY_DISABLED_TOOLS = "generate_image,schedule";

    for (const method of [ACP_METHODS.SESSION_LOAD, ACP_METHODS.SESSION_RESUME]) {
      const msg: AcpStreamMessage = {
        jsonrpc: "2.0",
        id: 2,
        method,
        params: { sessionId: "s-1" },
      };

      const result = prunedBuiltinToolsFix.onOutbound?.(msg, dummyContext) as JsonRpcRequest<
        string,
        DisabledToolsParams
      >;
      expect(result.params?._meta?.antigravity?.disabledTools).toEqual([
        "generate_image",
        "schedule",
      ]);
    }
  });

  it("preserves existing disabledTools and deduplicates", () => {
    process.env.REFINED_AGY_DISABLED_TOOLS = "schedule,run_workflow";

    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: ACP_METHODS.SESSION_NEW,
      params: {
        cwd: "/tmp",
        _meta: {
          antigravity: {
            disabledTools: ["generate_image", "schedule"],
          },
        },
      },
    };

    const result = prunedBuiltinToolsFix.onOutbound?.(msg, dummyContext) as JsonRpcRequest<
      string,
      DisabledToolsParams
    >;
    expect(result.params?._meta?.antigravity?.disabledTools).toEqual([
      "generate_image",
      "schedule",
      "run_workflow",
    ]);
  });

  it("ignores non-session initialization methods like session/prompt", () => {
    process.env.REFINED_AGY_DISABLED_TOOLS = "generate_image";

    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 3,
      method: ACP_METHODS.SESSION_PROMPT,
      params: { sessionId: "s-1", prompt: "hello" },
    };

    const result = prunedBuiltinToolsFix.onOutbound?.(msg, dummyContext) as JsonRpcRequest<
      string,
      DisabledToolsParams
    >;
    expect(result.params?._meta).toBeUndefined();
  });
});
