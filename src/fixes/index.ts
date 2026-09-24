import type { AcpFix } from "../core/types.js";
import { missingLocalharnessFix } from "./missing-localharness/index.js";
import { missingSystemPromptFix } from "./missing-system-prompt/index.js";
import { missingSlashSkillsFix } from "./missing-slash-skills/index.js";
import { subagentHangFix } from "./subagent-hang/index.js";

export * from "./missing-localharness/index.js";
export * from "./missing-system-prompt/index.js";
export * from "./missing-slash-skills/index.js";
export * from "./subagent-hang/index.js";

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
  ];
}
