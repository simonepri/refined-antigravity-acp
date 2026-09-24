import { describe, expect, it } from "vitest";
import type { AcpStreamMessage, OutboundContext } from "../../core/types.js";
import { modeNormalizationFix, normalizeModeId, normalizeModeIdOnMsg } from "./index.js";

describe("normalizeModeId", () => {
  it("maps client mode 'accept-edits' to supported mode 'auto_edit'", () => {
    expect(normalizeModeId("accept-edits")).toBe("auto_edit");
  });

  it("maps client mode 'dangerously-skip-permissions' to supported mode 'yolo'", () => {
    expect(normalizeModeId("dangerously-skip-permissions")).toBe("yolo");
  });

  it("maps client mode 'plan' to fallback mode 'default'", () => {
    expect(normalizeModeId("plan")).toBe("default");
  });

  it("preserves standard or unknown mode identifiers unchanged", () => {
    expect(normalizeModeId("default")).toBe("default");
    expect(normalizeModeId("auto_edit")).toBe("auto_edit");
    expect(normalizeModeId("yolo")).toBe("yolo");
    expect(normalizeModeId("custom_mode")).toBe("custom_mode");
    expect(normalizeModeId(undefined)).toBeUndefined();
  });
});

describe("normalizeModeIdOnMsg", () => {
  it("normalizes mode identifier within session/set_mode message payload", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "accept-edits" },
    } as unknown as AcpStreamMessage;

    normalizeModeIdOnMsg(msg);
    expect((msg as { params: { modeId: string } }).params.modeId).toBe("auto_edit");
  });

  it("leaves messages without mode identifiers unaffected", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "s1" },
    } as unknown as AcpStreamMessage;

    normalizeModeIdOnMsg(msg);
    expect((msg as { params: { sessionId: string } }).params.sessionId).toBe("s1");
  });
});

describe("modeNormalizationFix", () => {
  it("intercepts outbound session/set_mode requests and translates unsupported mode identifiers", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_mode",
      params: { sessionId: "s1", modeId: "dangerously-skip-permissions" },
    } as unknown as AcpStreamMessage;

    const res = modeNormalizationFix.onOutbound?.(msg, {} as OutboundContext);
    expect((res as { params: { modeId: string } }).params.modeId).toBe("yolo");
  });
});
