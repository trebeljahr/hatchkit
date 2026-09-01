/*
 * Minimal docker-compose introspection.
 *
 * Extracted from deploy/coolify-app.ts so `create`, `adopt` and `sync`
 * all answer "which services does this project actually declare?" the
 * same way. Sync in particular MUST consult this before PATCHing
 * `docker_compose_domains`: Coolify accepts a service name that isn't
 * in the compose with a 200 OK, then emits no Traefik labels for it, so
 * the app's FQDN stays empty and every request 503s. A phantom name is
 * therefore a silent outage, not an error.
 *
 * Deliberately not a YAML parser. We only need top-level service keys
 * and their `ports:` mappings; pulling in a YAML dependency to read two
 * shapes would be a worse trade than an indent-aware line scan that
 * degrades to "unknown" (rather than "wrong") on anything exotic.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Compose filenames Coolify and hatchkit both recognise, in the order
 *  docker compose itself resolves them. */
export const COMPOSE_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

export interface ComposeFile {
  /** Filename relative to the project dir. */
  fileName: string;
  /** Absolute path. */
  path: string;
  /** Top-level keys under `services:`, in declaration order. */
  services: string[];
}

/** Locate and parse the project's compose file. Returns null when
 *  there's no compose on disk, or when it's unreadable / declares no
 *  services — callers must treat null as "unknown", never as "empty",
 *  and skip validation rather than blocking on our parser's limits. */
export function readComposeFile(projectDir: string | undefined): ComposeFile | null {
  if (!projectDir) return null;
  for (const fileName of COMPOSE_FILENAMES) {
    const path = join(projectDir, fileName);
    if (!existsSync(path)) continue;
    let services: string[];
    try {
      services = listComposeServices(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
    if (services.length === 0) return null;
    return { fileName, path, services };
  }
  return null;
}

/** Convenience wrapper: just the service names, or undefined when the
 *  compose couldn't be read. Undefined (not `[]`) is the signal that
 *  callers should fall back to surface-derived defaults. */
export function composeServicesOf(projectDir: string | undefined): string[] | undefined {
  return readComposeFile(projectDir)?.services;
}

/** Extract the top-level service keys from a compose file's contents.
 *  Indent-aware so nested keys (`environment:`, `build:`) can't be
 *  mistaken for services; `x-` extension keys are skipped. */
export function listComposeServices(content: string): string[] {
  const services: string[] = [];
  const lines = content.split(/\r?\n/);
  let servicesIndent = -1;
  let inServices = false;
  let currentServiceIndent = -1;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;

    if (!inServices) {
      if (/^services\s*:/.test(line)) {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }

    if (indent <= servicesIndent) break;

    if (currentServiceIndent === -1 || indent === currentServiceIndent) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*$/);
      if (m && !m[1].startsWith("x-")) {
        currentServiceIndent = indent;
        services.push(m[1]);
      }
    }
  }
  return services;
}

export type ComposeServiceValidation =
  | { ok: true; declaredServices?: string[] }
  | { ok: false; declaredServices: string[]; composeFile: string; missing: string[] };

/** Check that every `names` entry is declared in the project's compose.
 *
 *  `{ ok: true }` when the compose can't be read at all — an unreadable
 *  compose is not evidence of a phantom service, and blocking a deploy
 *  on our parser's limits would be worse than the risk. `{ ok: false }`
 *  carries the declared set so the caller can print a fix-it line. */
export function validateComposeServices(
  projectDir: string | undefined,
  names: string[],
): ComposeServiceValidation {
  const compose = readComposeFile(projectDir);
  if (!compose) return { ok: true };
  const missing = names.filter((n) => !compose.services.includes(n));
  if (missing.length === 0) return { ok: true, declaredServices: compose.services };
  return {
    ok: false,
    declaredServices: compose.services,
    composeFile: compose.fileName,
    missing,
  };
}
