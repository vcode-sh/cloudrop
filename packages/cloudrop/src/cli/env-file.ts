// A dotenv file, read by the command itself (no dependency) exactly as Node's --env-file reads one: this is Node's own
// parser (src/node_dotenv.cc, Node 24), step for step, and env-file.test.ts compares the two (M11-R112). `NAME=value`
// lines, optionally after `export` and a space. A value in single quotes, double quotes or backticks is taken as
// written and may run over several lines up to its closing quote; `\n` in double quotes is a line break, and a quote
// never closed is kept as written. In an unquoted value, `#` starts a comment. Nothing is expanded or run.
//
// Node's reading is kept where another dotenv reader differs, since the app started with `node --env-file` gets
// Node's: a byte order mark stays in the first name, only a space after `export` counts, a carriage return ends no
// line, and spaces alone after `=` take the next line as the value.

const QUOTES = "\"'`";

/** Node trims a space, a tab and a line break, and nothing else: a no-break space stays. */
const trim = (text: string): string => text.replace(/^[ \t\n]+|[ \t\n]+$/g, "");

/** What follows the first line break at or after `from`. */
function afterLine(text: string, from = 0): string {
  const end = text.indexOf("\n", from);
  return end === -1 ? "" : text.slice(end + 1);
}

interface Step {
  /** The variable this step read, if it read one. */
  entry?: [name: string, value: string];
  /** The text still to read. */
  rest: string;
}

/** The value that starts `content`, which is not empty. */
function readValue(name: string, content: string): Step {
  const quote = content.charAt(0);
  const quoted = QUOTES.includes(quote);
  const closing = quoted ? content.indexOf(quote, 1) : -1;
  if (closing !== -1) {
    const inner = content.slice(1, closing);
    const value = quote === '"' ? inner.replaceAll("\\n", "\n") : inner;
    return { entry: [name, value], rest: afterLine(content, closing + 1) };
  }
  const end = content.indexOf("\n");
  const line = end === -1 ? content : content.slice(0, end);
  const value = quoted ? line : trim(line.split("#")[0] ?? "");
  return { entry: [name, value], rest: end === -1 ? "" : trim(content.slice(end + 1)) };
}

/** One line of `content`, which is not empty: a comment, a line without `=`, or a variable. */
function readLine(content: string): Step {
  if (content.startsWith("\n") || content.startsWith("#")) return { rest: afterLine(content) };
  const cut = content.search(/[=\n]/);
  if (cut === -1) return { rest: "" };
  if (content[cut] === "\n") return { rest: trim(content.slice(cut + 1)) };
  const name = trim(content.slice(0, cut));
  const after = content.slice(cut + 1);
  // Node stores a name with nothing after "=" before it takes "export" off, so `export A=` sets "export A".
  if (after === "" || after.startsWith("\n")) return { entry: [name, ""], rest: after };
  const value = trim(after);
  if (name === "") return { rest: value };
  const exported = name.startsWith("export ") ? trim(name.slice(7)) : name;
  return value === "" ? { entry: [exported, ""], rest: "" } : readValue(exported, value);
}

/** The file's variables; a name given twice keeps its last value. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let rest = trim(text.replaceAll("\r", ""));
  while (rest !== "") {
    const step = readLine(rest);
    if (step.entry) values.set(...step.entry);
    rest = step.rest;
  }
  return values;
}
