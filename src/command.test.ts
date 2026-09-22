import { describe, expect, it } from "vitest";
import { agyCommand } from "./command.js";

describe("agyCommand", () => {
  it("throws on unsupported platforms", () => {
    expect(() => agyCommand("freebsd" as NodeJS.Platform)).toThrow(/does not support freebsd/);
  });

  it("respects environment override", () => {
    const custom = "/custom/path/to/agy_acp_server.par";
    expect(agyCommand("darwin", custom)).toEqual([custom]);
  });

  it("appends --uid= on linux", () => {
    const custom = "/custom/path/to/agy_acp_server.par";
    expect(agyCommand("linux", custom)).toEqual([custom, "--uid="]);
  });
});
