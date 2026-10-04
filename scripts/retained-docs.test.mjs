import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainDocsReleases } from './retain-docs-releases.mjs';
const ids = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(40));
const digest = 'sha256:' + '1'.repeat(64);
async function exportFixture(root, id) {
  const path = join(root, id);
  await mkdir(join(path, '_next/static/chunks'), { recursive: true });
  await writeFile(join(path, 'version.json'), JSON.stringify({ commit: id }));
  await writeFile(join(path, 'index.html'), `<html><head><meta name="build-sha" content="${id}"></head></html>`);
  await writeFile(join(path, 'docs.txt'), `RSC-${id}`);
  await writeFile(join(path, '_next/static/chunks', `${id}.js`), `window.fixture = '${id}';`);
  return path;
}
test('retains exact old RSC and changed lazy chunks, then prunes outside three releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docs-retention-'));
  try {
    let previous = await exportFixture(root, ids[0]);
    for (let i = 1; i < ids.length; i++) {
      const current = await exportFixture(root, ids[i]);
      const output = join(root, `combined-${i}`);
      const result = await retainDocsReleases({ current, previous, output, sha: ids[i], previousSha: ids[i - 1], previousDigest: digest });
      const expected = ids.slice(Math.max(0, i - 2), i + 1).reverse();
      assert.deepEqual(result.releases, expected);
      assert.equal(JSON.parse(await readFile(join(output, 'version.json'))).commit, ids[i]);
      for (const id of expected) {
        assert.equal(await readFile(join(output, '__releases', id, 'docs.txt'), 'utf8'), `RSC-${id}`);
        assert.equal(await readFile(join(output, '_next/static/chunks', `${id}.js`), 'utf8'), `window.fixture = '${id}';`);
      }
      previous = output;
    }
    await assert.rejects(access(join(previous, '__releases', ids[0])));
    await assert.rejects(access(join(previous, '_next/static/chunks', `${ids[0]}.js`)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects wrong ancestry, injected release paths, symlinks, and immutable path collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docs-retention-bad-'));
  try {
    const previous = await exportFixture(root, ids[0]), current = await exportFixture(root, ids[1]);
    const base = { current, previous, output: join(root, 'output'), sha: ids[1], previousSha: ids[0], previousDigest: digest };
    await assert.rejects(retainDocsReleases({ ...base, previousSha: ids[2] }), /ancestry/);
    await assert.rejects(retainDocsReleases({ ...base, output: join(current, 'nested') }), /outside/);
    await writeFile(join(previous, 'releases.json'), JSON.stringify({ schema: 1, current: ids[0], releases: [ids[0], '../../escape'] }));
    await assert.rejects(retainDocsReleases(base), /metadata/);
    await rm(join(previous, 'releases.json'));
    await symlink('/tmp', join(current, 'escape'));
    await assert.rejects(retainDocsReleases(base), /Symlinks/);
    await rm(join(current, 'escape')); await rm(base.output, { recursive: true });
    await writeFile(join(current, '_next/static/chunks', `${ids[0]}.js`), 'changed bytes behind immutable URL');
    await assert.rejects(retainDocsReleases(base), /collision/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
