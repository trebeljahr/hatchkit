import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "fp-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-fp-${process.pid}`;
const { scaffoldApp } = await import("./src/scaffold/app.js");
const { runUpdate } = await import("./src/scaffold/update.js");
const fp = (dir: string) => { const parts: Record<string, number> = {};
  (function walk(d: string, rel: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else parts[r] = statSync(p).size;
    } })(dir, ""); return parts; };
const d = mkdtempSync(join(tmpdir(), "fp-proj-"));
await scaffoldApp({ name: "up-idem", domain: "up.example.dev", surfaces: "fullstack",
  topology: "single-origin", features: [], mlServices: [], s3Provider: "none",
  deployTarget: "existing", scaffoldRepo: true, envValues: {} } as any, d);
const presets = { desiredFeatures: ["mobile"], enableLocalDev: false, confirmAll: true };
await runUpdate(d, { presets } as any);
const a = fp(d);
await runUpdate(d, { presets } as any);
const b = fp(d);
for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
  if (a[k] !== b[k]) console.log(`  CHANGED ${k}: ${a[k]} -> ${b[k]}`);
rmSync(d, { recursive: true, force: true });
