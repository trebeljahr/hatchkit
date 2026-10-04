import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, openRegistry, ReleaseError, safeFailure } from './lib/rolling-release.mjs';
import { verifyRelease } from './verify-release.mjs';

import { DOCS_BOOTSTRAP } from "./docs-bootstrap.mjs";
export const INITIAL_ADOPTION = DOCS_BOOTSTRAP;
export function buildBaselineProof(previousDigest, previousSha, started, verified) {
  if (!started && !verified && previousDigest === INITIAL_ADOPTION.digest && previousSha === INITIAL_ADOPTION.sha) return "initial-adoption";
  if (started?.digest !== previousDigest || verified?.digest !== previousDigest) throw new ReleaseError("Build baseline has an unfinished or missing release journal.");
  return "verified-journal";
}

export async function prepareDocsBuild(config, sha, dependencies = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !config.actor || !config.token) throw new ReleaseError('Build requires a full commit and registry credentials.');
  const { manifest, revision } = await openRegistry(config, dependencies);
  // Never rebuild an existing SHA tag with new ancestry or overwrite its bytes.
  if (await manifest(sha, true)) throw new ReleaseError('This SHA image already exists; deploy its recorded digest or create a new commit.');
  const previous = await manifest('latest');
  const previousSha = await revision(previous);
  const check = async () => {
    for (const tag of ['latest', previousSha]) {
      if ((await manifest(tag)).digest !== previous.digest) throw new ReleaseError('Build baseline is not the exact verified serving image.');
    }
    return buildBaselineProof(previous.digest, previousSha, await manifest('rolling-started', true), await manifest('rolling-verified', true));
  };
  const baselineProof = await check();
  await (dependencies.verify ?? verifyRelease)(previousSha);
  if (await check() !== baselineProof) throw new ReleaseError("Build baseline journal changed during verification.");
  return { baselineProof, schema: 1, commit: sha, previousSha, previousDigest: previous.digest, previousImage: `${APP.image}@${previous.digest}`, retainedReleases: 3 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_REPOSITORY !== APP.repository || process.env.GITHUB_REF !== 'refs/heads/main') throw new ReleaseError('Build ancestry only runs from this repository main workflow.');
    const inputs = await prepareDocsBuild({ actor: process.env.GITHUB_ACTOR, token: process.env.GITHUB_TOKEN }, process.env.GITHUB_SHA);
    writeFileSync('build-inputs.json', JSON.stringify(inputs, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `previous_image=${inputs.previousImage}\nprevious_digest=${inputs.previousDigest}\nprevious_sha=${inputs.previousSha}\n`);
    console.log('Verified serving image selected as the retained-asset parent.');
  } catch (error) { console.error(safeFailure(error)); process.exitCode = 1; }
}
