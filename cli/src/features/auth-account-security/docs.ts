/*
 * cli/src/features/auth-account-security/docs.ts — write the answer down
 * where the code is.
 *
 * The table this produces exists because of one recurring failure: a
 * sign-in method is added, it works in the browser, and it silently
 * cannot be completed in the app's own native shell. Nobody finds out
 * until a user reports a form that does nothing, because the shell has no
 * console and the server logs a perfectly ordinary request.
 *
 * So every method carries its verdict, and the verdict travels with the
 * generated project rather than living in a CLI that generated it once.
 */

import { AUTH_SECURITY_SPECS, specFor } from "./options.js";
import type { AuthSecurityOption, AuthSecurityPlan, TokenShellSupport } from "./types.js";

const VERDICT_LABEL: Record<TokenShellSupport, string> = {
  yes: "Yes",
  partial: "Only with extra shell work",
  no: "No — web browsers only",
  "n/a": "Not a sign-in method",
};

export interface AuthSecurityDocsInput {
  projectName: string;
  plan: AuthSecurityPlan;
  hasNativeClient: boolean;
  hasEmailTransport: boolean;
}

/** The generated `docs/account-security.md` for a project. */
export function renderAuthSecurityDocs(input: AuthSecurityDocsInput): string {
  const { plan } = input;
  const methods = plan.options.filter((option) => specFor(option).tokenShell !== "n/a");
  const controls = plan.options.filter((option) => specFor(option).tokenShell === "n/a");

  const lines: string[] = [];

  lines.push(`# Account security`);
  lines.push("");
  lines.push(
    `Sign-in methods and account controls for ${input.projectName}, added by \`hatchkit\`'s`,
    `\`auth-account-security\` feature. Re-run \`hatchkit update\` to add more of it later;`,
    `every step is idempotent and nothing already on disk is overwritten.`,
  );
  lines.push("");

  lines.push(`## What is switched on`);
  lines.push("");
  for (const option of plan.options) {
    const spec = specFor(option);
    lines.push(`- **${spec.label}** — ${spec.summary}`);
  }
  lines.push("");

  // ── The table ────────────────────────────────────────────────────────
  lines.push(`## Can a stored-token client complete these?`);
  lines.push("");
  lines.push(
    `A "stored-token client" is anything that authenticates with a bearer token because it`,
    `cannot use a cookie for the API's origin: a WKWebView or Capacitor shell, an Electron`,
    `renderer on a custom protocol, a browser extension's \`fetch\`. Such a client can neither`,
    `read \`set-cookie\` nor send \`Cookie\`, so any step whose state lives in a cookie is`,
    `unreachable for it.`,
  );
  lines.push("");
  lines.push(
    input.hasNativeClient
      ? `**This project ships a native shell, so this table is about code you are actually running.**`
      : `This project has no native shell today. The table still matters the day one is added —` +
          ` it is a property of each method, not of the current build.`,
  );
  lines.push("");

  if (methods.length === 0) {
    lines.push(`No sign-in methods beyond email and password are enabled.`);
  } else {
    lines.push(`| Method | Works on a stored-token client? |`);
    lines.push(`| --- | --- |`);
    for (const option of methods) {
      const spec = specFor(option);
      lines.push(`| ${spec.label} | ${VERDICT_LABEL[spec.tokenShell]} |`);
    }
    lines.push("");
    lines.push(`### Why, in each case`);
    lines.push("");
    for (const option of methods) {
      const spec = specFor(option);
      lines.push(`**${spec.label} — ${VERDICT_LABEL[spec.tokenShell]}**`);
      lines.push("");
      lines.push(spec.tokenShellNote);
      lines.push("");
    }
  }

  if (controls.length > 0) {
    lines.push(`### Account controls`);
    lines.push("");
    lines.push(
      `These are not sign-in methods, so the question above does not arise for them. Where it`,
      `is worth saying anyway, the reason is given.`,
    );
    lines.push("");
    for (const option of controls) {
      const spec = specFor(option);
      lines.push(`- **${spec.label}** — ${spec.tokenShellNote}`);
    }
    lines.push("");
  }

  // ── Rules that fail quietly ──────────────────────────────────────────
  lines.push(`## Rules that fail quietly if they are broken`);
  lines.push("");
  lines.push(
    `### better-auth plugin order`,
    "",
    `\`packages/server/src/auth/auth.ts\` registers its plugins in this order:`,
    "",
    "```",
    plan.serverPlugins.length > 0 ? plan.serverPlugins.join(" → ") : "(none)",
    "```",
    "",
    `after-hooks run in registration order, and \`bearer()\` emits \`set-auth-token\` for`,
    `whatever session cookie the response carries. Every plugin ahead of it can REPLACE the`,
    `session that sign-in just created — the two-factor hook deletes it outright. Register`,
    `\`bearer()\` first and a token client stores a credential for a session that is deleted a`,
    `moment later: every later request answers 401, the client believes it is signed in, and`,
    `nothing logs a reason. **The CLI's test suite reads the generated \`auth.ts\` and fails on`,
    `a wrong order**, because no runtime test catches it.`,
    "",
  );

  if (plan.options.includes("email-verification")) {
    lines.push(
      `### Email verification, and the backfill`,
      "",
      `\`requireEmailVerification\` follows \`isEmailDeliveryConfigured()\` rather than being`,
      `hardcoded, so a self-host with no transport is not locked out behind a link that only`,
      `reaches the server log.`,
      "",
      `The consequence: **the first deploy that configures mail would refuse every existing`,
      `account**, because every account created while verification was off has`,
      `\`emailVerified: false\`. Run the backfill once, straight after that deploy:`,
      "",
      "```bash",
      `pnpm --filter @starter/server run backfill:email-verified -- --before <deploy-time-iso>`,
      "```",
      "",
      `It is idempotent — it only matches accounts that are not verified yet, and it never`,
      `un-verifies — so a second run reports 0.`,
      "",
      `\`sendVerificationEmail\` lives in the \`emailVerification\` block. Under`,
      `\`emailAndPassword\` better-auth never calls it, and nothing logs that it was skipped.`,
      "",
    );
  }

  if (plan.options.includes("credentials")) {
    lines.push(
      `### Changing a password must not sign the caller out`,
      "",
      `"Sign out other devices" is two requests, not \`changePassword\`'s own`,
      `\`revokeOtherSessions\` flag. That flag deletes THIS session too and issues a new one;`,
      `anything watching sessions then sees this device's own credential revoked and signs the`,
      `app out — every tab of the browser, since they share the new cookie. Calling`,
      `\`changePassword\` without the flag and then \`revokeOtherSessions()\` keeps the current`,
      `session, so the caller's credential never changes.`,
      "",
      `Relatedly: two-factor toggles DO replace the session. \`lib/session-revoked.ts\` asks`,
      `\`getSession\` with the cookie cache disabled before concluding that a closed socket`,
      `means "signed out", and resumes instead when the session turns out to be live.`,
      "",
    );
  }

  if (plan.options.includes("account-deletion")) {
    lines.push(
      `### Deletion converges on a retry`,
      "",
      `Every cascade step is a delete by filter, so a step that already ran matches nothing the`,
      `second time. There is no progress marker and no resume point. That is why a failure in`,
      `\`beforeDelete\` is safe — better-auth stops before removing the user row, and the person`,
      `simply tries again — and why \`afterDelete\` runs the whole cascade a SECOND time: a`,
      `request from another of this person's devices can recreate a row between the two passes.`,
      "",
      `A password account must send its password. better-auth alone would delete on a merely`,
      `fresh session, and a browser session lasts far longer than that.`,
      "",
    );
  }

  if (plan.options.includes("profile-pictures")) {
    lines.push(
      `### Profile-picture bytes are public, at an unguessable address`,
      "",
      `An \`<img>\` sends no bearer token and, cross-origin, no cookie — so the route has to be`,
      `unauthenticated or the picture renders nowhere but the web app. What keeps it private`,
      `enough is the URL: the key is 128 random bits and changes on every upload.`,
      "",
      `The route overrides helmet's \`Cross-Origin-Resource-Policy\` with \`cross-origin\` for`,
      `itself only; without that no other origin can load it at all. The content type comes`,
      `from the bytes, never from the client, and SVG is refused because it can carry script.`,
      "",
      `After an upload the client re-reads the session with the cookie cache disabled —`,
      `\`user.image\` is written through the adapter, so the cached cookie would otherwise serve`,
      `the old user for up to five minutes.`,
      "",
    );
  }

  lines.push(
    `### The \`?next=\` parameter is validated`,
    "",
    `\`packages/client/src/lib/safe-next.ts\` accepts a redirect target only when it is`,
    `unmistakably a path on this origin — exactly one leading slash, no backslash, whitespace`,
    `or control character, still same-origin once parsed, and under an allowlisted prefix.`,
    "",
    `The login page is the page everybody trusts, which is what makes an unvalidated \`next\` a`,
    `working phishing redirect with your own domain in the address bar. \`authPageHref\` also`,
    `DROPS an unsafe value rather than forwarding it, so it cannot survive the hop between`,
    `login and signup — which is how an allowlist actually gets bypassed.`,
    "",
    `Add a screen to \`SAFE_NEXT_PREFIXES\` when it needs a return trip. Do not replace the`,
    `list with a "starts with /" check.`,
    "",
  );

  if (!input.hasEmailTransport && plan.options.some((option) => specFor(option).needsEmail)) {
    lines.push(
      `## No mail transport is configured yet`,
      "",
      `Options that need mail are written but stay switched off at runtime until a transport`,
      `exists. The code decides per request, never at build time, so configuring mail later is`,
      `a redeploy rather than a re-scaffold. Until then, verification links, reset links,`,
      `sign-in codes and magic links are written to the server log — which is the documented`,
      `way back into a self-host whose owner has locked themselves out.`,
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every option's verdict, for the CLI's own `hatchkit explain` output
 *  and for the test that asserts no method ships without an answer. */
export function tokenShellVerdicts(): Array<{
  option: AuthSecurityOption;
  verdict: TokenShellSupport;
  note: string;
}> {
  return Object.values(AUTH_SECURITY_SPECS).map((spec) => ({
    option: spec.id,
    verdict: spec.tokenShell,
    note: spec.tokenShellNote,
  }));
}
