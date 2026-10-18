#!/usr/bin/env node
/**
 * Finish the docs export for Cloudflare Workers static assets.
 *
 *   node scripts/docs-worker-files.mjs <out-dir> <commit-sha>
 *
 * Run after `next build`, write-version.mjs and carry-static.mjs. Writes
 * `_headers`, `_redirects` and `releases.json` into <out-dir>, then fails
 * when the upload would break a Workers Free limit or still holds a file
 * only nginx could serve safely.
 *
 * What each file does that the retired nginx image's config did before:
 *
 *   x-nextjs-deployment-id   Next compares this response header with its own
 *     deployment ID on every RSC fetch, and falls back to the Flight body's
 *     build ID, which never equals the deployment ID. Without the header
 *     every client navigation turns into a full page load. nginx echoed the
 *     ID a tab sent and served that release's RSC; an assets-only Worker
 *     cannot read request headers, so this is the current SHA only. A tab of
 *     an earlier release gets current RSC with a different ID, and Next
 *     loads the target page fresh instead of mixing builds.
 *   no-store                 version.json, releases.json and the carry
 *     manifest name the live release; deploy checks and open tabs read them.
 *   Content-Type             opengraph-image and twitter-image are PNGs with
 *     no extension (nginx sent application/octet-stream).
 *   _redirects               `/<page>/` → `/<page>` with 301 for every
 *     exported page, as nginx did. html_handling would answer 307.
 *
 * Nothing marks /_next/static immutable: a `_headers` rule also covers 404
 * responses, and Cloudflare caches those (canary, 2026-10-12), so a chunk
 * that 404s once — mid-deploy, or before a rollback brings it back — would
 * stay broken in that browser for a year. The default (`public, max-age=0,
 * must-revalidate` with an ETag) costs free revalidations only.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Workers Free, https://developers.cloudflare.com/workers/platform/limits/
export const LIMITS = Object.freeze({
	files: 20_000,
	fileBytes: 25 * 1024 * 1024,
	headerRules: 100,
	headerLineChars: 2_000,
	staticRedirects: 2_000,
	redirects: 2_100,
	redirectChars: 1_000,
});

// ReleaseLifetime accepts at most six IDs.
const MAX_RELEASES = 6;
const SHA = /^[a-f0-9]{40}$/;
// Read by wrangler, never uploaded as assets.
const CONFIG_FILES = new Set(["_headers", "_redirects", ".assetsignore"]);
// nginx-only layout: old HTML and RSC that must not become public paths.
const NGINX_ONLY = ["__releases", "__legacy-assets"];
const EXTENSIONLESS_PNG = ["opengraph-image", "twitter-image"];
const NOT_PAGES = new Set(["index.html", "404.html", "_not-found.html"]);

function walk(root) {
	const found = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Symlink in the export: ${relative(root, path)}`);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
		}
	};
	visit(root);
	return found.sort();
}

export function headersFile(commit, files) {
	const rules = [
		["/*", [`x-nextjs-deployment-id: ${commit}`]],
		["/version.json", ["Cache-Control: no-store"]],
		["/releases.json", ["Cache-Control: no-store"]],
		["/release-assets.json", ["Cache-Control: no-store"]],
		...EXTENSIONLESS_PNG.filter((name) => files.includes(name)).map((name) => [`/${name}`, ["Content-Type: image/png"]]),
	];
	return { rules: rules.length, text: rules.map(([path, lines]) => [path, ...lines.map((line) => `  ${line}`)].join("\n")).join("\n") + "\n" };
}

export function redirectsFile(files) {
	const pages = files
		.filter((file) => file.endsWith(".html") && !NOT_PAGES.has(file))
		.map((file) => `/${file.slice(0, -".html".length)}`);
	return { rules: pages.length, text: pages.map((page) => `${page}/ ${page} 301`).join("\n") + (pages.length ? "\n" : "") };
}

/** IDs for ReleaseLifetime: this build first, then the carried releases. */
export function releaseIds(commit, carryManifest) {
	const ids = [commit];
	for (const row of carryManifest?.releases ?? []) {
		// Non-SHA entries (the pre-deployment-ID baseline) carry chunks only.
		if (SHA.test(row?.sha ?? "") && !ids.includes(row.sha)) ids.push(row.sha);
	}
	return ids.slice(0, MAX_RELEASES);
}

