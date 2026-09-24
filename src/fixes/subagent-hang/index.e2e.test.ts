import { describe, expect, it } from "vitest";
import { HangDetector } from "./index.js";

describe("subagent-hang e2e", () => {
  it("solution: hang detector triggers crash recovery on 'could not find doneCh for checkpoint'", () => {
    let hangDeclared = false;
    const detector = new HangDetector({
      onHangDeclared: () => {
        hangDeclared = true;
      },
    });

    detector.recordPrompt(1, "test-session");
    detector.processStderrLine("E0922 12:00:01.000000 could not find doneCh for checkpoint 123");
    expect(hangDeclared).toBe(true);
    detector.dispose();
  });
});
