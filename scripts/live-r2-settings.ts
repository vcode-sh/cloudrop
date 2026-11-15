// Pure helpers of the live R2 lane script (scripts/test-live-r2.ts): reading the settings file and redacting output.
// Nothing here prints or returns a value that was read from the file except through the redactor's counterpart.

// The file may use cloudrop's names or BB_R2_* ones; both map to the variables the lane and r2() read.
export const VARIABLES: ReadonlyMap<string, string> = new Map([
  ["ACCOUNT_ID", "CLOUDROP_R2_ACCOUNT_ID"],
  ["BUCKET", "CLOUDROP_R2_BUCKET"],
  ["ACCESS_KEY_ID", "CLOUDROP_R2_ACCESS_KEY_ID"],
  ["SECRET_ACCESS_KEY", "CLOUDROP_R2_SECRET_ACCESS_KEY"],
]);

/** Reads literal `NAME=value` lines. Anything else (`export NAME=...`, spaces around `=`) is ignored, never executed. */
export function parseSettingsFile(text: string): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^(?:CLOUDROP|BB)_R2_([A-Z_]+)=(.*)$/.exec(line.trim());
    const name = match && VARIABLES.get(match[1] ?? "");
    if (match && name) settings[name] = (match[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
  return settings;
}

export type FileState = "none" | "not-found" | "read";

/** One human message for missing settings. It names variables and the file path, never a value. */
export function explainMissing(missing: string[], file: string | undefined, state: FileState): string {
  const names = missing.join(", ");
  if (state === "not-found") {
    return `Missing R2 settings: ${names}. ${file} (from CLOUDROP_R2_ENV_FILE) does not exist. Fix the path or export the variables.`;
  }
  if (state === "read") {
    return `Missing R2 settings: ${names}. ${file} was read but does not define them. The file is read as literal NAME=value lines (no \`export\`, no spaces around \`=\`, no inline comments) with CLOUDROP_R2_* or BB_R2_* names.`;
  }
  return `Missing R2 settings: ${names}. Set CLOUDROP_R2_ENV_FILE to a file that defines them (CLOUDROP_R2_* or BB_R2_* names), or export them.`;
}

// Colour codes (CSI sequences) are removed first, so one in the middle of a value cannot hide it from the matching.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC character is the point.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const PRESIGNED_URL = /https?:\/\/\S*X-Amz-\S*/g;

/** Replaces presigned URLs and every secret (also in lowercase) in a line of output, and counts what it replaced. */
export function createRedactor(values: string[]): { redact: (line: string) => string; count: () => number } {
  // Longest first, so a value that contains another is replaced whole.
  const secrets = [...new Set(values.flatMap((value) => [value, value.toLowerCase()]))]
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length);
  let redactions = 0;
  return {
    redact(line) {
      let out = line.replace(ANSI, "").replace(PRESIGNED_URL, () => {
        redactions++;
        return "<presigned URL>";
      });
      for (const secret of secrets) {
        const parts = out.split(secret);
        redactions += parts.length - 1;
        out = parts.join("<redacted>");
      }
      return out;
    },
    count: () => redactions,
  };
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/** The script's exit code: the child's, but never 0 once the run was interrupted, so a stopped run cannot look green. */
export function exitCodeFor(childCode: number, stopSignal: keyof typeof SIGNAL_NUMBERS | undefined): number {
  return childCode || (stopSignal ? 128 + SIGNAL_NUMBERS[stopSignal] : 0);
}
