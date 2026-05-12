/*
 * Run ledger — append-only record of what `hatchkit create` accomplished
 * for one project. Persisted as JSON next to the Conf store so it
 * survives crashes and lets us:
 *
 *  1. On failure mid-create, print a tailored cleanup recipe and offer
 *     to undo the steps that did succeed.
 *  2. Drive `hatchkit destroy <project>` later — the same code path,
 *     just without the "should I?" prompt.
 *
 * Steps are recorded *immediately after each external mutation* so a
 * SIGKILL between operations leaves an accurate (though possibly
 * incomplete) ledger. Reverse-order undo is the cleanup strategy.
 *
 * Path: <configDir>/runs/<sanitized-name>.json
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStore } from "../config.js";

/** One unit of mutation we know how to undo.
 *
 *  CRITICAL safety invariant: every kind here describes something
 *  hatchkit (create OR adopt) actually *created*. The undo path is
 *  free to delete the named resource. Code that records into the
 *  ledger MUST NOT record state that pre-existed — otherwise undo
 *  will destroy the user's own data.
 *
 *  The `scaffold` kind in particular is `rm -rf <path>` — only ever
 *  recorded by `hatchkit create` (which generates the project dir
 *  itself). `hatchkit adopt` operates on existing repos and uses
 *  the fine-grained kinds (`manifest`, `dotenvxKeysFile`,
 *  `scaffoldedFile`, `gitInit`) instead — never `scaffold`. */
export type LedgerStep =
  | { kind: "scaffold"; path: string }
  | { kind: "github"; repo: string }
  | { kind: "glitchtip"; project: string }
  | { kind: "openpanel"; project: string }
  | { kind: "resend"; client: string }
  | { kind: "tfvars"; path: string }
  | { kind: "coolifyEnv"; path: string }
  | { kind: "keychain"; account: string }
  | { kind: "terraformApplied"; stackDir: string; tfvarsPath: string }
  | { kind: "coolifyProject"; uuid: string }
  | { kind: "coolifyApp"; uuid: string }
  | { kind: "coolifyDb"; uuid: string }
  /** Coolify private-registry credential entry. Recorded only when
   *  hatchkit was the one that created it (Path B of GHCR setup) so
   *  destroy doesn't yank registry creds the user added by hand for
   *  unrelated apps. */
  | { kind: "coolifyPrivateRegistry"; uuid: string }
  | { kind: "mlService"; platform: string; name: string }
  // Adopt-only kinds — fine-grained file/git removal so undo only
  // touches things adopt itself wrote. Never `rm -rf` anything wider
  // than what these point at.
  | { kind: "manifest"; path: string }
  | { kind: "dotenvxKeysFile"; path: string }
  | { kind: "scaffoldedFile"; path: string }
  | { kind: "gitInit"; path: string }
  /** A GitHub Actions repo-level secret hatchkit pushed via `gh secret
   *  set`. Recorded ONLY when the secret didn't already exist before
   *  this run (probed via `gh secret list`) — so destroy never yanks
   *  a secret the user had set themselves before adopting. */
  | { kind: "ghActionsSecret"; repo: string; name: string }
  /** Cloudflare R2 bucket created by `hatchkit provision s3`. Recorded
   *  only when this run actually created the bucket (createR2Bucket
   *  reports `existed=false`); a pre-existing bucket belongs to the
   *  user. Destroy deletes via the R2 API. */
  | { kind: "r2Bucket"; bucketName: string; accountId: string }
  /** Cloudflare R2 API Token (account-scoped, account-tokens API).
   *  `audience` distinguishes the destroy endpoint:
   *    · "account" → DELETE /accounts/{accountId}/tokens/{tokenId}
   *      (current default — visible in R2 → Manage R2 API Tokens).
   *    · "user"    → DELETE /user/tokens/{tokenId}
   *      (legacy — pre-account-tokens projects we migrate on re-run;
   *      the migration revokes the user-token, but if migration
   *      crashed mid-flight the ledger still has the user-token entry
   *      so destroy can finish the job). */
  | { kind: "r2Token"; tokenId: string; accountId: string; audience: "account" | "user" }
  | {
      kind: "cloudflareDnsRecord";
      zoneId: string;
      recordId: string;
      name: string;
      type: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
    }
  /** Cloudflare Email Routing destination address — verification email
   *  goes out to the user's inbox; this entry is recorded only when
   *  hatchkit *created* the destination this run (an existing one
   *  belongs to the user). Destroy revokes via
   *  `DELETE /accounts/{accountId}/email/routing/addresses/{destinationId}`. */
  | {
      kind: "cloudflareEmailDestination";
      accountId: string;
      destinationId: string;
      email: string;
    }
  /** Cloudflare Email Routing forwarding rule (custom rule, NOT the
   *  catch-all — catch-all has its own endpoint and lives on the zone,
   *  so it's not deletable, only togglable). Recorded with the rule's
   *  id + matching address so destroy can `DELETE /zones/{zoneId}/email/routing/rules/{ruleId}`. */
  | {
      kind: "cloudflareEmailRoutingRule";
      zoneId: string;
      ruleId: string;
      address: string;
    }
  /** GitHub Pages site set up via `hatchkit gh-pages` (or the
   *  create/adopt flows' gh-pages path). Recorded when Pages was
   *  enabled — destroy hands this off to `runPagesUndo`, which
   *  knows how to disable Pages, remove the matching Cloudflare
   *  records, and delete the workflow + CNAME files.
   *
   *  `projectDir` is the absolute path to the project root at
   *  scaffold time. Used by undo to locate the local workflow
   *  + CNAME files; safely no-ops if the dir has since moved or
   *  been deleted (the remote Pages/DNS teardown still runs).
   *  The cname is recorded for diagnostic display only — undo
   *  re-reads the live cname from the Pages API so a manifest-
   *  edited value here can't accidentally nuke a different
   *  domain's DNS records. */
  | { kind: "ghPages"; repo: string; projectDir: string; cname?: string }
  /** Tailscale-served local-dev Caddy fragment dropped at
   *  `~/.config/dev/projects/<slug>.caddy`. Recorded only when the
   *  project opted into the local-dev integration. Destroy removes the
   *  fragment file — host-wide Caddy + tailscale serve stay put (they
   *  belong to the user, not this project). */
  | { kind: "localDevFragment"; slug: string };

