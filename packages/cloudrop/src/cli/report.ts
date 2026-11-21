// One line per finding: a status column, then what was found and what to do. No colour, so output stays readable in
// logs and CI.

import { quotedId } from "../server/bucket-cors.ts";

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

/** `rule "a"`, or "a rule without an ID". */
export const ruleName = (rule: { id?: string }): string =>
  rule.id ? `rule ${quotedId(rule.id)}` : "a rule without an ID";

/** `"a", "b"` for the IDs of rules; a rule without an ID is named as such. */
export const ruleNames = (rules: readonly { id?: string }[]): string =>
  rules.map((rule) => (rule.id ? quotedId(rule.id) : "a rule without an ID")).join(", ");
