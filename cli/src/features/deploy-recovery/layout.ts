/*
 * cli/src/features/deploy-recovery/layout.ts — mounting the recovery
 * component, which is the step that decides whether any of this runs.
 *
 * ---------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------
 *
 * Everything else in this feature is inert on its own. The version
 * watcher, the chunk guard and the error boundaries all hang off
 * `<DeployRecovery />` being rendered; a project that has the files and
 * never mounts the component has a deploy-recovery feature that has
 * never once run, and nothing anywhere says so. It is the quietest
 * possible way for this to be broken, because every file is present and
 * every test of those files passes.
 *
 * So the mount is a retrofit like every other one here, rather than a
 * line in a note somebody is supposed to act on.
 *
 * ---------------------------------------------------------------------
 * Where it goes, and why the default is enough
 * ---------------------------------------------------------------------
 *
 * Directly inside `<body>`, beside whatever else the layout mounts for
 * its own side effects. That is after mount (the component does its work
 * in an effect), and it is above every route, which is what the version
 * check needs — a tab sitting on any screen should learn that its bundle
 * is stale.
 *
 * It is mounted with no `writes` prop, which means the offer is never
 * deferred. That is deliberate and it is the safe direction: with no
 * write tracker the component offers a reload the person can decline,
 * which is exactly what it does with one when nothing is in flight. The
 * note tells them to pass their writes in, and until they do the only
 * thing they lose is the deferral — not the feature.
 *
 * Mounting it INSIDE the providers rather than beside them would let it
 * read those writes from context, but it would also make this transform
 * depend on the shape of whatever provider tree the project happens to
 * have. A retrofit that has to understand the app is a retrofit that
 * half-rewrites somebody's layout, so it stays at the body level and
 * says what it did not do.
 */

import { join, relative } from "node:path";
import type { FeatureLedger } from "../contract.js";

/** The component's own module, relative to the client source root. */
export const RECOVERY_COMPONENT_MODULE = "components/deploy-recovery";

/** Root layout candidates, in the order they are tried. The app router's
 *  is first because it is the one the starter ships. */
export const LAYOUT_CANDIDATES = [
  "app/layout.tsx",
  "app/layout.jsx",
  "pages/_app.tsx",
  "pages/_app.jsx",
] as const;

export interface LayoutMountResult {
  /** The layout after the transform. Identical to the input when
   *  nothing could be done. */
  content: string;
  /** True when the content changed. */
  changed: boolean;
  /** Why nothing changed, when nothing did. `undefined` on success and
   *  on an already-mounted layout. */
  blocked?: string;
}

/**
 * Insert the import and the element into a root layout.
 *
 * Idempotent: a layout that already names the component is returned
 * untouched, whatever shape the existing mount has. Returns the input
 * unchanged, with a reason, when there is no `<body>` to mount into —
 * a hand-rolled layout is safer left alone than half-rewritten, and the
 * reason is what the caller turns into a note.
 */
export function mountRecoveryInLayout(content: string, importSpecifier: string): LayoutMountResult {
  if (/\bDeployRecovery\b/.test(content)) {
    return { content, changed: false };
  }

  // `<body` with its attributes, up to the closing angle bracket of the
  // opening tag. Self-closing is not a case: a body with no children
  // could not have rendered the app in the first place.
  const bodyOpen = /<body(?:\s[^>]*?)?>/;
  const match = content.match(bodyOpen);
  if (match === null || match.index === undefined) {
    return {
      content,
      changed: false,
      blocked: "no <body> element to mount into",
    };
  }

  const withImport = insertImport(content, importSpecifier, match.index);
  const shift = withImport.length - content.length;
  const insertAt = match.index + shift + match[0].length;
  const indent = indentOfNextLine(withImport, insertAt);

  const element =
    `\n${indent}{/* Offers a reload when this tab's bundle is older than the one\n` +
    `${indent}    being served, and recovers a chunk that no longer exists. Pass\n` +
    `${indent}    this app's writes in as \`writes\` so the offer waits for one in\n` +
    `${indent}    flight. Does nothing in development or in a native shell. */}\n` +
    `${indent}<DeployRecovery />`;

  return {
    content: withImport.slice(0, insertAt) + element + withImport.slice(insertAt),
    changed: true,
  };
}

