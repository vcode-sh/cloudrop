// A dotenv file, read by the command itself (no dependency): `NAME=value` lines, optionally after `export`, with the
// value optionally in single or double quotes. Blank lines, comment lines and an unquoted value's ` # comment` are
// ignored; nothing is expanded or executed, and a value spans one line.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const QUOTED = /^(["'])(.*?)\1(?:\s+#.*)?$/;

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const [, name, raw = ""] = LINE.exec(line) ?? [];
    if (name === undefined) continue;
    const quoted = QUOTED.exec(raw);
    values[name] = quoted ? (quoted[2] ?? "") : raw.replace(/\s+#.*$/, "");
  }
  return values;
}
