// A note for each variable that is not read but looks meant as one that is, such as CLOUDROP_R2_BUCKT: otherwise the
// only clue is "CLOUDROP_R2_BUCKET is not set" (M9-H103). With --var the names compared are the app's own (M11-C5).

import { type NameOf, nearest, SERVICE_SETTINGS, SETTINGS } from "./names.ts";
import type { Finding } from "./report.ts";

/** Settings people bring from S3 to R2, which R2 builds or does not need. */
function notForR2(upper: string, name: NameOf): string | undefined {
  if (upper === "CLOUDROP_R2_ENDPOINT") return `R2's endpoint is built from ${name("CLOUDROP_R2_ACCOUNT_ID")}.`;
  return upper === "CLOUDROP_R2_REGION" ? "R2 needs no region." : undefined;
}

/**
 * The variable that is read, is not set, and is `upper` in another case or a slip away from it. A CLOUDROP_* name says
 * it was meant as a setting, so two edits count, among the settings of the service it names. Any other name is one of
 * the environment's many, so only one edit counts: SSH_KEY is no misspelt S3_KEY.
 */
function meant(upper: string, isSet: (variable: string) => boolean, name: NameOf): string | undefined {
  // CLOUDROP_R2_ENDPOINT is no misspelt CLOUDROP_S3_ENDPOINT: following that advice would change nothing.
  const service = upper.startsWith("CLOUDROP_R2_") ? "R2" : upper.startsWith("CLOUDROP_S3_") ? "S3" : undefined;
  const read = (service ? SERVICE_SETTINGS[service] : SETTINGS).map(name);
  const closest = nearest(upper, read, upper.startsWith("CLOUDROP_") ? 2 : 1);
  return closest && !isSet(closest) ? `Did you mean ${closest}?` : undefined;
}

/** `present` are the names found in the environment and the env file. */
export function misspelt(present: readonly string[], isSet: (variable: string) => boolean, name: NameOf): Finding[] {
  const read = SETTINGS.map(name);
  return [...new Set(present)].flatMap((found): Finding[] => {
    // A variable --var names is read, whatever it resembles. A renamed setting's own name has a note of its own.
    if (read.includes(found) || SETTINGS.includes(found)) return [];
    const upper = found.toUpperCase();
    const hint = notForR2(upper, name) ?? meant(upper, isSet, name);
    const what = upper.startsWith("CLOUDROP_") ? "a cloudrop setting" : "a variable the command reads";
    return hint ? [{ status: "note", text: `${found} is not ${what}. ${hint}` }] : [];
  });
}
