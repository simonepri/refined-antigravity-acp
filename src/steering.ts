import type {
  ProviderConnectRequest,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { readConversationHistory } from "./history.js";
import { formatSteeringPrompt } from "./sanitize.js";
import { augmentCommands, expandSkillInvocation } from "./skills.js";

function transformPromptInput(
  input: ProviderInput,
  isSteerReplacement: boolean,
  cwd?: string,
): ProviderInput {
  if (input.type !== "session.prompt" || input.prompt.input.type !== "message") {
    return input;
  }
  // Only the first text part carries the steering marker; prefixing every part would
  // repeat it throughout a multi-part prompt.
  let markerPending = isSteerReplacement;
  const content = input.prompt.input.content.map((part) => {
    if (part.type !== "text") return part;
    let text = expandSkillInvocation(part.text, cwd);
    if (markerPending) {
      text = formatSteeringPrompt(text);
      markerPending = false;
    }
    return { ...part, text };
  });
  return {
    ...input,
    prompt: {
      ...input.prompt,
      input: { ...input.prompt.input, content },
    },
  };
}

function readNativeSessionId(persistence: unknown): string | null {
  if (!persistence || typeof persistence !== "object" || Array.isArray(persistence)) {
    return null;
  }
  const data = (persistence as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const sessionId = (data as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

/**
 * Connection wrapper that decorates a base ProviderConnection with:
 * 1. Mid-turn steering (`prompt.steer`)
 * 2. Slash skill command advertising (`session.commands`)
 * 3. Slash skill expansion on prompt submission
 * 4. Automatic conversation history replay from Antigravity SQLite on session reload
 */
export class SteeringConnection implements ProviderConnection {
  readonly version: number;
  readonly capabilities: readonly string[];

  private readonly sessionCwds = new Map<string, string>();
  private readonly pendingSteers = new Set<string>();
  private readonly replaySessions = new Set<string>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly unbindBase: () => void;

  constructor(
    private readonly base: ProviderConnection,
    private readonly request: ProviderConnectRequest,
  ) {
    this.version = base.version;
    this.capabilities = request.capabilities.includes("prompt.steer")
      ? Array.from(new Set([...base.capabilities, "prompt.steer"]))
      : base.capabilities;

    this.unbindBase = this.base.onEvent((event) => this.handleBaseEvent(event));
  }

  private emitSessionSkills(sessionId: string, cwd: string): void {
    try {
      const commands = augmentCommands(undefined, cwd);
      if (commands.length > 0) {
        this.emit({ type: "session.commands", sessionId, commands });
      }
    } catch (err) {
      console.error("[paseo-antigravity] Failed to emit session.commands on session.opened:", err);
    }
  }

  private replaySessionHistory(sessionId: string, nativeSessionId: string): void {
    try {
      const history = readConversationHistory(nativeSessionId);
      for (const entry of history) {
        this.emit({
          type: "timeline.item",
          sessionId,
          item: entry.item,
          timestamp: entry.timestamp,
        });
      }
    } catch (err) {
      console.error(`[paseo-antigravity] Failed to replay history for ${sessionId}:`, err);
    }
  }

  private handleSessionOpened(event: Extract<ProviderEvent, { type: "session.opened" }>): void {
    const cwd = (event as { cwd?: string }).cwd ?? process.cwd();
    this.sessionCwds.set(event.sessionId, cwd);

    const sessionCaps = this.request.capabilities.includes("prompt.steer")
      ? Array.from(new Set([...event.capabilities, "prompt.steer"]))
      : event.capabilities;
    this.emit({ ...event, capabilities: sessionCaps });

    if (this.replaySessions.delete(event.sessionId)) {
      const nativeId = readNativeSessionId(event.persistence);
      if (nativeId) {
        this.replaySessionHistory(event.sessionId, nativeId);
      }
    }

    this.emitSessionSkills(event.sessionId, cwd);
  }

  private handleBaseEvent(event: ProviderEvent): void {
    if (event.type === "session.opened") {
      this.handleSessionOpened(event);
      return;
    }
    if (event.type === "session.commands") {
      const cwd = this.sessionCwds.get(event.sessionId);
      const commands = augmentCommands(event.commands, cwd);
      this.emit({ ...event, commands });
      return;
    }
    this.emit(event);
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private handleSteerPrompt(sessionId: string, clientMessageId: string): void {
    this.pendingSteers.add(sessionId);
    this.emit({
      type: "session.prompt_result",
      sessionId,
      clientMessageId,
      result: { type: "completed" },
    });
  }

  async send(input: ProviderInput): Promise<void> {
    if (input.type === "session.open") {
      if (input.history === "replay") {
        this.replaySessions.add(input.sessionId);
      }
    }

    if (input.type === "session.prompt") {
      if (input.prompt.delivery === "steer") {
        this.handleSteerPrompt(input.sessionId, input.prompt.clientMessageId);
        return;
      }
      // Paseo answers a steer by cancelling the turn and re-dispatching the text as a
      // normal prompt. `pendingSteers` is how we recognise that replacement so it can be
      // marked as a mid-turn interruption rather than a fresh instruction.
      const isReplacement = this.pendingSteers.delete(input.sessionId);
      const cwd = this.sessionCwds.get(input.sessionId);
      input = transformPromptInput(input, isReplacement, cwd);
    }

    if (input.type === "session.close") {
      this.pendingSteers.delete(input.sessionId);
      this.replaySessions.delete(input.sessionId);
      this.sessionCwds.delete(input.sessionId);
    }

    return this.base.send(input);
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.pendingSteers.clear();
    this.replaySessions.clear();
    this.sessionCwds.clear();
    this.listeners.clear();
    this.unbindBase();
    return this.base.close();
  }
}