/** Put the import after the last existing one that sits above the body,
 *  so it lands in the import block rather than above a licence header. */
function insertImport(content: string, specifier: string, bodyIndex: number): string {
  const statement = `import { DeployRecovery } from "${specifier}";\n`;
  const importLine = /^import .*?;[ \t]*\r?\n/gm;
  let lastEnd = -1;
  for (const m of content.matchAll(importLine)) {
    if (m.index === undefined || m.index >= bodyIndex) break;
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) return statement + content;
  return content.slice(0, lastEnd) + statement + content.slice(lastEnd);
}

/** The indentation of the line following an offset, so the inserted
 *  element lines up with the layout's existing children. */
function indentOfNextLine(content: string, offset: number): string {
  const rest = content.slice(offset);
  const m = rest.match(/\r?\n([ \t]*)\S/);
  return m ? m[1] : "        ";
}

/**
 * Choose how the layout should refer to the component.
 *
 * A project whose layout already imports through a path alias keeps
 * using it; anything else gets a relative specifier computed from the
 * two files. Guessing an alias a project does not have would produce a
 * layout that does not compile, which is a worse failure than a longer
 * import.
 */
export function recoveryImportSpecifier(
  layoutContent: string,
  layoutRelToSourceRoot: string,
): string {
  const alias = layoutContent.match(/\bfrom\s+["'](@\/|~\/)/);
  if (alias !== null) return `${alias[1]}${RECOVERY_COMPONENT_MODULE}`;
  const fromDir = join(layoutRelToSourceRoot, "..");
  const rel = relative(fromDir, RECOVERY_COMPONENT_MODULE).split("\\").join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Find the project's root layout and mount the component in it.
 *
 * Reports rather than throws for every shape it does not recognise: a
 * project with no layout at all is a perfectly normal static site, and a
 * hand-rolled one is the user's.
 *
 * The write goes through `ledger.edit`, because the root layout is the
 * project's own file and this is an insertion into it rather than a
 * regeneration of it. {@link mountRecoveryInLayout} is a fixed point —
 * a layout that already names the component comes back untouched — so a
 * re-run records `unchanged` instead of mounting a second copy.
 *
 * Returns one line for the caller's notes, always: either what is left
 * for a person to do, or what could not be done and why. What changed on
 * disk is the ledger's account to give.
 */
export function applyLayoutMount(args: {
  ledger: FeatureLedger;
  /** The client source root, relative to the project directory — the
   *  directory the layout candidates are resolved against. */
  sourceRootRel: string;
}): string {
  const { ledger, sourceRootRel } = args;

  for (const candidate of LAYOUT_CANDIDATES) {
    const rel = sourceRootRel === "." ? candidate : `${sourceRootRel}/${candidate}`;
    const before = ledger.read(rel);
    if (before === undefined) continue;

    const outcome = mountRecoveryInLayout(before, recoveryImportSpecifier(before, candidate));
    if (!outcome.changed) {
      if (outcome.blocked !== undefined) {
        return `Mount <DeployRecovery /> in ${rel} yourself — ${outcome.blocked}, so it was left alone`;
      }
      return `<DeployRecovery /> is mounted in ${rel} — pass this app's writes in as \`writes\` so the offer waits for one in flight`;
    }

    // The specifier is recomputed from the content the ledger reads, so
    // the transform depends on nothing but its input.
    ledger.edit(
      rel,
      (content) =>
        mountRecoveryInLayout(content, recoveryImportSpecifier(content, candidate)).content,
    );
    return `<DeployRecovery /> mounted in ${rel} — pass this app's writes in as \`writes\` so the offer waits for one in flight, which it cannot do on its own`;
  }

  const looked = LAYOUT_CANDIDATES.map((c) => `${sourceRootRel}/${c}`).join(", ");
  return `No root layout found (looked for ${looked}) — mount <DeployRecovery /> wherever this app's tree begins, or none of the deploy recovery runs`;
}
