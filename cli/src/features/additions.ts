import type { Feature, MlService, Surface } from "../prompts.js";

/** Features that update can layer onto an existing project. Shared with status. */
export const SUPPORTED_ADDITIONS: readonly Feature[] = [
  "workspaces",
  "token-client-auth",
  "desktop",
  "mobile",
  "release",
  "auth-account-security",
  "client-core",
  "extension",
  "server-migrations",
  "scheduler",
  "public-api",
  "i18n",
  "raycast",
  "mcp",
];

export const KNOWN_ML_SERVICES: readonly MlService[] = [
  "3d-sam-objects",
  "3d-sam-body",
  "3d-hunyuan",
  "3d-trellis",
  "3d-extraction",
  "subtitles",
  "image-recognition",
  "background-removal",
  "custom-hf",
];

/** Offer only additions a project's surface can host. Prerequisites are auto-added by update. */
export function additionsForSurface(surface: Surface = "fullstack"): readonly Feature[] {
  if (surface === "static") return ["desktop", "mobile", "release", "i18n"];
  if (surface === "backend")
    return [
      "workspaces",
      "release",
      "auth-account-security",
      "server-migrations",
      "scheduler",
      "public-api",
      "i18n",
    ];
  return SUPPORTED_ADDITIONS;
}
