import type { AcpFix } from "../core/types.js";


/**
 * Returns a list of all active fixes addressing the upstream issues documented in readme.md.
 * As upstream releases fix these defects, retirement is as simple as removing the fix here
 * and deleting its corresponding folder in src/fixes/.
 */
export function createDefaultFixes(): AcpFix[] {
  return [
  ];
}
