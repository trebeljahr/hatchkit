/*
 * cli/src/features/raycast/rename.ts — put the project's own names into the
 * launcher package.
 *
 * Two passes run over every file this feature copies, and they are separate
 * because they own different names:
 *
 *  1. `client-core`'s {@link renameStarterIdentifiers}, for the storage-key
 *     prefix and the handshake headers. Those literals are in the VENDORED
 *     copy of the shared kit, and they have to come out the same here as they
 *     do in `packages/core` — the vendor generator compares the two
 *     byte-for-byte, so a launcher renamed by a different rule would report
 *     the whole vendored tree as stale on the user's first `npm test`.
 *  2. This module, for the names only the launcher has: the store slug, the
 *     publisher placeholder, the device-flow client id, the product name and
 *     the four origins a build bakes in.
 *
 * Nothing is derived. Every replacement comes from `ctx.identifiers` or from
 * the manifest's own domain, topology and ports.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Topology } from "../../deploy/routing.js";
import { clientBuildArgUrls } from "../../scaffold/client-build-args.js";
import type { ProjectIdentifiers } from "../../scaffold/identifiers.js";
import { renameStarterIdentifiersAcross } from "../client-core/index.js";
import {
  RAYCAST_IDENTIFIER_RENAMES,
  RAYCAST_OWNED_PATHS,
  type RaycastRenameTarget,
  isBinaryAsset,
  raycastRootScripts,
} from "./types.js";

/** What the launcher's literals are replaced with, for one project. */
export interface RaycastNames {
  identifiers: ProjectIdentifiers;
  /** The project's public domain, from the manifest. */
  domain: string;
  topology: Topology;
  /** The PINNED dev ports, from the manifest. */
  ports: { server: number; client: number };
}

/** The replacement for one rename. */
function replacementFor(to: RaycastRenameTarget, names: RaycastNames): string {
  const { identifiers: ids } = names;
  switch (to) {
    case "slug":
      return `"${ids.slug}"`;
    // A placeholder stays a placeholder, and deliberately so: the real store
    // handle is a DECISION, passed to the package's own export script, and
    // nothing in the repository may carry a value that could be published by
    // accident. The identifier token is used because it is at least stable
    // and obviously not a person's handle.
    case "authorPlaceholder":
      return `"${ids.token}"`;
    case "raycastClientId":
      return `"${ids.clientIds.raycast}"`;
    case "productName":
      return ids.productName;
    // The same function the web client's build args come from, so the origin
    // the launcher bakes in and the origin the web app is built against
    // cannot disagree.
    case "releaseApiOrigin":
      return clientBuildArgUrls(names.domain, names.topology).apiUrl;
    case "releaseWebOrigin":
      return `https://${names.domain}`;
    case "devApiOrigin":
      return `http://localhost:${names.ports.server}`;
    case "devWebOrigin":
      return `http://localhost:${names.ports.client}`;
  }
}

/** `content` with every launcher-specific literal replaced. */
export function renameRaycastIdentifiers(content: string, names: RaycastNames): string {
  let out = content;
  for (const { from, to } of RAYCAST_IDENTIFIER_RENAMES) {
    out = out.split(from).join(replacementFor(to, names));
  }
  return out;
}

/** Which launcher literals `content` still carries. Empty is fully renamed. */
export function findRaycastIdentifierLiterals(content: string): string[] {
  return RAYCAST_IDENTIFIER_RENAMES.filter(({ from }) => content.includes(from)).map(
    ({ from }) => from,
  );
}

/** The names a manifest supplies. */
export function raycastNamesFrom(
  identifiers: ProjectIdentifiers,
  manifest: {
    domain: string;
    topology?: Topology;
    ports: { server: number; client: number };
  },
): RaycastNames {
  return {
    identifiers,
    domain: manifest.domain,
    topology: manifest.topology ?? "single-origin",
    ports: { server: manifest.ports.server, client: manifest.ports.client },
  };
}

/**
 * Put the project's names into the launcher tree that `create` has already
 * copied, and report what changed.
 *
 * `create` copies the whole starter and subtracts, so by the time this runs
 * every launcher file is already on disk — which is why `applyRaycast` cannot
 * serve the create path: its copy-if-absent loop would find all of them
 * present, keep them, and rename nothing. The update path needs the copy and
 * the create path needs only the rename; this is the create half.
 *
 * Two tables run, and forgetting the second is the failure this function
 * exists to make impossible. `client-core`'s pass owns the storage-key and
 * handshake-header literals, and `src/vendor/` is a byte-for-byte copy of the
 * kit that carries every one of them — a launcher renamed by only its own
 * table would send the STARTER's header names and write the STARTER's storage
 * keys, with no build error and no runtime error, just two projects sharing
 * one launcher's stored credential on a machine that has both.
 */
export function renameRaycastTree(
  projectDir: string,
  ids: ProjectIdentifiers,
  manifest: {
    domain: string;
    topology?: Topology;
    ports: { server: number; client: number };
  },
): string[] {
  const names = raycastNamesFrom(ids, manifest);
  const notesRoot: string[] = [];
  let renamed = 0;

  for (const rel of RAYCAST_OWNED_PATHS) {
    for (const file of launcherFilesUnder(join(projectDir, rel))) {
      // Binary assets carry no literal and must not be read as text: doing so
      // replaces every byte that is not valid UTF-8 with U+FFFD and quietly
      // corrupts the extension icon, which `ray build` then refuses.
      if (isBinaryAsset(file)) continue;
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const next = renameRaycastIdentifiers(content, names);
      if (next === content) continue;
      writeFileSync(file, next, "utf-8");
      renamed += 1;
    }
  }

  // …and the kit's own literals, over the same tree, including `src/vendor/`.
  const kitRenamed = renameStarterIdentifiersAcross(projectDir, ids, RAYCAST_OWNED_PATHS);

  // The ROOT scripts name the launcher package, whose manifest name the pass
  // above has just changed to the project's slug. They are rewritten from the
  // same table `applyRaycast` merges, so a project scaffolded WITH the feature
  // and one that added it later cannot end up with different script bodies —
  // and a `--filter` naming the starter's placeholder would fail with
  // ERR_PNPM_NO_MATCHING_PACKAGE, which reads as a broken template.
  const rootPath = join(projectDir, "package.json");
  if (existsSync(rootPath)) {
    try {
      const pkg = JSON.parse(readFileSync(rootPath, "utf-8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts) {
        const wanted = raycastRootScripts();
        let touched = false;
        for (const [name, body] of Object.entries(wanted)) {
          if (pkg.scripts[name] !== undefined && pkg.scripts[name] !== body) {
            pkg.scripts[name] = body;
            touched = true;
          }
        }
        if (touched) {
          writeFileSync(rootPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
          notesRoot.push("raycast: root scripts retargeted at the launcher's own package name");
        }
      }
    } catch {
      // A root manifest we cannot parse is one we must not rewrite.
    }
  }

  const notes: string[] = [...notesRoot];
  if (renamed > 0) {
    notes.push(`raycast: project identifiers written into ${renamed} file(s)`);
  }
  if (kitRenamed > 0) {
    notes.push(`raycast: client-kit identifiers written into ${kitRenamed} vendored file(s)`);
  }
  return notes;
}

/** Every file beneath `abs`, skipping what is never ours to rewrite. */
function launcherFilesUnder(abs: string): string[] {
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [abs];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    if (entry === "node_modules" || entry === "dist" || entry === "store") continue;
    out.push(...launcherFilesUnder(join(abs, entry)));
  }
  return out;
}
