import type { AcpFix } from "../core/types.js";
import { missingLocalharnessFix } from "./missing-localharness/index.js";
import { missingSystemPromptFix } from "./missing-system-prompt/index.js";
import { missingSlashSkillsFix } from "./missing-slash-skills/index.js";
import { subagentHangFix } from "./subagent-hang/index.js";
import { malformedStreamSyntaxFix } from "./malformed-stream-syntax/index.js";
import { activeTurnCollisionFix } from "./active-turn-collision/index.js";
import { cancellationLeakFix } from "./cancellation-leak/index.js";
import { staleMcpEndpointsFix } from "./stale-mcp-endpoints/index.js";
import { orphanedCheckpointsFix } from "./orphaned-checkpoints/index.js";
import { droppedHistoryChunksFix } from "./dropped-history-chunks/index.js";
import { noisyStderrLogsFix } from "./noisy-stderr-logs/index.js";
import { flattenedModelEffortsFix } from "./flattened-model-efforts/index.js";

export * from "./missing-localharness/index.js";
export * from "./missing-system-prompt/index.js";
export * from "./missing-slash-skills/index.js";
export * from "./subagent-hang/index.js";
export * from "./malformed-stream-syntax/index.js";
export * from "./active-turn-collision/index.js";
export * from "./cancellation-leak/index.js";
export * from "./stale-mcp-endpoints/index.js";
export * from "./orphaned-checkpoints/index.js";
export * from "./dropped-history-chunks/index.js";
export * from "./noisy-stderr-logs/index.js";
export * from "./flattened-model-efforts/index.js";

/**
 * Returns a list of all active fixes addressing the upstream issues documented in readme.md.
 * As upstream releases fix these defects, retirement is as simple as removing the fix here
 * and deleting its corresponding folder in src/fixes/.
 */
export function createDefaultFixes(): AcpFix[] {
  return [
    missingLocalharnessFix,
    missingSystemPromptFix,
    missingSlashSkillsFix,
    subagentHangFix,
    malformedStreamSyntaxFix,
    activeTurnCollisionFix,
    cancellationLeakFix,
    staleMcpEndpointsFix,
    orphanedCheckpointsFix,
    droppedHistoryChunksFix,
    noisyStderrLogsFix,
    flattenedModelEffortsFix,
  ];
}
