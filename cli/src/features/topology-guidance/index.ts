/*
 * Topology guidance — the generic write-up of why a deployment is split
 * into two applications on two hosts, plus the checks that follow from
 * it.
 *
 * The gap this closes: hatchkit already computes the right routing
 * (deploy/routing.ts) and already refuses to push a phantom service
 * name, but it never told the project WHY any of that shape exists. So
 * the reasoning lived in one project's docs, the next project repeated
 * the same three outages, and every agent that opened a generated
 * repository saw a two-application deployment with no stated reason —
 * which is an invitation to collapse it back into one.
 *
 * What lands in a project: `docs/deploy-topology.md` with the four
 * facts, the failure-symptom table and the verification commands, and a
 * compact section in the project's own `CLAUDE.md` so the reasoning is
 * in the first file anyone reads.
 *
 * The checks are exported separately ({@link topologyAdvice}) so
 * `hatchkit doctor` can run them without writing a byte.
 */

import {
  type OperationalContext,
  type OperationalOutcome,
  applied,
} from "../operational-context.js";
import { recommendedDomainLayout, topologyAdvice } from "./advice.js";
import {
  CLAUDE_MD_BEGIN,
  TOPOLOGY_DOC_REL,
  renderClaudeMdSection,
  renderTopologyDoc,
  upsertClaudeMdSection,
} from "./docs.js";

export {
  inferZone,
  labelsBelowZone,
  normalizeHost,
  pathInDomain,
  recommendedDomainLayout,
  serviceNameFindings,
  splitApiHost,
  topologyAdvice,
} from "./advice.js";
export type {
  DomainAlternative,
  DomainLayout,
  DomainLayoutApp,
  Finding,
  FindingCode,
  FindingSeverity,
  TopologyAdvice,
  TopologyAdviceInput,
} from "./advice.js";
export {
  CLAUDE_MD_BEGIN,
  CLAUDE_MD_END,
  OWNED_FILE_NOTICE,
  TOPOLOGY_DOC_REL,
  renderClaudeMdSection,
  renderTopologyDoc,
  upsertClaudeMdSection,
} from "./docs.js";

/** Write the topology document and retrofit the project's CLAUDE.md.
 *
 *  Two files, two primitives, because the two files belong to different
 *  people:
 *
 *    · `docs/deploy-topology.md` is hatchkit's. It is rendered whole
 *      from the manifest every run, so `writeIfChanged` regenerates it
 *      and reports `unchanged` when the manifest has not moved. The
 *      document carries a header saying it is owned, because overwrite
 *      without notice is the part that surprises people.
 *    · `CLAUDE.md` is the project's. The module owns one region of it
 *      and nothing else, so the edit goes through `ledger.edit` with
 *      {@link upsertClaudeMdSection}, which replaces what is between
 *      its own markers and returns the file UNCHANGED when there is
 *      nowhere sane to put the section. See the header of ./docs.ts for
 *      why this is not `ensureManagedBlock`.
 *
 *  Both are fixed points, so a second apply writes nothing.
 *
 *  The notes carry only what a person still has to do — buy a
 *  certificate, add a DNS record, move a domain, add a heading to a
 *  memory file. Informational findings stay out of them, and so does
 *  anything that merely restates a file the ledger already reported: a
 *  note nobody needs to act on is what teaches people to stop reading
 *  notes. */
export function applyTopologyGuidance(ctx: OperationalContext): OperationalOutcome {
  const notes: string[] = [];

  ctx.ledger.writeIfChanged(TOPOLOGY_DOC_REL, renderTopologyDoc(ctx.project));

  // Read before editing, so the one case that needs a human can be told
  // apart from the two that do not: no CLAUDE.md at all is `absent` and
  // the ledger says so; an up-to-date section is `unchanged`; a memory
  // file with no deployment heading is a file this module deliberately
  // refuses to append to, and only a person can give it an anchor.
  const memory = ctx.ledger.read("CLAUDE.md");
  const section = renderClaudeMdSection(ctx.project);
  if (
    memory !== undefined &&
    !memory.includes(CLAUDE_MD_BEGIN) &&
    upsertClaudeMdSection(memory, section) === memory
  ) {
    notes.push(
      `CLAUDE.md has no deployment section to anchor the topology summary to — add a "## Deployment" heading and re-run, or read ${TOPOLOGY_DOC_REL} instead`,
    );
  }
  ctx.ledger.edit("CLAUDE.md", (content) => upsertClaudeMdSection(content, section));

  const advice = topologyAdvice({
    domain: ctx.project.domain,
    aliases: ctx.project.aliases,
    topology: ctx.project.topology,
    surfaces: ctx.project.surfaces,
  });
  for (const finding of advice.findings) {
    if (finding.severity === "info") continue;
    notes.push(`${finding.message} — ${finding.fix}`);
  }

  const layout = recommendedDomainLayout({
    domain: ctx.project.domain,
    topology: ctx.project.topology,
    surfaces: ctx.project.surfaces,
  });
  if (layout.wildcardTrap) {
    notes.push(
      `Pick one before deploying: ${layout.alternatives.map((a) => a.title).join(", or ")}`,
    );
  }

  return applied(notes);
}
