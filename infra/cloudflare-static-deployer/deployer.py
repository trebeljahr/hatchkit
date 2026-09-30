#!/usr/bin/env python3
"""Trusted, assets-only Worker deployment. Python 3.11+; standard library only.

No archive extraction, project execution, config discovery, or OS keychain access.
The policy and this program must live outside every source project's trust boundary.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime
import hashlib
import fcntl
import io
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
import zlib


class Refused(Exception):
    """Safe diagnostic: never include provider bodies or credential values."""


def require(condition, message):
    if not condition:
        raise Refused(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def integer(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def exact(value, keys, label):
    require(type(value) is dict and set(value) == set(keys.split()), f"Invalid {label} fields")


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    try:
        data = Path(path).read_bytes()
        require(len(data) <= 2_000_000, "JSON input too large")
        return json.loads(data, object_pairs_hook=unique)
    except (ValueError, OSError) as exc:
        raise Refused("Cannot read valid JSON input") from exc


def validate_policy(policy, project):
    exact(policy, "schema trusted_repository_id trusted_branch projects", "policy")
    require(policy["schema"] == 1 and integer(policy["trusted_repository_id"]), "Invalid policy identity")
    require(policy["trusted_branch"] == "main", "Trusted deploy workflow must use main")
    require(type(policy["projects"]) is dict and policy["projects"], "Missing project mappings")
    targets, names, repos = set(), set(), set()
    for key, p in policy["projects"].items():
        require(matches(r"[a-z][a-z0-9-]{0,62}", key), "Invalid project key")
        exact(p, "repository repository_id branch workflow artifact account_id worker_id worker_name compatibility_date not_found_handling limits", "project")
        require(matches(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", p["repository"]), "Invalid repository")
        require(integer(p["repository_id"]), "Invalid source repository ID")
        require(p["repository_id"] != policy["trusted_repository_id"], "Source and trusted repositories must differ")
        require(p["branch"] == "main", "Source branch must be main")
        require(matches(r"\.github/workflows/[A-Za-z0-9_-]+\.ya?ml", p["workflow"]), "Invalid build workflow")
        require(matches(r"[A-Za-z][A-Za-z0-9_-]{0,99}", p["artifact"]), "Invalid artifact name")
        require(all(matches(r"[a-f0-9]{32}", p[k]) for k in ("account_id", "worker_id")), "Invalid provider IDs")
        require(matches(r"[a-z0-9][a-z0-9-]{0,62}", p["worker_name"]), "Invalid Worker name")
        require(matches(r"20\d{2}-\d{2}-\d{2}", p["compatibility_date"]), "Invalid compatibility date")
        require(p["not_found_handling"] in ("none", "404-page"), "Unsupported missing-page mode")
        exact(p["limits"], "archive_bytes expanded_bytes file_bytes files entries ratio", "limits")
        ceilings = {"archive_bytes": 256*1024*1024, "expanded_bytes": 256*1024*1024,
                    "file_bytes": 25*1024*1024, "files": 20000, "entries": 40000, "ratio": 1000}
        require(all(integer(v) and v <= ceilings[k] for k, v in p["limits"].items()), "Invalid or excessive archive budget")
        require(p["limits"]["files"] <= p["limits"]["entries"], "Invalid entry budget")
        require(p["limits"]["file_bytes"] <= p["limits"]["expanded_bytes"], "Invalid file budget")
        target = (p["account_id"], p["worker_id"])
        require(target not in targets and (p["account_id"], p["worker_name"]) not in names and p["repository_id"] not in repos, "Duplicate project target or source")
        names.add((p["account_id"], p["worker_name"]))
        targets.add(target)
        repos.add(p["repository_id"])
    require(project in policy["projects"], "Project is not allowlisted")
    return policy["projects"][project]


def timestamp(value):
    require(matches(r"20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value), "Missing or invalid artifact/run timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Refused("Invalid artifact/run timestamp") from exc


def verify_origin(p, run, artifact, run_id, attempt, artifact_id, head_sha):
    require(all(integer(n) for n in (run_id, attempt, artifact_id)), "Invalid requested run identity")
    require(matches(r"[a-f0-9]{40}", head_sha), "Invalid branch head")
    require(type(run) is dict and type(artifact) is dict, "Invalid source metadata")
    require(run.get("id") == run_id and run.get("run_attempt") == attempt, "Run or attempt changed")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Build did not succeed")
    require(run.get("event") in ("push", "workflow_dispatch"), "Untrusted build event")
    require(run.get("head_branch") == p["branch"] and run.get("head_sha") == head_sha, "Build is not current main")
    require(run.get("path") in (p["workflow"], p["workflow"]+"@main", p["workflow"]+"@refs/heads/main"), "Unexpected build workflow")
    for key in ("repository", "head_repository"):
        repo = run.get(key, {})
        require(type(repo) is dict and repo.get("id") == p["repository_id"] and repo.get("full_name") == p["repository"], "Foreign or fork repository")
    require(artifact.get("id") == artifact_id and artifact.get("name") == f'{p["artifact"]}-{attempt}', "Artifact identity mismatch")
    require(timestamp(run.get("run_started_at")) <= timestamp(artifact.get("created_at")) <= timestamp(run.get("updated_at")), "Artifact predates this attempt or follows completion")
    require(artifact.get("expired") is False, "Artifact is expired or unverifiable")
    require(integer(artifact.get("size_in_bytes")) and artifact["size_in_bytes"] <= p["limits"]["archive_bytes"], "Artifact exceeds archive budget")
    require(matches(r"sha256:[a-f0-9]{64}", artifact.get("digest")), "Artifact digest is missing")
    origin = artifact.get("workflow_run", {})
    require(type(origin) is dict and origin.get("id") == run_id
            and origin.get("repository_id") == p["repository_id"]
            and origin.get("head_repository_id") == p["repository_id"]
            and origin.get("head_branch") == p["branch"] and origin.get("head_sha") == head_sha,
            "Artifact does not belong to the approved build")


def safe_path(name):
    require(isinstance(name, str) and 0 < len(name.encode("utf-8")) <= 1024, "Invalid asset path length")
    require(name == unicodedata.normalize("NFC", name), "Noncanonical Unicode path")
    require(not any(unicodedata.category(c).startswith("C") for c in name), "Control character in asset path")
    require(not any(c in name for c in "\\:%?#") and not name.startswith("/"), "Ambiguous or absolute asset path")
    parts = name.rstrip("/").split("/")
    require(len(parts) <= 24 and all(x and x not in (".", "..") and x == x.rstrip(". ") for x in parts), "Unsafe asset path")
    for part in parts:
        low = part.casefold()
        require(not re.fullmatch(r"(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", low), "Reserved path")
        require(low not in (".git", "node_modules", ".github", "__pycache__") and not low.startswith(".env"), "Private/configuration file in artifact")
    require(parts[-1].casefold() not in ("wrangler.json", "wrangler.jsonc", "wrangler.toml", "package.json", "package-lock.json", "pnpm-lock.yaml", "_worker.js", "_routes.json", "_headers", "_redirects"), "Executable/configuration control file is unsupported")
    return "/".join(parts)


def inspect_archive(data, digest, limits):
    """Keep files in bounded memory; never extract an attacker-controlled path."""
    require(isinstance(data, bytes) and 0 < len(data) <= limits["archive_bytes"], "Archive size exceeds budget")
    require("sha256:" + sha256(data) == digest, "Archive digest mismatch")
    # Bound central-directory allocation before ZipFile constructs ZipInfo objects.
    eocd = data.rfind(b"PK\x05\x06", max(0, len(data)-65557))
    require(eocd >= 0 and len(data)-eocd >= 22, "Missing ZIP directory")
    _, disk, cd_disk, disk_entries, entries, cd_size, cd_offset, comment = struct.unpack_from("<4s4H2LH", data, eocd)
    require(disk == cd_disk == 0 and disk_entries == entries and 0 < entries <= limits["entries"], "Split, empty or oversized ZIP directory")
    require(entries != 65535 and cd_size != 0xffffffff and cd_offset != 0xffffffff, "ZIP64 is unsupported")
    require(eocd + 22 + comment == len(data) and cd_offset + cd_size == eocd, "Ambiguous ZIP layout")
    files, paths, total = {}, {}, 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            require(len(z.infolist()) == entries, "ZIP entry count mismatch")
            # Validate every descriptor before decompressing any bytes.
            for entry in z.infolist():
                require(entry.orig_filename == entry.filename, "NUL or altered ZIP name")
                name = safe_path(entry.filename)
                require(entry.flag_bits & ~(0x800 | 0x8 | 0x6) == 0, "Encrypted or unsupported ZIP flags")
                require(entry.flag_bits & 0x800 or entry.filename.isascii(), "Non-UTF8 ZIP path")
                require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "Unsupported compression")
                require(entry.create_system in (0, 3), "Unsupported ZIP creator")
                mode = entry.external_attr >> 16
                kind = stat.S_IFMT(mode)
                require(kind in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG), "Link or special file in archive")
                require(not (entry.external_attr & 0x400), "ZIP reparse point")
                extra = entry.extra
                while extra:
                    require(len(extra) >= 4, "Malformed ZIP extra field")
                    field, size = struct.unpack_from("<HH", extra)
                    require(size <= len(extra)-4 and field in (0x5455, 0x7875), "Unsupported ZIP extra field")
                    extra = extra[4+size:]
                folded = name.casefold()
                require(folded not in paths, "Duplicate or case-colliding asset path")
                paths[folded] = entry.is_dir()
                if entry.is_dir():
                    require(entry.file_size == 0, "Directory contains data")
                else:
                    require(entry.file_size <= limits["file_bytes"], "Asset exceeds file budget")
                    require(entry.file_size <= max(1, entry.compress_size) * limits["ratio"], "Compression ratio exceeds budget")
                    total += entry.file_size
                    require(total <= limits["expanded_bytes"], "Expanded archive exceeds budget")
            for name, is_dir in paths.items():
                parents = name.split("/")[:-1]
                require(all(paths.get("/".join(parents[:n])) is not False for n in range(1, len(parents)+1)), "File/directory path collision")
            require(sum(not d for d in paths.values()) <= limits["files"], "Too many asset files")
            for entry in z.infolist():
                if entry.is_dir():
                    continue
                with z.open(entry) as source:
                    content = source.read(min(limits["file_bytes"], entry.file_size) + 1)
                    require(len(content) == entry.file_size and source.read(1) == b"", "Asset size mismatch")
                files[safe_path(entry.filename)] = content
    except (zipfile.BadZipFile, zlib.error, RuntimeError, NotImplementedError, EOFError, ValueError) as exc:
        raise Refused("Invalid ZIP archive") from exc
    require("index.html" in files, "Missing index.html")
    return files


def prepare(policy, project, run, artifact, data, run_id, attempt, artifact_id, head_sha):
    p = validate_policy(policy, project)
    verify_origin(p, run, artifact, run_id, attempt, artifact_id, head_sha)
    files = inspect_archive(data, artifact["digest"], p["limits"])
    require(p["not_found_handling"] != "404-page" or "404.html" in files, "Missing required 404.html")
    manifest = {name: {"sha256": sha256(value), "bytes": len(value)} for name, value in sorted(files.items())}
    receipt = {"schema": 1, "project": project, "policy_digest": sha256(canonical(policy)),
               "repository_id": p["repository_id"], "run_id": run_id, "run_attempt": attempt,
               "artifact_id": artifact_id, "artifact_digest": artifact["digest"], "head_sha": head_sha,
               "account_id": p["account_id"], "worker_id": p["worker_id"], "worker_name": p["worker_name"],
               "files_digest": sha256(canonical(manifest)), "file_count": len(files),
               "expanded_bytes": sum(len(b) for b in files.values())}
    return receipt, files


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HTTP:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, url, token=None, method="GET", body=None, content_type=None, limit=2_000_000):
        require(urllib.parse.urlsplit(url).scheme == "https", "HTTPS required")
        headers = {"User-Agent": "hatchkit-static-deployer", "Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if content_type:
            headers["Content-Type"] = content_type
        if url.startswith("https://api.github.com/"):
            headers["X-GitHub-Api-Version"] = "2022-11-28"
        try:
            response = self.opener.open(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=30)
        except urllib.error.HTTPError as exc:
            if exc.code == 302 and method == "GET" and url.startswith("https://api.github.com/"):
                return 302, {"location": exc.headers.get("Location", "")}, b""
            raise Refused(f"Provider request failed (HTTP {exc.code})") from None
        except (OSError, ValueError) as exc:
            raise Refused("Provider request failed; outcome may be unknown") from exc
        with response:
            chunks, length, deadline = [], 0, time.monotonic() + 120
            while True:
                require(time.monotonic() <= deadline, "Provider response deadline exceeded")
                chunk = response.read(min(65536, limit-length+1))
                if not chunk:
                    break
                length += len(chunk)
                require(length <= limit, "Provider response exceeds budget")
                chunks.append(chunk)
            return response.status, dict(response.headers), b"".join(chunks)

    def json(self, url, token=None, method="GET", body=None):
        _, _, data = self.request(url, token, method, canonical(body) if body is not None else None,
                                  "application/json" if body is not None else None)
        try:
            value = json.loads(data)
        except ValueError as exc:
            raise Refused("Invalid provider JSON response") from exc
        require(type(value) is dict, "Invalid provider response")
        return value


def fetch_build(http, policy, project, run_id, attempt, artifact_id, token):
    p = validate_policy(policy, project)
    require(all(integer(x) for x in (run_id, attempt, artifact_id)), "Invalid build identity")
    prefix = "https://api.github.com/repos/" + p["repository"]
    head = http.json(prefix + "/git/ref/heads/" + p["branch"], token)
    head_sha = head.get("object", {}).get("sha")
    run = http.json(prefix + f"/actions/runs/{run_id}", token)
    artifact = http.json(prefix + f"/actions/artifacts/{artifact_id}", token)
    verify_origin(p, run, artifact, run_id, attempt, artifact_id, head_sha)
    # Reject ambiguous artifact names, including leftovers from earlier attempts.
    found = []
    for page in range(1, 101):
        listing = http.json(prefix + f"/actions/runs/{run_id}/artifacts?per_page=100&page={page}", token)
        rows = listing.get("artifacts")
        require(isinstance(rows, list), "Invalid artifact listing")
        found.extend(a.get("id") for a in rows if a.get("name") == f'{p["artifact"]}-{attempt}')
        if len(rows) < 100:
            break
    else:
        raise Refused("Artifact pagination exceeded limit")
    require(found == [artifact_id], "Ambiguous build artifact")
    status, headers, data = http.request(prefix + f"/actions/artifacts/{artifact_id}/zip", token, limit=p["limits"]["archive_bytes"])
    if status == 302:
        location = headers["location"]
        parsed = urllib.parse.urlsplit(location)
        require(parsed.scheme == "https" and not parsed.username and not parsed.password and parsed.port in (None, 443)
                and parsed.hostname is not None and any(parsed.hostname.endswith(s) for s in
                    (".blob.core.windows.net", ".actions.githubusercontent.com")), "Unapproved artifact download host")
        # Never forward GitHub credentials to the signed download URL.
        status, _, data = http.request(location, limit=p["limits"]["archive_bytes"])
    require(status == 200, "Artifact download failed")
    receipt, files = prepare(policy, project, run, artifact, data, run_id, attempt, artifact_id, head_sha)
    # Catch reruns or branch advancement during download, before any provider write.
    latest = http.json(prefix + f"/actions/runs/{run_id}", token)
    final_head = http.json(prefix + "/git/ref/heads/" + p["branch"], token).get("object", {}).get("sha")
    verify_origin(p, latest, artifact, run_id, attempt, artifact_id, final_head)
    return receipt, files


def multipart(parts):
    boundary = "hatchkit-" + uuid.uuid4().hex
    body = bytearray()
    for name, data, mime in parts:
        require(matches(r"[a-zA-Z0-9_-]+", name), "Invalid multipart field")
        filename = "" if name == "metadata" else f'; filename="{name}"'
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"{filename}\r\nContent-Type: {mime}\r\n\r\n'.encode())
        body.extend(data)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), "multipart/form-data; boundary=" + boundary


def cf_hash(path, data):
    extension = PurePosixPath(path).suffix.lstrip(".")
    return sha256(base64.b64encode(data) + extension.encode())[:32]


def content_type(path):
    # Deterministic essential overrides; never read MIME config from an artifact.
    overrides = {".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css",
                 ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm"}
    return overrides.get(PurePosixPath(path).suffix.lower()) or mimetypes.guess_type(path)[0] or "application/octet-stream"


class Cloudflare:
    def __init__(self, http, p, token):
        self.http, self.p, self.token = http, p, token
        self.base = "https://api.cloudflare.com/client/v4/accounts/" + p["account_id"]
        self.script = "/workers/scripts/" + p["worker_name"]

    def api(self, path, method="GET", body=None, multipart_parts=None, token=None):
        # Mutation allowlist cannot address any target supplied by an artifact.
        allowed = {( "POST", self.script + "/assets-upload-session"),
                   ("POST", "/workers/assets/upload?base64=true"), ("PUT", self.script)}
        require(method == "GET" or (method, path) in allowed, "Forbidden provider mutation")
        if multipart_parts is None:
            result = self.http.json(self.base + path, token or self.token, method, body)
        else:
            payload, mime = multipart(multipart_parts)
            _, _, raw = self.http.request(self.base + path, token or self.token, method, payload, mime)
            try:
                result = json.loads(raw)
            except ValueError as exc:
                raise Refused("Invalid upload response") from exc
        require(type(result) is dict and result.get("success") is True and "result" in result, "Cloudflare operation refused")
        return result["result"]

    def current(self):
        worker = self.api("/workers/workers/" + self.p["worker_id"])
        require(worker.get("id") == self.p["worker_id"] and worker.get("name") == self.p["worker_name"], "Worker ownership changed")
        deployments = self.api(self.script + "/deployments").get("deployments", [])
        require(bool(deployments), "No deployment to compare")
        versions = deployments[0].get("versions", [])
        require(len(versions) == 1 and versions[0].get("percentage") == 100, "Gradual/ambiguous deployment is unsupported")
        version = versions[0].get("version_id")
        require(matches(r"[a-f0-9-]{36}", version), "Invalid current version ID")
        details = self.api(self.script + "/versions/" + version)
        require(details.get("id") == version, "Version identity changed")
        resources = details.get("resources", {})
        require(resources.get("bindings") in ([], {}), "Existing bindings or unverified bindings")
        script = resources.get("script")
        require(script is None or (type(script) is dict and not script.get("etag") and script.get("handlers") == [] and script.get("named_handlers", []) == []), "Existing server code or unverified handlers")
        runtime = resources.get("script_runtime", {})
        require(not runtime.get("exports") and not runtime.get("migration_tag") and not runtime.get("compatibility_flags"), "Existing exports, migrations or runtime flags")
        settings = self.api(self.script + "/settings")
        require(settings.get("bindings") == [] and not settings.get("tail_consumers") and not settings.get("logpush"), "Unexpected Worker settings")
        schedules = self.api(self.script + "/schedules")
        require(schedules.get("schedules") == [], "Existing schedules or unverified schedules")
        return version, settings

    def upload(self, files, journal):
        manifest, by_hash = {}, {}
        for path, data in sorted(files.items()):
            digest = cf_hash(path, data)
            if digest in by_hash:
                require(by_hash[digest][1] == data and content_type(by_hash[digest][0]) == content_type(path), "Ambiguous provider asset hash")
            by_hash[digest] = (path, data)
            manifest["/" + path] = {"hash": digest, "size": len(data)}
        journal("uploading")
        session = self.api(self.script + "/assets-upload-session", "POST", {"manifest": manifest})
        jwt, buckets = session.get("jwt"), session.get("buckets")
        require(isinstance(jwt, str) and jwt and isinstance(buckets, list), "Invalid asset upload session")
        requested = [h for b in buckets if isinstance(b, list) for h in b]
        require(all(isinstance(b, list) and b for b in buckets) and all(isinstance(h, str) and h in by_hash for h in requested)
                and len(set(requested)) == len(requested), "Unexpected requested asset hashes")
        completion = jwt if not buckets else None
        for bucket in buckets:
            parts = [(h, base64.b64encode(by_hash[h][1]), content_type(by_hash[h][0])) for h in bucket]
            result = self.api("/workers/assets/upload?base64=true", "POST", multipart_parts=parts, token=jwt)
            if result.get("jwt"):
                completion = result["jwt"]
        require(isinstance(completion, str) and completion, "Missing asset completion token")
        return completion

    def publish(self, completion):
        # Construct afresh; never merge project/receipt/provider dictionaries here.
        metadata = {"compatibility_date": self.p["compatibility_date"], "bindings": [],
                    "assets": {"jwt": completion, "config": {"html_handling": "auto-trailing-slash",
                              "not_found_handling": self.p["not_found_handling"], "run_worker_first": False}},
                    "keep_bindings": [], "keep_assets": False}
        return self.api(self.script, "PUT", multipart_parts=[("metadata", canonical(metadata), "application/json")])


def deploy(cf, receipt, files, approved, expected_version, journal, source_check):
    require(receipt == approved, "Validated artifact differs from approved receipt")
    require(matches(r"[a-f0-9-]{36}", expected_version), "Expected current version is required")
    previous, _ = cf.current()
    require(previous == expected_version, "Current deployment changed; re-review")
    completion = cf.upload(files, journal)
    require(cf.current()[0] == previous, "Deployment changed during upload")
    source_check()
    journal("deploying", previous_version=previous)
    result = cf.publish(completion)
    version = result.get("version_id")
    journal("deployed-unverified", previous_version=previous)
    require(matches(r"[a-f0-9-]{36}", version) and version != previous, "Deployment result needs reconciliation")
    current, settings = cf.current()
    config = settings.get("assets", {}).get("config", {})
    require(current == version and config.get("not_found_handling") == cf.p["not_found_handling"]
            and config.get("html_handling") == "auto-trailing-slash" and config.get("run_worker_first") is False,
            "Deployment readback needs reconciliation")
    journal("verified", previous_version=previous, version_id=version)
    return version


def write_new(path, value):
    with open(path, "x", encoding="utf-8") as f:
        f.write(json.dumps(value, indent=2) + "\n")


def acquire_lock(directory, p):
    """Cross-process local serialization; workflow concurrency also serializes hosts."""
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            "Lock directory must be private and owned by this user")
    path = directory / (p["account_id"] + "-" + p["worker_id"] + ".lock")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "Invalid lock file")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        os.close(fd)
        raise Refused("Another deployment owns the Worker lock") from None
    return fd


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("plan", "verify", "deploy"))
    parser.add_argument("--policy", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--run", type=int, required=True)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--artifact", type=int, required=True)
    parser.add_argument("--receipt", required=True, help="New output path; never overwritten")
    parser.add_argument("--run-json")
    parser.add_argument("--artifact-json")
    parser.add_argument("--archive")
    parser.add_argument("--head-sha")
    parser.add_argument("--approved-receipt")
    parser.add_argument("--expected-version")
    parser.add_argument("--allow-live", action="store_true")
    parser.add_argument("--lock-dir", default=str(Path.home()/".hatchkit-static-deployer-locks"))
    args = parser.parse_args()
    policy = read_json(args.policy)
    p = validate_policy(policy, args.project)
    require(not Path(args.receipt).exists(), "Output receipt already exists")
    if args.mode == "plan":
        require(all((args.run_json, args.artifact_json, args.archive, args.head_sha)), "Offline plan requires metadata, ZIP and head SHA")
        require(Path(args.archive).stat().st_size <= p["limits"]["archive_bytes"], "Archive exceeds budget")
        with open(args.archive, "rb") as source:
            data = source.read(p["limits"]["archive_bytes"] + 1)
        receipt, _ = prepare(policy, args.project, read_json(args.run_json), read_json(args.artifact_json), data,
                             args.run, args.attempt, args.artifact, args.head_sha)
        write_new(args.receipt, receipt)
        print("Offline plan validated; no provider calls")
        return
    if os.environ.get("GITHUB_ACTIONS") == "true":
        require(os.environ.get("GITHUB_REPOSITORY_ID") == str(policy["trusted_repository_id"])
                and os.environ.get("GITHUB_REF") == "refs/heads/" + policy["trusted_branch"]
                and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Not an approved trusted workflow context")
    github_token = os.environ.get("SOURCE_READ_TOKEN")
    require(bool(github_token), "SOURCE_READ_TOKEN required")
    if args.mode == "deploy":
        require(args.allow_live and args.approved_receipt and args.expected_version, "Live deployment requires approval receipt and expected version")
        require(bool(os.environ.get("CLOUDFLARE_API_TOKEN")), "CLOUDFLARE_API_TOKEN required")
    else:
        require(not os.environ.get("CLOUDFLARE_API_TOKEN"), "Validation job must not hold a Cloudflare token")
    lock = acquire_lock(args.lock_dir, p) if args.mode == "deploy" else None
    # The process holds this descriptor until exit, including receipt reconciliation.
    http = HTTP()
    receipt, files = fetch_build(http, policy, args.project, args.run, args.attempt, args.artifact, github_token)
    if args.mode == "verify":
        write_new(args.receipt, receipt)
        print("Artifact verified; no Cloudflare calls")
        return
    approved = read_json(args.approved_receipt)
    cf = Cloudflare(http, p, os.environ["CLOUDFLARE_API_TOKEN"])
    state = {"artifact": receipt, "state": "validated"}
    write_new(args.receipt, state)

    def journal(stage, **fields):
        state.update(state=stage, **fields)
        temporary = str(args.receipt) + ".tmp"
        with open(temporary, "x", encoding="utf-8") as f:
            f.write(json.dumps(state, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, args.receipt)

    def source_check():
        prefix = "https://api.github.com/repos/" + p["repository"]
        run = http.json(prefix + f"/actions/runs/{args.run}", github_token)
        head = http.json(prefix + "/git/ref/heads/main", github_token).get("object", {}).get("sha")
        require(run.get("run_attempt") == args.attempt and run.get("conclusion") == "success"
                and run.get("head_sha") == head == receipt["head_sha"], "Source changed before deployment")

    try:
        deploy(cf, receipt, files, approved, args.expected_version, journal, source_check)
    except Exception:
        journal("needs-reconciliation" if state["state"] in ("deploying", "deployed-unverified") else "stopped-before-deploy")
        raise
    print("Deployment API readback verified; HTTP site checks remain required")


if __name__ == "__main__":
    try:
        main()
    except Refused as exc:
        print("Refused: " + str(exc), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # No raw provider response, URL with signed query, or credential in errors.
        print("Stopped: unexpected error; inspect the receipt before retrying", file=sys.stderr)
        sys.exit(1)
