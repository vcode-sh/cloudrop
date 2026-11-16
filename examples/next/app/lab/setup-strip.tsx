import { useEffect, useState } from "react";
import type { LabInfo } from "../api/lab-info/route";
import styles from "./lab.module.css";

/** What the strip shows: the route's answer, or words saying it did not come. */
type Shown = Record<keyof LabInfo, string>;

const UNKNOWN: Shown = { storage: "unknown: /api/lab-info did not answer", host: "unknown" };

export function SetupStrip() {
  const [info, setInfo] = useState<Shown | null>(null);

  useEffect(() => {
    fetch("/api/lab-info")
      .then((response) => (response.ok ? (response.json() as Promise<LabInfo>) : UNKNOWN))
      .then(setInfo, () => setInfo(UNKNOWN));
  }, []);

  return (
    <section>
      {/* Demo only: a stand-in for a real sign-in, see app/api/demo-sign-in/route.ts. */}
      <form method="post" action="/api/demo-sign-in?return=lab" className={styles.row}>
        <button type="submit">Sign in as the demo user</button>
        <span className={styles.muted}>Demo only: anyone can sign in as this user.</span>
      </form>
      <dl className={styles.summary}>
        <dt>Storage</dt>
        <dd>{info?.storage ?? "…"}</dd>
        <dt>Storage host</dt>
        <dd>{info?.host ?? "…"}</dd>
      </dl>
      <p className={styles.muted}>
        From /api/lab-info, a demo-only route: a real app has no reason to tell visitors where it stores files.
      </p>
    </section>
  );
}
