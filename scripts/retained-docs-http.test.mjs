import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { retainDocsReleases, assetInventoryHash } from './retain-docs-releases.mjs';

test('nginx serves pinned old RSC/chunks, current HTML identity, and real missing/invalid failures', { skip: process.env.RUN_DOCKER_TESTS !== '1' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'docs-http-retention-'));
  const name = `docs-retention-${randomUUID()}`;
  const ids = ['a', 'b', 'c', 'd'].map(x => x.repeat(40));
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let started = false;
  try {
    let previous, bootstrap;
    for (let i = 0; i < ids.length; i++) {
      const current = join(temp, `raw-${i}`);
      await mkdir(join(current, '_next/static/chunks'), { recursive: true });
      await writeFile(join(current, 'version.json'), JSON.stringify({ commit: ids[i] }));
      await writeFile(join(current, 'index.html'), `<head><meta name="build-sha" content="${ids[i]}"></head><body>docs</body>`);
      await writeFile(join(current, 'docs.txt'), `RSC-${ids[i]}`);
      await writeFile(join(current, '_next/static/chunks', `${ids[i]}.js`), `export const revision = '${ids[i]}';`);
      if (i === 0) { previous = current; bootstrap = { sha: ids[0], digest: "sha256:" + "1".repeat(64), inventorySha256: await assetInventoryHash(join(current, "_next/static")) }; }
      else {
        const output = join(temp, `combined-${i}`);
        await retainDocsReleases({ current, previous, output, sha: ids[i], previousSha: ids[i - 1], previousDigest: 'sha256:' + '1'.repeat(64) }, { bootstrap });
        previous = output;
      }
    }
    const config = join(temp, 'site.conf');
    await writeFile(config, await readFile(new URL('../docs/nginx.conf', import.meta.url)));
    docker('create', '--name', name, '--memory=96m', '--cpus=0.5', '-p', '127.0.0.1::80', 'nginx:alpine');
    started = true;
    docker('cp', `${previous}/.`, `${name}:/usr/share/nginx/html`);
    docker('cp', config, `${name}:/etc/nginx/conf.d/default.conf`);
    docker('start', name);
    const address = docker('port', name, '80/tcp');
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const base = `http://${address}`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'nginx fixture ready');
    const html = await fetch(base); assert.match(await html.text(), new RegExp(ids[3]));
    assert.equal((await (await fetch(`${base}/version.json`)).json()).commit, ids[3]);
    for (const id of ids.slice(1)) {
      const rsc = await fetch(`${base}/docs.txt`, { headers: { 'x-deployment-id': id } });
      assert.equal(rsc.status, 200); assert.equal(await rsc.text(), `RSC-${id}`);
      assert.equal(rsc.headers.get('cache-control'), 'no-store');
      assert.equal(rsc.headers.get('vary'), 'x-deployment-id');
      assert.equal(rsc.headers.get('x-nextjs-deployment-id'), id);
      const chunk = await fetch(`${base}/_next/static/chunks/${id}.js`);
      assert.equal(chunk.status, 200); assert.match(await chunk.text(), new RegExp(id));
      assert.match(chunk.headers.get('content-type'), /javascript/);
    }
    assert.equal((await fetch(`${base}/docs.txt`, { headers: { 'x-deployment-id': ids[0] } })).status, 404);
    assert.equal((await fetch(`${base}/_next/static/chunks/${ids[0]}.js`)).status, 200);
    for (const invalid of ['../../etc', `${ids[1]}/..`, 'latest']) assert.equal((await fetch(`${base}/docs.txt`, { headers: { 'x-deployment-id': invalid } })).status, 400);
    assert.equal((await fetch(`${base}/__releases/${ids[1]}/index.html`)).status, 404);
    assert.equal((await fetch(`${base}/__legacy-assets/chunks/${ids[0]}.js`)).status, 404);
    const missing = await fetch(`${base}/_next/static/chunks/missing.js`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /build-sha/);
  } finally {
    if (started) docker('rm', '-f', name);
    await rm(temp, { recursive: true, force: true });
  }
});
