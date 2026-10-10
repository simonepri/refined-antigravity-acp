import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpStreamMessage, OutboundContext } from "../../core/types.js";
import { createMockContext } from "../../test-utils/index.js";
import {
  CLIENT_NAME_ENV,
  gatedThirdPartyModelsFix,
  overrideClientName,
  resolveClientNameOverride,
} from "./index.js";

function initializeMsg(clientInfo?: Record<string, unknown>): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
      ...(clientInfo ? { clientInfo } : {}),
    },
  } as unknown as AcpStreamMessage;
}

function clientInfoOf(msg: AcpStreamMessage): Record<string, unknown> | undefined {
  return (msg as { params?: { clientInfo?: Record<string, unknown> } }).params?.clientInfo;
}

describe("resolveClientNameOverride", () => {
  it("returns undefined when the variable is unset or blank", () => {
    expect(resolveClientNameOverride({})).toBeUndefined();
    expect(resolveClientNameOverride({ [CLIENT_NAME_ENV]: "" })).toBeUndefined();
    expect(resolveClientNameOverride({ [CLIENT_NAME_ENV]: "   " })).toBeUndefined();
  });

  it("returns the trimmed configured name", () => {
    expect(resolveClientNameOverride({ [CLIENT_NAME_ENV]: " zed " })).toBe("zed");
  });
});

describe("overrideClientName", () => {
  it("replaces clientInfo.name and keeps the other initialize fields", () => {
    const msg = initializeMsg({ name: "paseo", title: "Paseo", version: "1.2.3" });
    const result = overrideClientName(msg, "zed");

    expect(clientInfoOf(result)).toEqual({ name: "zed", title: "Paseo", version: "1.2.3" });
    expect((result as { params: { protocolVersion: number } }).params.protocolVersion).toBe(1);
    expect(
      (result as { params: { clientCapabilities: unknown } }).params.clientCapabilities,
    ).toEqual({ fs: { readTextFile: true } });
  });

  it("does not mutate the original message", () => {
    const msg = initializeMsg({ name: "paseo", version: "1.2.3" });
    overrideClientName(msg, "zed");
    expect(clientInfoOf(msg)).toEqual({ name: "paseo", version: "1.2.3" });
  });

  it("adds clientInfo when the client sent none", () => {
    const result = overrideClientName(initializeMsg(), "zed");
    expect(clientInfoOf(result)).toEqual({ name: "zed", version: "0.0.0" });
  });

  it("returns the same message when the name already matches", () => {
    const msg = initializeMsg({ name: "zed", version: "0.200.0" });
    expect(overrideClientName(msg, "zed")).toBe(msg);
  });

  it("leaves other methods untouched", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp", clientInfo: { name: "paseo", version: "1" } },
    } as unknown as AcpStreamMessage;
    expect(overrideClientName(msg, "zed")).toBe(msg);
  });
});

describe("gatedThirdPartyModelsFix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const run = (msg: AcpStreamMessage) =>
    gatedThirdPartyModelsFix.onOutbound?.(msg, createMockContext() as OutboundContext);

  it("passes initialize through unchanged when the override is not configured", () => {
    vi.stubEnv(CLIENT_NAME_ENV, "");
    const msg = initializeMsg({ name: "paseo", version: "1.2.3" });
    expect(run(msg)).toBe(msg);
  });

  it("rewrites clientInfo.name when the override is configured", () => {
    vi.stubEnv(CLIENT_NAME_ENV, "zed");
    const result = run(initializeMsg({ name: "paseo", version: "1.2.3" })) as AcpStreamMessage;
    expect(clientInfoOf(result)).toEqual({ name: "zed", version: "1.2.3" });
  });
});
