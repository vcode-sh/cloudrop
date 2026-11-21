// A dotenv file, read by the command itself (no dependency) the way Node's --env-file reads one: `NAME=value` lines,
// optionally after `export`. A value in single quotes, double quotes or backticks is taken as written, except that
// `\n` in double quotes is a line break; in an unquoted value, `#` starts a comment. Nothing is expanded or run, and a
// value spans one line: a quote left open is reported by its line number, never by its content.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const QUOTES = new Set(['"', "'", "`"]);

export interface EnvFile {
  values: Record<string, string>;
  /** 1-based numbers of the lines whose value opens a quote it does not close. */
  unclosed: number[];
}

export function parseEnvFile(text: string): EnvFile {
  const values: Record<string, string> = {};
  const unclosed: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const [, name, raw = ""] = LINE.exec(line) ?? [];
    if (name === undefined) return;
    const quote = raw[0] ?? "";
    if (!QUOTES.has(quote)) {
      values[name] = (raw.split("#")[0] ?? "").trimEnd();
      return;
    }
    const end = raw.indexOf(quote, 1);
    if (end === -1) {
      unclosed.push(index + 1);
      return;
    }
    const inner = raw.slice(1, end);
    values[name] = quote === '"' ? inner.replaceAll("\\n", "\n") : inner;
  });
  return { values, unclosed };
}