export function prepareDocsWorker(out, commit) {
	if (!SHA.test(commit ?? "")) throw new Error("Expected a full lowercase commit SHA.");
	if (!existsSync(out) || !statSync(out).isDirectory()) throw new Error(`No export at ${out}.`);
	for (const dir of NGINX_ONLY)
		if (existsSync(join(out, dir))) throw new Error(`${dir}/ belongs to the nginx image; it would publish old HTML.`);

	const version = JSON.parse(readFileSync(join(out, "version.json"), "utf8"));
	if (version.commit !== commit) throw new Error("version.json names another commit.");
	const home = readFileSync(join(out, "index.html"), "utf8");
	if (!home.includes(`<meta name="build-sha" content="${commit}"`))
		throw new Error("index.html does not carry this build's build-sha meta tag.");
	if (!existsSync(join(out, "404.html"))) throw new Error("No 404.html for not_found_handling.");

	const files = walk(out).filter((file) => !CONFIG_FILES.has(file));
	for (const file of files) {
		// Attributes only: the desktop page quotes the rule itself in prose.
		if (file.endsWith(".html") && /(?:src|href)=["']\.\/_next\//.test(readFileSync(join(out, file), "utf8")))
			throw new Error(`${file} loads relative ./_next assets; they break below the root.`);
	}

	const manifestPath = join(out, "release-assets.json");
	const carry = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
	if (carry && carry.releases?.[0]?.sha !== commit)
		throw new Error("release-assets.json does not list this build first.");
	const releases = releaseIds(commit, carry);
	const releasesJson = { schema: 2, head: commit, window: releases, releases };

	const headers = headersFile(commit, files);
	const redirects = redirectsFile(files);
	const uploadFiles = files.includes("releases.json") ? files.length : files.length + 1;
	const problems = [];
	if (uploadFiles > LIMITS.files) problems.push(`${uploadFiles} files (limit ${LIMITS.files})`);
	for (const file of files) {
		const bytes = statSync(join(out, file)).size;
		if (bytes > LIMITS.fileBytes) problems.push(`${file} is ${bytes} bytes (limit ${LIMITS.fileBytes})`);
	}
	if (headers.rules > LIMITS.headerRules) problems.push(`${headers.rules} _headers rules (limit ${LIMITS.headerRules})`);
	if (headers.text.split("\n").some((line) => line.length > LIMITS.headerLineChars))
		problems.push(`a _headers line is over ${LIMITS.headerLineChars} characters`);
	if (redirects.rules > LIMITS.staticRedirects) problems.push(`${redirects.rules} _redirects rules (limit ${LIMITS.staticRedirects} static)`);
	if (redirects.text.split("\n").some((line) => line.length > LIMITS.redirectChars))
		problems.push(`a _redirects rule is over ${LIMITS.redirectChars} characters`);
	if (problems.length) throw new Error(`Over the Workers Free limits: ${problems.join("; ")}.`);

	writeFileSync(join(out, "_headers"), headers.text);
	writeFileSync(join(out, "_redirects"), redirects.text);
	writeFileSync(join(out, "releases.json"), `${JSON.stringify(releasesJson)}\n`);
	return { commit, releases, files: uploadFiles, headerRules: headers.rules, redirects: redirects.rules };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [out, commit] = process.argv.slice(2);
		console.log(JSON.stringify(prepareDocsWorker(out, commit), null, 2));
	} catch (error) {
		console.error(`docs-worker-files: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}
