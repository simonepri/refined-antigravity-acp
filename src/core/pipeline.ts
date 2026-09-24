import type { ChildProcess } from "node:child_process";
import type {
  AcpStreamMessage,
  AcpFix,
  CoreContext,
  InboundContext,
  OutboundContext,
  StderrContext,
} from "./types.js";

export class AcpPipeline {
  private readonly spawnFixes: AcpFix[];
  private readonly outboundFixes: AcpFix[];
  private readonly inboundFixes: AcpFix[];
  private readonly turnEndFixes: AcpFix[];
  private readonly stderrFixes: AcpFix[];
  private readonly recycleFixes: AcpFix[];

  constructor(public readonly fixes: AcpFix[]) {
    this.spawnFixes = fixes.filter((f) => typeof f.onSpawn === "function");
    this.outboundFixes = fixes.filter((f) => typeof f.onOutbound === "function");
    this.inboundFixes = fixes.filter((f) => typeof f.onInbound === "function");
    this.turnEndFixes = fixes.filter((f) => typeof f.onTurnEnd === "function");
    this.stderrFixes = fixes.filter((f) => typeof f.onStderrLine === "function");
    this.recycleFixes = fixes.filter((f) => typeof f.onRecycle === "function");
  }

  applySpawn(env: NodeJS.ProcessEnv, cmd: string, args: string[]): void {
    for (const fix of this.spawnFixes) {
      fix.onSpawn?.(env, cmd, args);
    }
  }

  async applyOutbound(
    msg: AcpStreamMessage,
    context: OutboundContext,
  ): Promise<AcpStreamMessage | null> {
    const enrichedContext: OutboundContext = context.fixes
      ? context
      : { ...context, fixes: this.fixes };
    let current: AcpStreamMessage = msg;
    for (const fix of this.outboundFixes) {
      const res = await fix.onOutbound!(current, enrichedContext);
      if (res === null || res === undefined) {
        return null;
      }
      current = res;
    }
    return current;
  }

  async applyInbound(msg: AcpStreamMessage, context: InboundContext): Promise<AcpStreamMessage[]> {
    let current: AcpStreamMessage[] = [msg];
    for (const fix of this.inboundFixes) {
      if (current.length === 1) {
        const first = current[0];
        if (!first) return [];
        const res = await fix.onInbound!(first, context);
        if (!Array.isArray(res) || res.length === 0) return [];
        current = res;
      } else {
        const nextBatch: AcpStreamMessage[] = [];
        for (const m of current) {
          const res = await fix.onInbound!(m, context);
          if (Array.isArray(res) && res.length > 0) {
            nextBatch.push(...res);
          }
        }
        current = nextBatch;
        if (current.length === 0) break;
      }
    }
    return current;
  }

  applyTurnEnd(sessionId: string, context: InboundContext): AcpStreamMessage[] {
    const messages: AcpStreamMessage[] = [];
    for (const fix of this.turnEndFixes) {
      const res = fix.onTurnEnd!(sessionId, context);
      if (Array.isArray(res) && res.length > 0) {
        messages.push(...res);
      }
    }
    return messages;
  }

  applyStderrLine(line: string, context: StderrContext): boolean {
    let suppressed = false;
    for (const fix of this.stderrFixes) {
      if (fix.onStderrLine!(line, context)) {
        suppressed = true;
      }
    }
    return suppressed;
  }

  async applyRecycle(
    session: Parameters<NonNullable<AcpFix["onRecycle"]>>[0],
    newChild: ChildProcess,
    context: CoreContext,
  ): Promise<void> {
    for (const fix of this.recycleFixes) {
      await fix.onRecycle!(session, newChild, context);
    }
  }

  dispose(): void {
    for (const fix of this.fixes) {
      fix.dispose?.();
    }
  }
}
