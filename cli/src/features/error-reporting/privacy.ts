/*
 * cli/src/features/error-reporting/privacy.ts — the privacy-page text
 * for error reports, generated from the allowlist.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * Privacy copy is written once, by hand, on the day reporting is turned
 * on. The code then changes — an SDK upgrade, a new integration, a
 * breadcrumb category someone wanted — and the page does not, because
 * nobody remembers a paragraph on a page nobody visits. The result is a
 * page that makes a promise the product stopped keeping, which is worse
 * than having no page: a user who reads it has been told something
 * untrue about their own data.
 *
 * So the copy is generated from `REPORT_FIELDS` and `REPORT_OMISSIONS`.
 * Every bullet under "A report contains" is one field's own words; every
 * bullet under "never contains" is one omission's, and the tests plant a
 * marker where that omission would live and prove the scrubber removes
 * it. Add a field and the page gains a line. Nothing can be claimed here
 * that is not in the list, because there is nowhere else for a claim to
 * come from.
 *
 * The output is plain text with Markdown headings, so it can be pasted
 * into a privacy page, a docs page or a message. It is public-facing
 * copy: short sentences, active voice, no adjectives that sell.
 */

import type { OperationalProject } from "../operational-context.js";
import {
  REPORT_FIELDS,
  REPORT_OMISSIONS,
  type ReportField,
  type ReportOmission,
} from "./allowlist.js";

/**
 * Who runs the endpoint the reports go to.
 *
 * This is the question that decides whether the page's processor list is
 * still true, and it cannot be answered by reading the code: the same
 * generated client posts to a server the project's owner runs and to one
 * a company runs, and only the second adds a processor. It is therefore
 * asked, not guessed, and left visibly unanswered when nobody answered.
 */
export type EndpointOperator =
  /** The project's owner runs the endpoint — a self-hosted tracker on
   *  their own infrastructure. No other company receives the report. */
  | { kind: "self" }
  /** Someone else runs it. That company is a processor, and the page has
   *  to name it. */
  | { kind: "third-party"; company: string }
  /** Nobody has decided yet. The copy says so in brackets, so the page
   *  cannot be published while the answer is missing. */
  | { kind: "undecided" };

export interface PrivacyCopyOptions {
  /** Who runs the endpoint. Defaults to `undecided`. */
  operator?: EndpointOperator;
  /** The fields a report may carry. Defaults to the real allowlist. */
  fields?: readonly ReportField[];
  /** The things a report never carries. Defaults to the real list. */
  omissions?: readonly ReportOmission[];
}

export interface PrivacyCopy {
  title: string;
  /** When a report is sent at all. */
  when: string;
  containsLead: string;
  /** One line per field, in the field's own words. */
  contains: string[];
  omitsLead: string;
  /** One line per omission, in the omission's own words. */
  omits: string[];
  /** What follows from who runs the endpoint. */
  operator: string[];
  /** The one thing the copy states that the report itself does not carry. */
  ip: string;
  /** True when the operator question is still open, so the caller can
   *  refuse to publish and say why. */
  unresolved: boolean;
  /** Everything above, as Markdown. */
  markdown: string;
}

/** The operator paragraphs. Each case states what the reader gains or
 *  loses by it, because "who runs the server" is the whole difference
 *  between one company holding the data and two. */
function operatorParagraphs(project: OperationalProject, operator: EndpointOperator): string[] {
  if (operator.kind === "self") {
    return [
      `The error tracker runs on infrastructure that the ${project.name} team operates. No other company receives the report.`,
    ];
  }
  if (operator.kind === "third-party") {
    return [
      `${operator.company} runs the error tracker. It receives the report and stores it for ${project.name}. It is a processor, and it is named in the list of processors on this page.`,
    ];
  }
  return [
    '[Decide before publishing: who runs the error tracker this build reports to. An endpoint on infrastructure you operate keeps the sentence "no other company receives data" true. An endpoint run by another company makes that company a processor, and this page has to name it.]',
  ];
}

/**
 * The privacy-page text for error reports.
 *
 * Every sentence is checkable against the generated client code, and the
 * tests check them: the field bullets against `REPORT_FIELDS`, the
 * omission bullets against a scrub of an event that carries each one.
 */
export function renderPrivacyCopy(
  project: OperationalProject,
  options: PrivacyCopyOptions = {},
): PrivacyCopy {
  const fields = options.fields ?? REPORT_FIELDS;
  const omissions = options.omissions ?? REPORT_OMISSIONS;
  const operator = options.operator ?? { kind: "undecided" };

  const copy: Omit<PrivacyCopy, "markdown"> = {
    title: "Error reports",
    when: `When ${project.name} hits an error it did not expect, it sends a report to an error tracker. With no error, nothing is sent.`,
    containsLead: "A report contains:",
    contains: fields.map((field) => field.summary),
    omitsLead: "A report never contains:",
    omits: omissions.map((omission) => omission.summary),
    operator: operatorParagraphs(project, operator),
    ip: "Like every request to the service, a report arrives with your IP address. The report itself does not name it.",
    unresolved: operator.kind === "undecided",
  };

  const lines = [
    `## ${copy.title}`,
    "",
    copy.when,
    "",
    copy.containsLead,
    "",
    ...copy.contains.map((item) => `- ${item}`),
    "",
    copy.omitsLead,
    "",
    ...copy.omits.map((item) => `- ${item}`),
    "",
    ...copy.operator.flatMap((paragraph) => [paragraph, ""]),
    copy.ip,
    "",
  ];

  return { ...copy, markdown: lines.join("\n") };
}
