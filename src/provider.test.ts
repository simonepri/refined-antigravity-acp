import { describe, expect, it } from "vitest";
import { createAntigravityProvider } from "./provider.js";

describe("createAntigravityProvider", () => {
  it("initializes provider registration with correct metadata", () => {
    const provider = createAntigravityProvider();
    expect(provider.id).toBe("refined-antigravity-acp");
    expect(provider.label).toBe("Antigravity");
    expect(typeof provider.connect).toBe("function");
  });
});
