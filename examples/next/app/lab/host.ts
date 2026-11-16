/** An R2 host starts with the account id; the lab shows its first four characters, enough to tell accounts apart. */
export function displayHost(host: string): string {
  const [, account, rest] = /^([0-9a-f]{32})(\..+)$/.exec(host.toLowerCase()) ?? [];
  return account && rest ? `${account.slice(0, 4)}…${rest}` : host;
}
