// Workers and browsers have no `process`; a guarded read through globalThis keeps the library portable. This is the
// library's only access to the environment.
export function fromEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name] || undefined;
}
