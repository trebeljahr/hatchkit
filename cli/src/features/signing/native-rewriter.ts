/*
 * cli/src/features/signing/native-rewriter.ts — In-place bundle ID
 * and app-name rewrites against the user's already-scaffolded native
 * configs.
 *
 * Idempotent: each rewriter does GET-then-diff before writing. A file
 * already at the target state is a no-op (rewrittenFiles excludes it).
 *
 * Tolerant of missing files. A desktop-only project lacks ios/ and
 * android/; the rewriters skip those silently. Same for tauri-less
 * mobile projects.
 *
 * Files handled:
 *   · src-tauri/tauri.conf.json     — `identifier`, `productName`
 *   · capacitor.config.ts           — `appId`, `appName`
 *   · android/app/build.gradle      — `namespace`, `applicationId`
 *   · android/app/src/main/res/values/strings.xml
 *                                   — app_name, title_activity_main,
 *                                     package_name, custom_url_scheme
 *   · android/app/src/main/java/<old-pkg>/MainActivity.java
 *                                   — package decl + git mv to new pkg
 *   · ios/App/App.xcodeproj/project.pbxproj — PRODUCT_BUNDLE_IDENTIFIER ×2
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

export interface RewriteInput {
  projectDir: string;
  bundleId: string;
  appName: string;
}

export interface RewriteOutput {
  /** Project-relative paths actually changed this run. */
  rewritten: string[];
  /** Notes that surfaced (e.g. "android/ not present — skipped"). */
  notes: string[];
}

interface FileRewriter {
  /** Project-relative path used both for detection and display. */
  relPath: string;
  /** True if file exists at expected location. */
  applies(projectDir: string): boolean;
  /** Read → rewrite → write if changed. Returns true when the file
   *  was actually modified. */
  apply(projectDir: string, input: RewriteInput): boolean;
}

const tauriConfRewriter: FileRewriter = {
  relPath: "src-tauri/tauri.conf.json",
  applies: (p) => existsSync(join(p, "src-tauri/tauri.conf.json")),
  apply: (p, input) => {
    const path = join(p, "src-tauri/tauri.conf.json");
    const raw = readFileSync(path, "utf-8");
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Not valid JSON — surface as a note via apply returning false.
      return false;
    }
    let changed = false;
    const previousProductName = typeof json.productName === "string" ? json.productName : undefined;
    if (json.identifier !== input.bundleId) {
      json.identifier = input.bundleId;
      changed = true;
    }
    if (json.productName !== input.appName) {
      json.productName = input.appName;
      changed = true;
    }
    // Sync window titles that still match the old productName, leaving
    // user-customized titles untouched. Skip when productName didn't
    // actually change this run — otherwise re-runs flip `changed` true
    // for a no-op assignment.
    const app = (json.app as Record<string, unknown> | undefined) ?? undefined;
    if (
      app &&
      Array.isArray(app.windows) &&
      previousProductName &&
      previousProductName !== input.appName
    ) {
      for (const w of app.windows as Array<Record<string, unknown>>) {
        if (typeof w.title === "string" && w.title === previousProductName) {
          w.title = input.appName;
          changed = true;
        }
      }
    }
    if (!changed) return false;
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n", "utf-8");
    return true;
  },
};

const capacitorConfigRewriter: FileRewriter = {
  relPath: "capacitor.config.ts",
  applies: (p) => existsSync(join(p, "capacitor.config.ts")),
  apply: (p, input) => {
    const path = join(p, "capacitor.config.ts");
    const before = readFileSync(path, "utf-8");
    const after = before
      .replace(/appId:\s*"[^"]+"/g, `appId: "${input.bundleId}"`)
      .replace(/appName:\s*"[^"]+"/g, `appName: "${input.appName}"`);
    if (after === before) return false;
    writeFileSync(path, after, "utf-8");
    return true;
  },
};

const buildGradleRewriter: FileRewriter = {
  relPath: "android/app/build.gradle",
  applies: (p) => existsSync(join(p, "android/app/build.gradle")),
  apply: (p, input) => {
    const path = join(p, "android/app/build.gradle");
    const before = readFileSync(path, "utf-8");
    const after = before
      .replace(/(namespace\s*=?\s*)"([^"]+)"/g, `$1"${input.bundleId}"`)
      .replace(/(applicationId\s*=?\s*)"([^"]+)"/g, `$1"${input.bundleId}"`);
    if (after === before) return false;
    writeFileSync(path, after, "utf-8");
    return true;
  },
};

