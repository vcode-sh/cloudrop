import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { type Uploads, useStopUploads, useUploads } from "@/lib/upload";

/** Sign-up and sign-in with email and password (a demo: no email is sent), or the signed-in user with sign-out. */
export function AuthPanel({ email }: { email: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const { client } = useUploads();
  const stopUploads = useStopUploads();

  if (email) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span>Signed in as {email}</span>
        <Button variant="outline" size="sm" onClick={() => void signOut(client, stopUploads)}>
          Sign out
        </Button>
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = { email: String(form.get("email")), password: String(form.get("password")) };
    const signingUp = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "sign-up";
    const { error } = signingUp
      ? await authClient.signUp.email({ ...fields, name: fields.email.split("@")[0] ?? fields.email })
      : await authClient.signIn.email(fields);
    setError(error ? (error.message ?? "That did not work. Check the email and password.") : null);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Any email and a password of 8 characters or more. No email is sent.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" minLength={8} required />
          {error && <p role="alert">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" value="sign-in">
              Sign in
            </Button>
            <Button type="submit" value="sign-up" variant="outline">
              Sign up
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Sign-out cancels the user's uploads, then forgets their unfinished ones: the records hold upload tokens, which need
 * not outlive the session on a shared browser (the namespace already hides them from the next user). Cancelling first
 * keeps a file that gets its ticket after forget() from saving a new record. Each cancel's /abort is sent with
 * keepalive, so the reload, which drops the cached queries, does not stop it.
 */
async function signOut(client: Uploads["client"], stopUploads: () => void) {
  stopUploads();
  await client.forget();
  await authClient.signOut();
  window.location.reload();
}