export interface LedgerData {
  /** Project slug. Also the filename. */
  name: string;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** Set when `complete()` is called. Absent for in-flight or aborted runs. */
  finishedAt?: string;
  /** Append-only list. */
  steps: LedgerStep[];
}

/** Sanitize project name for use as a filename. Project names are
 *  already validated to be slug-shaped, but belt-and-braces. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function runsDir(): string {
  return join(dirname(getStore().path), "runs");
}

function ledgerPath(name: string): string {
  return join(runsDir(), `${sanitize(name)}.json`);
}

export class RunLedger {
  private constructor(
    private readonly _path: string,
    private data: LedgerData,
  ) {}

  /** Begin a new ledger for this project. Overwrites any prior ledger
   *  for the same name (assumes the caller has already cleaned up). */
  static start(name: string): RunLedger {
    const data: LedgerData = {
      name,
      startedAt: new Date().toISOString(),
      steps: [],
    };
    const path = ledgerPath(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
    return new RunLedger(path, data);
  }

  /** Load the ledger for a project, if one exists. */
  static load(name: string): RunLedger | null {
    const path = ledgerPath(name);
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as LedgerData;
      return new RunLedger(path, data);
    } catch {
      return null;
    }
  }

  /** Resume an existing ledger (preserving recorded steps), or start
   *  a new one. Used by `hatchkit adopt --resume` so a partial first
   *  run's ledger entries survive into the second run — destroy of
   *  the union is then the safe outcome if --resume itself fails.
   *  Clears `finishedAt` so handleAdoptFailure knows we're in flight
   *  again even if the previous attempt called `complete()`. */
  static resumeOrStart(name: string): RunLedger {
    const existing = RunLedger.load(name);
    if (existing) {
      existing.data.finishedAt = undefined;
      existing.flush();
      return existing;
    }
    return RunLedger.start(name);
  }

  /** Append a step and flush immediately. */
  record(step: LedgerStep): void {
    this.data.steps.push(step);
    this.flush();
  }

  /** Mark the run finished. The ledger sticks around so `hatchkit
   *  destroy` can use it later. */
  complete(): void {
    this.data.finishedAt = new Date().toISOString();
    this.flush();
  }

  /** Remove the ledger from disk. Call after a successful rollback. */
  delete(): void {
    if (existsSync(this._path)) unlinkSync(this._path);
  }

  get name(): string {
    return this.data.name;
  }

  get steps(): readonly LedgerStep[] {
    return this.data.steps;
  }

  get startedAt(): string {
    return this.data.startedAt;
  }

  get finishedAt(): string | undefined {
    return this.data.finishedAt;
  }

  get path(): string {
    return this._path;
  }

  private flush(): void {
    writeFileSync(this._path, JSON.stringify(this.data, null, 2));
  }
}
