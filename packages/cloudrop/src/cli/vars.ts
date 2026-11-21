// `--var SETTING=NAME`: read a setting from an app's own variable (M11-C1). A pair that cannot work is a usage error
// that says what to type (M11-C2). What follows "=" is echoed only once it is a variable's name: typed by mistake, it
// is the setting's value (M11-C3).

import { nearest, SETTINGS } from "./names.ts";

// A name a shell can expand: the commands the output prints read the bucket as "$NAME".
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A pair for `setting` with a likely name for an app's variable: the setting's own without its prefix. */
const example = (setting: string): string => `--var ${setting}=${setting.replace("CLOUDROP_", "")}`;

function unknownSetting(setting: string, name: string): string {
  const typedIsName = VARIABLE_NAME.test(setting);
  if (typedIsName && SETTINGS.includes(name)) {
    return `--var takes the setting first, then your variable: --var ${name}=${setting}.`;
  }
  const typed = typedIsName ? `"${setting}"` : 'what stands before "="';
  const meant = nearest(/^cloudrop_/i.test(setting) ? setting : `CLOUDROP_${setting}`, SETTINGS, 2);
  const hint = meant ? `Did you mean ${meant}?` : "The settings are listed below.";
  return `--var: ${typed} is not a setting the command reads. ${hint}`;
}

/** Adds one pair to `vars`, the variable of each renamed setting; returns what is wrong with the pair, if anything. */
export function readVar(vars: Map<string, string>, pair: string): string | null {
  const equals = pair.indexOf("=");
  if (equals < 1) {
    return "--var takes SETTING=NAME, a setting and the variable to read it from, such as --var CLOUDROP_R2_BUCKET=R2_BUCKET.";
  }
  const setting = pair.slice(0, equals);
  const name = pair.slice(equals + 1);
  if (!SETTINGS.includes(setting)) return unknownSetting(setting, name);
  if (!VARIABLE_NAME.test(name)) {
    return `--var ${setting} needs the name of the variable that holds it after "=": letters, digits and "_", not starting with a digit, such as ${example(setting)}. Give the variable's name, never its value.`;
  }
  if (vars.has(setting)) return `--var names ${setting} twice. Give each setting one variable.`;
  if (name !== setting && SETTINGS.includes(name)) {
    return `--var cannot read ${setting} from ${name}, which is another setting's own name. Give it a variable of your own, such as ${example(setting)}.`;
  }
  const sharing = [...vars].find(([, taken]) => taken === name)?.[0];
  if (sharing) return `--var reads both ${sharing} and ${setting} from ${name}. Give each setting its own variable.`;
  vars.set(setting, name);
  return null;
}
