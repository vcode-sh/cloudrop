// The settings the command reads, each known by its cloudrop name, and the variable each is read from: that name, or
// the one --var gives it (M11-C1). A message names the variable, never the setting it stands for, so every name in a
// message goes through Settings.name.

import { R2_VARIABLES, S3_VARIABLES } from "../storage/presets.ts";

export type Service = "R2" | "S3";

export const SERVICE_SETTINGS: Record<Service, string[]> = {
  R2: Object.values(R2_VARIABLES),
  S3: Object.values(S3_VARIABLES),
};
export const SECRET = "CLOUDROP_SECRET";
export const SETTINGS: string[] = [...SERVICE_SETTINGS.R2, ...SERVICE_SETTINGS.S3, SECRET];

/** The variable a setting is read from, by the setting's cloudrop name such as CLOUDROP_R2_BUCKET. */
export type NameOf = (setting: string) => string;

export interface Settings {
  name: NameOf;
  /** A setting's value, read from its variable in the environment or the env file. */
  value(setting: string): string | undefined;
}

/** The service's variables when --var renames any of them; undefined while all keep their cloudrop names. */
export function renamed(name: NameOf, service: Service): string[] | undefined {
  const names = SERVICE_SETTINGS[service].map(name);
  return names.some((each, index) => each !== SERVICE_SETTINGS[service][index]) ? names : undefined;
}

/** "a, b and c". Written out so every runtime prints the same text, whatever locale data it ships. */
export const listed = (names: readonly string[]): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** Edit distance between two names. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const replace = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, replace);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The candidate closest to `typed`, ignoring case, when it is at most `edits` edits away. */
export function nearest(typed: string, candidates: readonly string[], edits: number): string | undefined {
  const upper = typed.toUpperCase();
  const scored = candidates.map((candidate) => ({ candidate, score: distance(upper, candidate.toUpperCase()) }));
  const best = scored.sort((a, b) => a.score - b.score)[0];
  return best && best.score <= edits ? best.candidate : undefined;
}
