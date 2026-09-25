/*
 * cli/src/features/operational-context.ts — what the operational layer
 * is, and why it is not a row in the feature registry.
 *
 * ---------------------------------------------------------------------
 * Two different kinds of "feature"
 * ---------------------------------------------------------------------
 *
 * `contract.ts` defines a FEATURE: a unit of scaffolding the user
 * chooses. Its id is a member of the `Feature` union, it appears in two
 * pickers and the `--features` flag, and a project either has it or does
 * not.
 *
 * The seven modules the operational layer applies are not that. Nobody
 * opts into a deploy that can undo itself, or into the docs being
 * indexable, any more than they opt into the project having a
 * `.gitignore`. They are what every deployed project needs in order to
 * be operable, and offering them as choices would mean offering the
 * choice to ship a deploy that cannot roll back — which is not a choice
 * worth having in a picker.
 *
 * So they are applied unconditionally, in a fixed order, and each one
 * decides for itself whether the project it is looking at has anything
 * for it to do (a `static` project has no server to self-host; a
 * `backend` one has no browser tab that can outlive a deploy).
 *
 * ---------------------------------------------------------------------
 * But the mechanism is the same mechanism
 * ---------------------------------------------------------------------
 *
 * Everything in `contract.ts` that is about EDITING A PROJECT SAFELY
 * applies here word for word, and this module reuses it rather than
 * inventing a second answer:
 *
 *   · Every write goes through {@link FeatureLedger}, so `--dry-run` is
 *     handled in one place and a module never asks whether this is a
 *     dry run. When each writer checked its own flag, adding a writer
 *     meant remembering to check, and the ones that forgot were found
 *     by a dry run that changed the user's files.
 *   · The same primitives, weakest first: `writeIfChanged` for a file
 *     the layer owns outright, `ensureManagedBlock` for a region of a
 *     file the user also edits, `ensureLine`, `mergePackageJson`, and
 *     `edit` with a fixed-point transform for anything else.
 *   · The same two invariants — additive, and idempotent. `update`
 *     re-applies the whole layer on every run, so a module that is not
 *     idempotent corrupts a project a little more each time.
 *
 * The ledger is scoped per module (`scopeTo` takes a plain string as
 * well as a `FeatureId`), so one combined run still reports which module
 * wrote what.
 */

import type { Topology } from "../deploy/routing.js";
import type { Surface } from "../prompts.js";
import type { ProjectIdentifiers } from "../scaffold/identifiers.js";
import type { FeatureLedger } from "./contract.js";

/** Stable identifier for one operational module. It is deliberately NOT
 *  a `FeatureId`: these are not selectable, and putting them in that
 *  union would put them in both pickers and the `--features` flag. */
export type OperationalModuleId =
  | "verified-deploy"
  | "topology-guidance"
  | "env-agreement"
  | "self-host"
  | "docs-in-client"
  | "deploy-recovery"
  | "error-reporting";

/**
 * What a module needs to know about the project it is writing into.
 *
 * A narrow projection of the manifest rather than the manifest itself:
 * a module that takes the whole manifest ends up reading fields nobody
 * expected it to depend on, and the tests then have to build a whole
 * manifest to exercise one rule.
 *
 * Names are NOT derived here. Anything that becomes a contract the
 * moment it is stored or published — a bundle id, a storage prefix, an
 * image name — comes from {@link ProjectIdentifiers} on the context.
 * See the header of scaffold/identifiers.ts for what that rule is for.
 */
export interface OperationalProject {
  /** Project name, as the manifest records it. */
  name: string;
  /** Production domain: a bare hostname, no scheme and no path. */
  domain: string;
  /** Additional public hostnames served by the same deployment. */
  aliases?: string[];
  /** How the runtime is spread across platform applications. */
  topology: Topology;
  /** Which halves the project actually has. */
  surfaces: Surface;
  /** Feature flags from the manifest. Modules consult this to decide
   *  whether a surface exists at all — never to decide whether they
   *  themselves apply. */
  features: readonly string[];
  /** `owner/repo`, when known. */
  repoSlug?: string;
}

/** Everything one operational module is handed. Mirrors
 *  {@link import("./contract.js").FeatureContext } deliberately, so a
 *  module that later becomes a real opt-in feature is a small move. */
export interface OperationalContext {
  /** The deployable directory — the same one the ledger is rooted at. */
  projectDir: string;
  project: OperationalProject;
  /** The frozen identifier set. Never derive a name; read it here. */
  identifiers?: ProjectIdentifiers;
  mode: "create" | "update";
  /** Every mutation goes through this. */
  ledger: FeatureLedger;
  /** Progress output, in both real and dry runs. */
  log: (message: string) => void;
  /** Overwrite files the layer owns even when the user has changed
   *  them. Off by default; it is the caller's decision, never a
   *  module's. */
  force?: boolean;
}

/** What a module reports back beyond what the ledger already recorded:
 *  the things only a person can do. The ledger says what changed on
 *  disk; this says what is still owed. */
export interface OperationalOutcome {
  /** Why the module did nothing, when it did nothing. Absent means it
   *  applied. */
  skipped?: string;
  /** One line each: a secret to set, a variable to create once on the
   *  platform, a DNS record to add. */
  notes: string[];
}

/** A module that applied, with nothing left for anyone to do. */
export function applied(notes: string[] = []): OperationalOutcome {
  return { notes };
}

/** A module that had nothing to do here, and why. */
export function skipped(reason: string): OperationalOutcome {
  return { skipped: reason, notes: [] };
}

/** True when the project has a server half a module can talk to. */
export function hasServerHalf(surfaces: Surface): boolean {
  return surfaces !== "static";
}

/** True when the project has a browser half a module can serve. */
export function hasClientHalf(surfaces: Surface): boolean {
  return surfaces !== "backend";
}

/**
 * The default API origin, as an origin with no path.
 *
 * Single-origin projects mount the API under `/api` on the bare domain;
 * split projects give it a host of its own. Every module derives it
 * from here rather than from its own string concatenation — that the
 * places which carry this value all carry the SAME one is the whole
 * point of the env-agreement check, and it cannot check anything if
 * each module computes its own expectation.
 */
export function defaultApiOrigin(domain: string, topology: Topology): string {
  return topology === "split" ? `https://api.${domain}` : `https://${domain}`;
}

/** The default web origin — the domain itself, in both topologies. */
export function defaultWebOrigin(domain: string): string {
  return `https://${domain}`;
}
