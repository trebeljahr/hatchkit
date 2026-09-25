/*
 * cli/src/features/docs-in-client/audit.ts — run every indexing rule over a
 * built docs tree.
 *
 * The testable core of the feature. It takes a file map rather than a
 * directory on purpose: the rules are about CONTENT, the tests want to state
 * a defect in three lines rather than build a Docusaurus site, and the only
 * thing a directory adds is a walk — which the generated script does for
 * itself, because it is the one that has a real tree to look at.
 */

import { DOCS_AUDIT_RULES, type DocsAuditInput, type DocsViolation } from "./rules.js";

export type {
  DocsAuditInput,
  DocsAuditRule,
  DocsViolation,
  DocsViolationCode,
} from "./rules.js";
export { DOCS_AUDIT_RULES, DOCS_VIOLATION_CODES, cleanDocsTree } from "./rules.js";

/** The verdict on one built docs tree. */
export interface DocsAuditResult {
  /** True when the tree may ship. */
  ok: boolean;
  /** Everything wrong with it, rule by rule, in the order the rules run. */
  violations: DocsViolation[];
}

/** Audit a built docs tree against the prefix it will be published under.
 *
 *  Every rule runs — the caller gets the whole list rather than the first
 *  failure, because these defects arrive together. One config that fell back
 *  to a placeholder address produces a noindex on every page, a sitemap that
 *  was never written and a `Disallow: /` robots file at once, and a report
 *  naming only the first sends whoever reads it looking for three bugs. */
export function auditDocsOutput(input: DocsAuditInput): DocsAuditResult {
  const violations = DOCS_AUDIT_RULES.flatMap((rule) => rule.check(input));
  return { ok: violations.length === 0, violations };
}

/** The violations as lines for a terminal: `  - path — detail [code]`.
 *  The code is printed because it is what a bug report and a test refer
 *  to; the prose is what tells the reader what to change. */
export function formatDocsViolations(violations: readonly DocsViolation[]): string {
  return violations.map((v) => `  - ${v.path} ${v.detail} [${v.code}]`).join("\n");
}
