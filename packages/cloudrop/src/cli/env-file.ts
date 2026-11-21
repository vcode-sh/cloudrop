// A dotenv file, read by the command itself (no dependency) the way Node's --env-file reads one: `NAME=value` lines,
// optionally after `export`. A value in single quotes, double quotes or backticks is taken as written and may run over
// several lines up to its closing quote; `\n` in double quotes is a line break, and a quote never closed is kept as
// written (both measured on Node 24.22). In an unquoted value, `#` starts a comment. Nothing is expanded or run.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const QUOTES = new Set(['"', "'", "`"]);

/** The quoted value that starts in `raw` on line `start`, and the last line it uses. */
function quotedValue(lines: readonly string[], start: number, raw: string): { value: string; last: number } {
  const quote = raw[0] ?? "";
  let body = raw.slice(1);
  let last = start;
  let end = body.indexOf(quote);
  while (end === -1 && last + 1 < lines.length) {
    last++;
    body += `\n${lines[last]}`;
    end = body.indexOf(quote);
  }
  if (end === -1) return { value: raw, last: start };
  const inner = body.slice(0, end);
  return { value: quote === '"' ? inner.replaceAll("\\n", "\n") : inner, last };
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const [, name, raw = ""] = LINE.exec(lines[index] ?? "") ?? [];
    if (name === undefined) continue;
    if (!QUOTES.has(raw[0] ?? "")) {
      values[name] = (raw.split("#")[0] ?? "").trimEnd();
      continue;
    }
    const { value, last } = quotedValue(lines, index, raw);
    values[name] = value;
    index = last;
  }
  return values;
}
