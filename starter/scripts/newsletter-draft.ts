#!/usr/bin/env -S npx tsx
/**
 * Helper for staging a campaign as a draft in Listmonk admin — same
 * pipeline as `newsletter-send.ts --draft`, but with `--draft` baked
 * in so you can't accidentally send. Useful when you want a human
 * (or QA) to inspect the rendered HTML in Listmonk's UI before
 * pressing send.
 *
 * Usage:
 *
 *   pnpm tsx scripts/newsletter-draft.ts <html-file> --subject "..." [--name "..."] [--text <text-file>]
 *
 *   NODE_ENV=production pnpm tsx scripts/newsletter-draft.ts …   stages against LISTMONK_LIST_ID
 *
 * Like `newsletter-send.ts`, the list is selected by NODE_ENV — prod
 * targets the real list, anything else targets the test list. No
 * `--confirm` flag because the campaign never leaves draft.
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

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a, i, arr) => {
    if (a.startsWith("--")) return false;
    const prev = arr[i - 1];
    if (prev === "--subject" || prev === "--name" || prev === "--text") return false;
    return true;
  });

  const htmlPath = positional[0];
  const subject = getFlag("subject");

  if (!htmlPath || !subject) {
    console.error("usage: pnpm tsx scripts/newsletter-draft.ts <html-file> --subject '...' [--name '...'] [--text <text-file>]");
    process.exit(1);
  }

  const html = readFileSync(htmlPath, "utf-8");
  const textPath = getFlag("text");
  const text = textPath ? readFileSync(textPath, "utf-8") : "";
  const campaignName = getFlag("name") ?? path.basename(htmlPath).replace(/\.[^.]+$/, "");
  const production = isProductionSend();
  const finalName = production ? campaignName : `[TEST] ${campaignName}`;
  const finalSubject = production ? subject : `[TEST] ${subject}`;

  console.info(`[newsletter] target:  ${describeListTarget()}`);
  console.info(`[newsletter] creating draft campaign…`);
  const result = await sendCampaign({
    name: finalName,
    subject: finalSubject,
    html,
    text,
    draft: true,
  });
  console.info(`[newsletter] campaign id: ${result.id}`);
  console.info(`[newsletter] admin URL:   ${result.url}`);
  console.info(`[newsletter] status:      ${result.status}`);
  console.info(`[newsletter] open the admin URL to review + send.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