const stringsXmlRewriter: FileRewriter = {
  relPath: "android/app/src/main/res/values/strings.xml",
  applies: (p) => existsSync(join(p, "android/app/src/main/res/values/strings.xml")),
  apply: (p, input) => {
    const path = join(p, "android/app/src/main/res/values/strings.xml");
    const before = readFileSync(path, "utf-8");
    const after = before
      .replace(
        /<string name="app_name">[^<]*<\/string>/g,
        `<string name="app_name">${xmlEscape(input.appName)}</string>`,
      )
      .replace(
        /<string name="title_activity_main">[^<]*<\/string>/g,
        `<string name="title_activity_main">${xmlEscape(input.appName)}</string>`,
      )
      .replace(
        /<string name="package_name">[^<]*<\/string>/g,
        `<string name="package_name">${input.bundleId}</string>`,
      )
      .replace(
        /<string name="custom_url_scheme">[^<]*<\/string>/g,
        `<string name="custom_url_scheme">${input.bundleId}</string>`,
      );
    if (after === before) return false;
    writeFileSync(path, after, "utf-8");
    return true;
  },
};

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Android MainActivity.java needs both a package-decl rewrite and a
 *  directory move. Capacitor's default path is
 *  `android/app/src/main/java/<org-segments>/MainActivity.java`. */
function rewriteMainActivity(projectDir: string, input: RewriteInput): boolean {
  const javaRoot = join(projectDir, "android/app/src/main/java");
  if (!existsSync(javaRoot)) return false;
  const found = findMainActivity(javaRoot);
  if (!found) return false;
  const newRelDir = input.bundleId.replace(/\./g, "/");
  const newDir = join(javaRoot, newRelDir);
  const newPath = join(newDir, "MainActivity.java");

  // Update package decl in source.
  const before = readFileSync(found.absPath, "utf-8");
  const after = before.replace(/^\s*package\s+[^;]+;/m, `package ${input.bundleId};`);

  // If location already matches and content matches, no-op.
  if (found.absPath === newPath && after === before) return false;

  // Write to new location.
  mkdirSync(newDir, { recursive: true });
  writeFileSync(newPath, after, "utf-8");
  if (found.absPath !== newPath && existsSync(found.absPath)) {
    unlinkSync(found.absPath);
    pruneEmptyDirs(dirname(found.absPath), javaRoot);
  }
  return true;
}

function findMainActivity(root: string): { absPath: string; relDir: string } | null {
  // Walk for any file named MainActivity.java; expect 0 or 1.
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st) continue;
      if (st.isDirectory()) stack.push(abs);
      else if (entry === "MainActivity.java") {
        return { absPath: abs, relDir: relative(root, dir) };
      }
    }
  }
  return null;
}

function pruneEmptyDirs(start: string, stop: string): void {
  let cur = start;
  while (cur && cur !== stop && cur.startsWith(stop)) {
    try {
      const entries = readdirSync(cur);
      if (entries.length === 0) {
        rmdirSync(cur);
        cur = dirname(cur);
      } else {
        return;
      }
    } catch {
      return;
    }
  }
}

const pbxprojRewriter: FileRewriter = {
  relPath: "ios/App/App.xcodeproj/project.pbxproj",
  applies: (p) => existsSync(join(p, "ios/App/App.xcodeproj/project.pbxproj")),
  apply: (p, input) => {
    const path = join(p, "ios/App/App.xcodeproj/project.pbxproj");
    const before = readFileSync(path, "utf-8");
    const after = before.replace(
      /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*[^;]+;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${input.bundleId};`,
    );
    if (after === before) return false;
    writeFileSync(path, after, "utf-8");
    return true;
  },
};

const REWRITERS: FileRewriter[] = [
  tauriConfRewriter,
  capacitorConfigRewriter,
  buildGradleRewriter,
  stringsXmlRewriter,
  pbxprojRewriter,
];

/** Run every applicable rewriter against the project. Each file is
 *  diff-then-apply (idempotent). Returns the union of rewritten files
 *  and per-platform notes. */
export function rewriteNativeConfigs(input: RewriteInput): RewriteOutput {
  const rewritten: string[] = [];
  const notes: string[] = [];

  for (const r of REWRITERS) {
    if (!r.applies(input.projectDir)) {
      notes.push(`skip ${r.relPath} (not present)`);
      continue;
    }
    try {
      if (r.apply(input.projectDir, input)) rewritten.push(r.relPath);
    } catch (err) {
      notes.push(`rewrite ${r.relPath} failed: ${(err as Error).message}`);
    }
  }

  // MainActivity.java rewrite + directory move — handled separately
  // because it touches the filesystem layout.
  if (existsSync(join(input.projectDir, "android/app/src/main/java"))) {
    try {
      if (rewriteMainActivity(input.projectDir, input)) {
        const newRel = `android/app/src/main/java/${input.bundleId.replace(/\./g, "/")}/MainActivity.java`;
        rewritten.push(newRel);
      }
    } catch (err) {
      notes.push(`rewrite MainActivity.java failed: ${(err as Error).message}`);
    }
  } else {
    notes.push("skip MainActivity.java (android/ not present)");
  }

  return { rewritten, notes };
}
