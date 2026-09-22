import { describe, expect, it } from "vitest";
import {
  formatSteeringPrompt,
  formatSystemContext,
  sanitizeAssistantText,
  StreamSanitizer,
  stripSteeringPrefix,
  stripSystemContext,
} from "./sanitize.js";

describe("sanitize", () => {
  it("normalizes <kbd> tags into backtick code spans", () => {
    const raw = "Press <kbd>Cmd</kbd> + <kbd>C</kbd> to copy.";
    expect(sanitizeAssistantText(raw)).toBe("Press `Cmd` + `C` to copy.");
  });

  it("normalizes <u>, <mark>, and <sup> tags", () => {
    const raw = "This is <u>important</u>, <mark>highlighted</mark>, and x<sup>2</sup>.";
    expect(sanitizeAssistantText(raw)).toBe("This is *important*, **highlighted**, and x^(2).");
  });

  it("converts common LaTeX math escapes into clean Unicode characters", () => {
    const raw = "State A $\\to$ State B, where x $\\le$ 10 and y $\\ge$ 5 (x $\\neq$ y).";
    expect(sanitizeAssistantText(raw)).toBe("State A → State B, where x ≤ 10 and y ≥ 5 (x ≠ y).");
  });

  it("strips leaked <system_message> blocks", () => {
    const raw = `<SYSTEM_MESSAGE>
The subagent 81628bf1 has reported success.
</SYSTEM_MESSAGE>

We have received the first completion.`;
    expect(sanitizeAssistantText(raw).trim()).toBe("We have received the first completion.");
  });

  it("strips preamble with <SYSTEM_MESSAGE>", () => {
    const raw = `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] task completed
</SYSTEM_MESSAGE>Done with task.`;
    expect(sanitizeAssistantText(raw).trim()).toBe("Done with task.");
  });

  it("strips leaked <system_notification>, <context>, and <messaging>", () => {
    const raw = `<system_notification>Task exited 0</system_notification><context>Context info</context>Here is your result.`;
    expect(sanitizeAssistantText(raw).trim()).toBe("Here is your result.");
  });

  it("strips <task_notification> blocks and streaming unclosed tags", () => {
    const raw = `<task_notification>
Task 528dc461-72a0-4c97-a5d5-d24b66eb6d6c/task-957 ended with status: EXITED.
Exit code: 0
Execution time: 42.66 seconds.
Tail output:
Running tests
</task_notification>`;
    expect(sanitizeAssistantText(raw)).toBe("");

    const streaming = `<task_notification>
Task task-957 ended with status: EXITED.`;
    expect(sanitizeAssistantText(streaming)).toBe("");
  });

  it("strips cancellation error messages emitted during turn abort / steering", () => {
    expect(sanitizeAssistantText("The request was cancelled by the client.")).toBe("");
    expect(sanitizeAssistantText("The request was canceled by the client")).toBe("");
    expect(sanitizeAssistantText("context canceled.")).toBe("");
    expect(sanitizeAssistantText("context cancelled")).toBe("");
  });

  it("strips leaked [Mid-turn update]: prefixes from assistant output", () => {
    const raw = "[Mid-turn update]: I am stopping that action and proceeding with tests.";
    expect(sanitizeAssistantText(raw)).toBe("I am stopping that action and proceeding with tests.");
  });

  it("strips <RECEIVE_NOTIFICATIONS_DIRECTLY> blocks and directives", () => {
    const raw = `The diagnostic check was launched in the background to inspect the provider environment.

<RECEIVE_NOTIFICATIONS_DIRECTLY>
Wait for the notification when the diagnostic check completes.
</RECEIVE_NOTIFICATIONS_DIRECTLY>`;
    expect(sanitizeAssistantText(raw).trim()).toBe(
      "The diagnostic check was launched in the background to inspect the provider environment.",
    );
  });

  it("formats system context with system prompt and formatting guidance", () => {
    const context = formatSystemContext("Act as an expert SRE.");
    expect(context).toContain("[System Context]:\nAct as an expert SRE.");
    expect(context).toContain("[Formatting Guidance]:");
    expect(context).toContain("Math: The UI does not render LaTeX");
    expect(context).toContain("Mermaid: Always wrap both node labels AND edge labels");
  });

  it("marks the steering replacement prompt as a mid-turn interruption", () => {
    // Paseo answers a steer by cancelling the turn and re-dispatching the text. The
    // marker is what tells the model the new text supersedes the instruction in flight.
    expect(formatSteeringPrompt("STOP!")).toBe("[Mid-turn update]: STOP!");
    expect(formatSteeringPrompt("  why port 3000?  ")).toBe("[Mid-turn update]: why port 3000?");
  });

  it("round-trips the steering marker back out of text that is about to be displayed", () => {
    const sent = formatSteeringPrompt("use vitest");
    expect(stripSteeringPrefix(sent).trim()).toBe("use vitest");
    expect(sanitizeAssistantText(`Sure.\n${sent}`)).toBe("Sure.use vitest");
  });
  describe("stripSystemContext", () => {
    it("strips formatted system context with custom prompt and formatting guidance", () => {
      const context = formatSystemContext("Act as an expert SRE.");
      const fullPrompt = `${context}\n\nDeploy the application to staging.`;
      expect(stripSystemContext(fullPrompt)).toBe("Deploy the application to staging.");
    });

    it("strips formatting guidance when no system prompt was provided", () => {
      const context = formatSystemContext(undefined);
      const fullPrompt = `${context}\n\nWhat is the status?`;
      expect(stripSystemContext(fullPrompt)).toBe("What is the status?");
    });

    it("leaves regular user prompt untouched", () => {
      const raw = "How do I configure nginx?";
      expect(stripSystemContext(raw)).toBe("How do I configure nginx?");
    });

    it("strips entire string when text contains only system context and formatting guidance", () => {
      const context = formatSystemContext("Act as an expert SRE.");
      expect(stripSystemContext(context)).toBe("");
    });
  });

  describe("StreamSanitizer", () => {
    it("preserves spaces between normal streamed chunks without trimming", () => {
      const sanitizer = new StreamSanitizer();
      expect(sanitizer.process("Hello ")).toBe("Hello ");
      expect(sanitizer.process("world! ")).toBe("world! ");
      expect(sanitizer.process("How are you?")).toBe("How are you?");
    });

    it("suppresses <task_notification> split across multiple streaming chunks", () => {
      const sanitizer = new StreamSanitizer();
      expect(sanitizer.process("Before test.\n<task_")).toBe("Before test.\n");
      expect(sanitizer.process("notification>\nTask 123 ended.\nExit code: 0\n")).toBe("");
      expect(sanitizer.process("Tail output:\nRunning tests...\n</task_")).toBe("");
      expect(sanitizer.process("notification>\nAfter test.")).toBe("\nAfter test.");
    });

    it("suppresses unclosed <task_notification> streaming to the end of turn", () => {
      const sanitizer = new StreamSanitizer();
      expect(sanitizer.process("Start\n<task_notification>\nTask 456 running...")).toBe("Start\n");
      expect(sanitizer.process("\nMore task output...")).toBe("");
      expect(sanitizer.flush()).toBe("");
    });

    it("does not suppress or break mathematical < or HTML-like templates", () => {
      const sanitizer = new StreamSanitizer();
      expect(sanitizer.process("if a < b and c > d: ")).toBe("if a < b and c > d: ");
      expect(sanitizer.process("std::vector<int> numbers;")).toBe("std::vector<int> numbers;");
      expect(sanitizer.flush()).toBe("");
    });

    it("suppresses preamble <SYSTEM_MESSAGE> banners across streaming chunks", () => {
      const sanitizer = new StreamSanitizer();
      expect(
        sanitizer.process(
          "OK.\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>",
        ),
      ).toBe("OK.\n");
      expect(sanitizer.process("[Message] Internal note\n</SYSTEM_MESSAGE>\nReady!")).toBe(
        "\nReady!",
      );
    });
  });
});
