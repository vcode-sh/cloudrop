// One line per finding: a status column, then what was found and what to do. No colour, so output stays readable in
// logs and CI.

export type Status = "ok" | "problem" | "unknown" | "note" | "dry run";

export interface Finding {
  status: Status;
  text: string;
}

const LABELS: Record<Status, string> = {
  ok: "ok",
  problem: "PROBLEM",
  unknown: "NOT CHECKED",
  note: "note",
  "dry run": "dry run",
};

/** Where the command writes; process.stdout and process.stderr fit. */
export interface Output {
  write(text: string): unknown;
}

export function printFindings(out: Output, findings: readonly Finding[]): void {
  for (const { status, text } of findings) out.write(`${LABELS[status].padEnd(12)} ${text}\n`);
}

export const count = (findings: readonly Finding[], status: Status): number =>
  findings.filter((finding) => finding.status === status).length;

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// A rule ID comes from the bucket. Control characters in it could drive the terminal (escape sequences) or split a
// finding over two lines, so they are printed as \u escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const quoted = (id: string): string =>
  `"${id.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;

/** `rule "a"`, or "a rule without an ID". */
export const ruleName = (rule: { id?: string }): string =>
  rule.id ? `rule ${quoted(rule.id)}` : "a rule without an ID";

/** `"a", "b"` for the IDs of rules; a rule without an ID is named as such. */
export const ruleNames = (rules: readonly { id?: string }[]): string =>
  rules.map((rule) => (rule.id ? quoted(rule.id) : "a rule without an ID")).join(", ");
