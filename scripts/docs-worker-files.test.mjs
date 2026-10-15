import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { headersFile, prepareDocsWorker, redirectsFile, releaseIds } from "./docs-worker-files.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function exportDir(commit = A) {
	const out = mkdtempSync(join(tmpdir(), "docs-worker-"));
	const write = (path, body) => {
		mkdirSync(join(out, path, ".."), { recursive: true });
		writeFileSync(join(out, path), body);
	};
	write("index.html", `<html><head><meta name="build-sha" content="${commit}"/></head></html>`);
	write("404.html", "<html></html>");
	write("_not-found.html", "<html></html>");
	write("docs.html", "<html></html>");
	write("docs/commands.html", `<html><code>"./_next</code></html>`);
	write("docs/commands/__next.docs.$oc$slug.__PAGE__.txt", "rsc");
	write("opengraph-image", "png");
	write("_next/static/chunks/app.js", "js");
	write("version.json", JSON.stringify({ commit }));
	return { out, write };
}

test("headers carry the deployment ID and keep release files uncached", () => {
	const { text, rules } = headersFile(A, ["opengraph-image"]);
	assert.match(text, new RegExp(`^/\\*\\n  x-nextjs-deployment-id: ${A}$`, "m"));
	assert.match(text, /^\/version\.json\n  Cache-Control: no-store$/m);
	assert.match(text, /^\/releases\.json\n  Cache-Control: no-store$/m);
	assert.match(text, /^\/release-assets\.json\n  Cache-Control: no-store$/m);
	assert.match(text, /^\/opengraph-image\n  Content-Type: image\/png$/m);
	assert.doesNotMatch(text, /twitter-image|immutable|_next\/static/);
	assert.equal(rules, 5);
});

test("every exported page answers its slash form with a 301", () => {
	const { text, rules } = redirectsFile(["404.html", "_not-found.html", "docs.html", "docs/commands.html", "index.html", "docs/commands.txt"]);
	assert.equal(text, "/docs/ /docs 301\n/docs/commands/ /docs/commands 301\n");
	assert.equal(rules, 2);
});

test("release IDs list this build, then carried SHAs, at most six", () => {
	assert.deepEqual(releaseIds(A, null), [A]);
	const carried = { releases: [{ sha: A }, { sha: B }, { sha: "legacy-049d17f" }, { sha: C }] };
	assert.deepEqual(releaseIds(A, carried), [A, B, C]);
	const many = { releases: Array.from({ length: 9 }, (_, i) => ({ sha: String(i).repeat(40) })) };
	assert.equal(releaseIds(A, many).length, 6);
});

test("prepare writes all three files for a valid export", () => {
	const { out, write } = exportDir();
	try {
		write("release-assets.json", JSON.stringify({ schema: 1, releases: [{ sha: A, files: [] }, { sha: B, files: [] }] }));
		const summary = prepareDocsWorker(out, A);
		assert.deepEqual(summary.releases, [A, B]);
		assert.equal(summary.redirects, 2);
		assert.deepEqual(JSON.parse(readFileSync(join(out, "releases.json"), "utf8")), { schema: 2, head: A, window: [A, B], releases: [A, B] });
		assert.match(readFileSync(join(out, "_headers"), "utf8"), new RegExp(A));
		// Re-running replaces its own files instead of counting them.
		assert.equal(prepareDocsWorker(out, A).files, summary.files);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("prepare refuses exports that would publish the wrong build or nginx-only trees", () => {
	const cases = [
		[(w) => w("version.json", JSON.stringify({ commit: B })), /version\.json names another commit/],
		[(w) => w("index.html", `<meta name="build-sha" content="${B}"/>`), /build-sha/],
		[(w) => w("__releases/x/index.html", "old"), /__releases/],
		[(w) => w("__legacy-assets/x.js", "old"), /__legacy-assets/],
		[(w) => w("docs/x.html", `<script src="./_next/static/a.js"></script>`), /relative \.\/_next/],
		[(w) => w("release-assets.json", JSON.stringify({ schema: 1, releases: [{ sha: B, files: [] }] })), /this build first/],
	];
	for (const [mutate, error] of cases) {
		const { out, write } = exportDir();
		try {
			mutate(write);
			assert.throws(() => prepareDocsWorker(out, A), error);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}
});

test("prepare enforces the Workers Free file-size limit", () => {
	const { out, write } = exportDir();
	try {
		write("big.bin", Buffer.alloc(25 * 1024 * 1024 + 1));
		assert.throws(() => prepareDocsWorker(out, A), /big\.bin is 26214401 bytes/);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
