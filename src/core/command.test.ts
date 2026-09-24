import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGY_VERSION,
  agyCommand,
  getAgyVersion,
  getBinaryUrl,
  getPlatformKey,
} from "./command.js";

describe("agyCommand", () => {
  it("fails with descriptive error when running on unsupported platforms", () => {
    expect(() => agyCommand("freebsd" as NodeJS.Platform)).toThrow(/does not support freebsd/);
  });

  it("uses custom binary path when configured via environment override", () => {
    const custom = "/custom/path/to/agy_acp_server.par";
    expect(agyCommand("darwin", custom)).toEqual([custom]);
  });

  it("appends required --uid flag on linux to support rootless container environments", () => {
    const custom = "/custom/path/to/agy_acp_server.par";
    expect(agyCommand("linux", custom)).toEqual([custom, "--uid="]);
  });
});

describe("version and binary URLs", () => {
  it("defaults to baseline upstream version when no override is provided", () => {
    const origOfficial = process.env.REFINED_AGY_OFFICIAL_ACP_VERSION;
    const orig = process.env.REFINED_AGY_VERSION;
    try {
      delete process.env.REFINED_AGY_OFFICIAL_ACP_VERSION;
      delete process.env.REFINED_AGY_VERSION;
      expect(getAgyVersion()).toBe(DEFAULT_AGY_VERSION);
    } finally {
      if (origOfficial !== undefined) process.env.REFINED_AGY_OFFICIAL_ACP_VERSION = origOfficial;
      if (orig !== undefined) process.env.REFINED_AGY_VERSION = orig;
    }
  });

  it("resolves binary download URL according to configured version override", () => {
    const origOfficial = process.env.REFINED_AGY_OFFICIAL_ACP_VERSION;
    try {
      process.env.REFINED_AGY_OFFICIAL_ACP_VERSION = "2.0.0";
      expect(getAgyVersion()).toBe("2.0.0");
      expect(getBinaryUrl("darwin-arm64")).toContain("agy-acp-server-2.0.0-darwin-arm64.zip");
      expect(getBinaryUrl("darwin-arm64", "1.1.1")).toContain(
        "agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip",
      );
    } finally {
      if (origOfficial !== undefined) process.env.REFINED_AGY_OFFICIAL_ACP_VERSION = origOfficial;
      else delete process.env.REFINED_AGY_OFFICIAL_ACP_VERSION;
    }
  });

  it("returns null binary URL for unsupported architecture targets", () => {
    expect(getBinaryUrl("freebsd-x64")).toBeNull();
  });

  it("maps operating system and architecture to valid platform keys", () => {
    expect(getPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(getPlatformKey("freebsd", "x64")).toBeNull();
  });
});
