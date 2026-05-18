#!/usr/bin/env -S npx tsx
/**
 * CLI sender for newsletter campaigns. Talks straight to Listmonk —
 * no /api/newsletter/send route, no cron job. Run from a machine
 * that has the decrypted .env.production (your laptop), never the
 * deployed server.
 *
 * Usage:
 *
 *   pnpm tsx scripts/newsletter-send.ts <html-file> --subject "..."           dry-run, prints what would be sent
 *   pnpm tsx scripts/newsletter-send.ts <html-file> --subject "..." --confirm send to LISTMONK_TEST_LIST_ID
 *   NODE_ENV=production pnpm tsx scripts/newsletter-send.ts <html-file> \
 *     --subject "..." --confirm                                               send to LISTMONK_LIST_ID
 *
 * Optional flags:
 *   --name "Internal campaign name"   Defaults to the html file's basename.
 *   --text <text-file>                 Plain-text alternate. Optional but
 *                                      recommended for spam-score reasons.
 *   --draft                            Create in `draft` status so you can
 *                                      review in the Listmonk admin UI
 *                                      before sending manually.
 *
 * The destination list is decided by NODE_ENV, not a flag — production
 * goes to the real subscriber list (LISTMONK_LIST_ID), every other
 * environment goes to the test list (LISTMONK_TEST_LIST_ID) which
 * should only contain your own address. `--confirm` is the dry-run
 * switch; without it the script just describes the would-be send.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  describeListTarget,
  isProductionSend,
  sendCampaign,
} from "../packages/server/src/services/newsletter/listmonk.js";

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a, i, arr) => {
    if (a.startsWith("--")) return false;
    // Drop the value-of-previous-flag positionals.
    const prev = arr[i - 1];
    if (prev === "--subject" || prev === "--name" || prev === "--text") return false;
    return true;
  });

  const htmlPath = positional[0];
  const subject = getFlag("subject");

  if (!htmlPath || !subject) {
    console.error("usage: pnpm tsx scripts/newsletter-send.ts <html-file> --subject '...' [--text <text-file>] [--name '...'] [--draft] [--confirm]");
    console.error("       NODE_ENV=production … --confirm  sends to the real list");
    process.exit(1);
  }

  const html = readFileSync(htmlPath, "utf-8");
  const textPath = getFlag("text");
  const text = textPath ? readFileSync(textPath, "utf-8") : stripHtml(html);
  const campaignName = getFlag("name") ?? path.basename(htmlPath).replace(/\.[^.]+$/, "");
  const production = isProductionSend();
  const draft = hasFlag("draft");

  console.info(`[newsletter] file:      ${htmlPath}`);
  console.info(`[newsletter] subject:   ${subject}`);
  console.info(`[newsletter] name:      ${campaignName}`);
  console.info(`[newsletter] env:       NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);
  console.info(`[newsletter] target:    ${describeListTarget()}`);

  if (!hasFlag("confirm")) {
    console.info(`[newsletter] dry-run — no campaign created.`);
    console.info(`[newsletter] html bytes: ${html.length}`);
    console.info(`[newsletter] text bytes: ${text.length}`);
    console.info(
      production
        ? `[newsletter] pass --confirm to send to the production list.`
        : `[newsletter] pass --confirm to send to the test list. Set NODE_ENV=production to target the real list.`,
    );
    return;
  }

  const finalName = production ? campaignName : `[TEST] ${campaignName}`;
  const finalSubject = production ? subject : `[TEST] ${subject}`;

  console.info(`[newsletter] creating campaign…`);
  const result = await sendCampaign({
    name: finalName,
    subject: finalSubject,
    html,
    text,
    draft,
  });
  console.info(`[newsletter] campaign id: ${result.id}`);
  console.info(`[newsletter] admin URL:   ${result.url}`);
  console.info(`[newsletter] status:      ${result.status}`);
  console.info(`[newsletter] done.`);
}

/** Naive HTML→text fallback for the campaign altbody when no
 *  --text file is supplied. Strips tags, collapses whitespace. Good
 *  enough for the spam-score signal; for a polished plain version,
 *  author one and pass --text. */
function stripHtml(s: string): string {
  return s
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
