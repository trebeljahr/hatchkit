"""Offline security regressions: no credentials, provider calls or project execution."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deployer", Path(__file__).with_name("deployer.py"))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

OLD = "11111111-1111-1111-1111-111111111111"
NEW = "22222222-2222-2222-2222-222222222222"
SHA = "a"*40
POLICY = {"schema": 1, "trusted_repository_id": 100, "trusted_branch": "main", "projects": {"site": {
    "repository": "owner/site", "repository_id": 101, "branch": "main", "workflow": ".github/workflows/build.yml",
    "artifact": "static-assets", "account_id": "b"*32, "worker_id": "c"*32, "worker_name": "site",
    "compatibility_date": "2026-09-28", "not_found_handling": "404-page",
    "limits": {"archive_bytes": 1000000, "expanded_bytes": 1000000, "file_bytes": 500000,
               "files": 100, "entries": 200, "ratio": 1000}}}}
P = POLICY["projects"]["site"]
RUN = {"id": 17, "run_attempt": 2, "status": "completed", "conclusion": "success", "event": "push",
       "run_started_at": "2026-09-30T01:00:00Z", "updated_at": "2026-09-30T01:10:00Z",
       "head_branch": "main", "head_sha": SHA, "path": ".github/workflows/build.yml",
       "repository": {"id": 101, "full_name": "owner/site"}, "head_repository": {"id": 101, "full_name": "owner/site"}}


def archive(entries=None):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, value in entries or [("index.html", b"<h1>site</h1>"), ("404.html", b"missing"), ("app.js", b"console.log('browser only')")]:
            z.writestr(name, value)
    return b.getvalue()


def artifact(data):
    return {"id": 19, "name": "static-assets-2", "created_at": "2026-09-30T01:05:00Z", "expired": False, "size_in_bytes": len(data),
            "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
            "workflow_run": {"id": 17, "repository_id": 101, "head_repository_id": 101, "head_branch": "main", "head_sha": SHA}}


def prepared():
    data = archive()
    return d.prepare(POLICY, "site", RUN, artifact(data), data, 17, 2, 19, SHA)


class FakeHTTP:
    def __init__(self):
        self.calls, self.current_version, self.fail_put, self.bad_readback = [], OLD, False, False
        self.bad_bucket, self.unchanged = False, False
        self.published_metadata = None

    def json(self, url, token=None, method="GET", body=None):
        self.calls.append((method, url, token, body))
        if url.endswith("/workers/workers/" + P["worker_id"]):
            value = {"id": P["worker_id"], "name": "site"}
        elif url.endswith("/deployments"):
            value = {"deployments": [{"versions": [{"version_id": self.current_version, "percentage": 100}]}]}
        elif "/versions/" in url:
            value = {"id": self.current_version, "resources": {"bindings": [], "script": None, "script_runtime": {}}}
        elif url.endswith("/settings"):
            value = {"bindings": ["bad"] if self.bad_readback and self.current_version == NEW else [],
                     "assets": {"config": {"not_found_handling": "404-page", "html_handling": "auto-trailing-slash", "run_worker_first": False}}}
        elif url.endswith("/schedules"):
            value = {"schedules": []}
        elif url.endswith("/assets-upload-session"):
            hashes = [x["hash"] for x in body["manifest"].values()]
            value = {"jwt": "upload-fixture-secret", "buckets": [] if self.unchanged else [["unknown"] if self.bad_bucket else hashes]}
        else:
            raise AssertionError("Unexpected API URL")
        return {"success": True, "result": value}

    def request(self, url, token=None, method="GET", body=None, content_type=None, limit=2000000):
        self.calls.append((method, url, token, body))
        if url.endswith("/workers/assets/upload?base64=true"):
            assert token == "upload-fixture-secret"
            return 200, {}, d.canonical({"success": True, "result": {"jwt": "completion-fixture-secret"}})
        if method == "PUT" and url.endswith("/workers/scripts/site"):
            if self.fail_put:
                raise d.Refused("Provider request failed; outcome may be unknown")
            content = body.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n--", 1)[0]
            self.published_metadata = json.loads(content)
            self.current_version = NEW
            return 200, {}, d.canonical({"success": True, "result": {"version_id": NEW}})
        raise AssertionError("Unexpected mutation")


class FakeGitHub:
    def __init__(self):
        self.data = archive()
        self.meta = artifact(self.data)
        self.calls = []
        self.ambiguous, self.stale, self.bad_redirect = False, False, False
        self.run_reads = 0

    def json(self, url, token=None, method="GET", body=None):
        self.calls.append((url, token))
        if "/git/ref/" in url:
            return {"object": {"sha": SHA}}
        if url.endswith("/actions/runs/17"):
            self.run_reads += 1
            return dict(RUN, run_attempt=3 if self.stale and self.run_reads > 1 else 2)
        if url.endswith("/actions/artifacts/19"):
            return self.meta
        if "/artifacts?" in url:
            return {"artifacts": [self.meta, self.meta] if self.ambiguous else [self.meta]}
        raise AssertionError("Unexpected GitHub endpoint")

    def request(self, url, token=None, **kwargs):
        self.calls.append((url, token))
        if url.endswith("/zip"):
            return 302, {"location": "https://evil.example/steal" if self.bad_redirect else "https://fixture.blob.core.windows.net/zip?sig=synthetic"}, b""
        assert token is None
        return 200, {}, self.data


class Tests(unittest.TestCase):
    def setUp(self):
        self.network_guard = patch.object(socket.socket, "connect", side_effect=AssertionError("Network forbidden in fixture tests"))
        self.network_guard.start()
        self.addCleanup(self.network_guard.stop)

    def test_valid_receipt_has_no_credentials_or_asset_contents(self):
        receipt, files = prepared()
        self.assertEqual(receipt["file_count"], 3)
        self.assertEqual(files["404.html"], b"missing")
        self.assertNotIn("secret", json.dumps(receipt))
        self.assertNotIn("browser only", json.dumps(receipt))
        self.assertEqual(receipt, prepared()[0])

    def test_cross_repo_fork_event_attempt_and_stale_build_fail(self):
        changes = [("head_repository", {"id": 999, "full_name": "evil/site"}), ("repository", {"id": 999}),
                   ("event", "pull_request"), ("event", "workflow_run"), ("run_attempt", 3),
                   ("head_sha", "b"*40), ("head_branch", "other"), ("path", ".github/workflows/other.yml"),
                   ("status", "in_progress"), ("conclusion", "failure"), ("id", 18)]
        data = archive()
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(d.Refused):
                run = copy.deepcopy(RUN)
                run[key] = value
                d.prepare(POLICY, "site", run, artifact(data), data, 17, 2, 19, SHA)

    def test_artifact_metadata_cannot_choose_another_build(self):
        data = archive()
        for key, value in [("id", 22), ("name", "other"), ("expired", True), ("created_at", "2026-09-30T00:50:00Z"), ("created_at", "2026-09-30T02:00:00Z"), ("digest", None), ("workflow_run", {})]:
            with self.subTest(key=key), self.assertRaises(d.Refused):
                a = artifact(data)
                a[key] = value
                d.prepare(POLICY, "site", RUN, a, data, 17, 2, 19, SHA)
        with self.assertRaises(d.Refused):
            d.prepare(POLICY, "site", RUN, artifact(data), data+b"bad", 17, 2, 19, SHA)

    def test_policy_does_not_accept_additional_authority(self):
        for key in ["main", "bindings", "routes", "env", "api_url", "token"]:
            with self.subTest(key=key), self.assertRaises(d.Refused):
                p = copy.deepcopy(POLICY)
                p["projects"]["site"][key] = "evil"
                d.validate_policy(p, "site")
        p = copy.deepcopy(POLICY)
        p["projects"]["site"]["repository_id"] = 100
        with self.assertRaises(d.Refused):
            d.validate_policy(p, "site")
        p = copy.deepcopy(POLICY)
        p["projects"]["copy"] = copy.deepcopy(P)
        with self.assertRaises(d.Refused):
            d.validate_policy(p, "site")

    def test_paths_cannot_escape_or_change_deployment_configuration(self):
        paths = ["../outside", "/etc/passwd", "a/../../outside", "a\\..\\b", "a//b", "./index.html", "C:/x",
                 "a/..", "a./b", "a /b", "a%2fb", "a?b", "a#b", "CON.txt", "a/aux", "a\x00b",
                 "e\u0301.txt", "a\u202eb", ".env.production", ".git/config", "node_modules/a", "wrangler.jsonc",
                 "_worker.js", "_headers", "_redirects", "package.json", "a"*1025]
        for path in paths:
            with self.subTest(path=path), self.assertRaises(d.Refused):
                d.safe_path(path)

    def test_links_special_files_and_unknown_extra_fields_refused(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600, stat.S_IFSOCK | 0o600):
            zi = zipfile.ZipInfo("linked")
            zi.create_system = 3
            zi.external_attr = mode << 16
            data = archive([("index.html", b"ok"), (zi, b"target")])
            with self.subTest(mode=mode), self.assertRaises(d.Refused):
                d.inspect_archive(data, artifact(data)["digest"], P["limits"])
        zi = zipfile.ZipInfo("extra")
        zi.extra = b"\x0d\x00\x02\x00xx"
        data = archive([("index.html", b"ok"), (zi, b"target")])
        with self.assertRaises(d.Refused):
            d.inspect_archive(data, artifact(data)["digest"], P["limits"])

    def test_duplicates_case_and_file_directory_collisions(self):
        for entries in [[("index.html", b"a"), ("INDEX.html", b"b")], [("index.html", b"a"), ("a", b"a"), ("a/b", b"b")]]:
            data = archive(entries)
            with self.assertRaises(d.Refused):
                d.inspect_archive(data, artifact(data)["digest"], P["limits"])

    def test_all_archive_budgets_enforced(self):
        data = archive()
        for key in ("archive_bytes", "expanded_bytes", "file_bytes", "files", "entries"):
            limits = dict(P["limits"], **{key: 1})
            with self.subTest(key=key), self.assertRaises(d.Refused):
                d.inspect_archive(data, artifact(data)["digest"], limits)
        data = archive([("index.html", b"x"*10000)])
        with self.assertRaises(d.Refused):
            d.inspect_archive(data, artifact(data)["digest"], dict(P["limits"], ratio=2))

    def test_corrupt_archive_and_missing_pages_refused(self):
        data = archive()
        for bad in (data[:-5], data+b"trailer", b"not a zip"):
            with self.assertRaises(d.Refused):
                d.inspect_archive(bad, artifact(bad)["digest"], P["limits"])
        data = archive([("index.html", b"ok")])
        with self.assertRaises(d.Refused):
            d.prepare(POLICY, "site", RUN, artifact(data), data, 17, 2, 19, SHA)
        policy = copy.deepcopy(POLICY)
        policy["projects"]["site"]["not_found_handling"] = "none"
        self.assertEqual(d.prepare(policy, "site", RUN, artifact(data), data, 17, 2, 19, SHA)[0]["file_count"], 1)

    def test_publish_only_uses_fixed_assets_metadata(self):
        receipt, files = prepared()
        http, stages = FakeHTTP(), []
        cf = d.Cloudflare(http, P, "worker-fixture-secret")
        result = d.deploy(cf, receipt, files, receipt, OLD, lambda stage, **kw: stages.append((stage, kw)), lambda: None)
        self.assertEqual(result, NEW)
        self.assertEqual([s for s, _ in stages], ["uploading", "deploying", "deployed-unverified", "verified"])
        self.assertEqual(http.published_metadata, {"compatibility_date": "2026-09-28", "bindings": [],
            "assets": {"jwt": "completion-fixture-secret", "config": {"html_handling": "auto-trailing-slash", "not_found_handling": "404-page", "run_worker_first": False}},
            "keep_bindings": [], "keep_assets": False})
        writes = [(method, url) for method, url, _, _ in http.calls if method != "GET"]
        self.assertEqual([method for method, _ in writes], ["POST", "POST", "PUT"])
        self.assertTrue(all("/workers/scripts/site" in url or url.endswith("/workers/assets/upload?base64=true") for _, url in writes))
        self.assertNotIn("fixture-secret", json.dumps(stages))

    def test_changed_receipt_or_current_version_causes_zero_writes(self):
        receipt, files = prepared()
        for approved, version in [(dict(receipt, project="other"), OLD), (receipt, NEW)]:
            http = FakeHTTP()
            with self.assertRaises(d.Refused):
                d.deploy(d.Cloudflare(http, P, "test"), receipt, files, approved, version, lambda *a, **k: None, lambda: None)
            self.assertTrue(all(method == "GET" for method, _, _, _ in http.calls))

    def test_unknown_upload_hash_is_rejected_before_upload(self):
        receipt, files = prepared()
        http = FakeHTTP()
        http.bad_bucket = True
        with self.assertRaises(d.Refused):
            d.deploy(d.Cloudflare(http, P, "test"), receipt, files, receipt, OLD, lambda *a, **k: None, lambda: None)
        self.assertFalse(any(method == "PUT" or "/assets/upload?" in url for method, url, _, _ in http.calls))

    def test_no_changed_assets_uses_completion_token(self):
        receipt, files = prepared()
        http = FakeHTTP()
        http.unchanged = True
        d.deploy(d.Cloudflare(http, P, "test"), receipt, files, receipt, OLD, lambda *a, **k: None, lambda: None)
        self.assertEqual(http.published_metadata["assets"]["jwt"], "upload-fixture-secret")
        self.assertFalse(any("/assets/upload?" in url for _, url, _, _ in http.calls))

    def test_uncertain_publish_and_bad_readback_never_claim_verified(self):
        receipt, files = prepared()
        for field in ("fail_put", "bad_readback"):
            http, stages = FakeHTTP(), []
            setattr(http, field, True)
            with self.subTest(field=field), self.assertRaises(d.Refused):
                d.deploy(d.Cloudflare(http, P, "test"), receipt, files, receipt, OLD, lambda s, **k: stages.append(s), lambda: None)
            self.assertNotIn("verified", stages)
            self.assertIn("deploying", stages)
            self.assertTrue(all(method != "DELETE" for method, _, _, _ in http.calls))

    def test_source_advancing_during_upload_blocks_publish(self):
        receipt, files = prepared()
        http = FakeHTTP()
        def stale():
            raise d.Refused("Source changed")
        with self.assertRaises(d.Refused):
            d.deploy(d.Cloudflare(http, P, "test"), receipt, files, receipt, OLD, lambda *a, **k: None, stale)
        self.assertFalse(any(method == "PUT" for method, _, _, _ in http.calls))

    def test_existing_code_bindings_schedules_and_identity_block_writes(self):
        receipt, files = prepared()
        alterations = [
            ("/workers/workers/" + P["worker_id"], {"id": P["worker_id"], "name": "other"}),
            ("/versions/" + OLD, {"id": OLD, "resources": {"bindings": [{"type": "kv_namespace"}], "script": None}}),
            ("/versions/" + OLD, {"id": OLD, "resources": {"bindings": [], "script": {"etag": "code", "handlers": []}}}),
            ("/versions/" + OLD, {"id": OLD, "resources": {"bindings": [], "script": {"handlers": ["fetch"]}}}),
            ("/schedules", {"schedules": [{"cron": "* * * * *"}]}),
            ("/settings", {"bindings": [], "tail_consumers": [{"service": "foreign"}]}),
            ("/deployments", {"deployments": [{"versions": [{"version_id": OLD, "percentage": 50}]}]}),
        ]
        for suffix, value in alterations:
            http = FakeHTTP()
            original = http.json
            def changed(url, token=None, method="GET", body=None):
                if url.endswith(suffix):
                    return {"success": True, "result": value}
                return original(url, token, method, body)
            with self.subTest(suffix=suffix), patch.object(http, "json", side_effect=changed), self.assertRaises(d.Refused):
                d.deploy(d.Cloudflare(http, P, "test"), receipt, files, receipt, OLD, lambda *a, **k: None, lambda: None)
            self.assertFalse(any(method != "GET" for method, _, _, _ in http.calls))

    def test_arbitrary_provider_mutations_rejected(self):
        cf = d.Cloudflare(FakeHTTP(), P, "test")
        for method, path in [("DELETE", cf.script), ("PUT", "/workers/scripts/foreign"), ("POST", "/workers/workers"), ("POST", "/tokens")]:
            with self.assertRaises(d.Refused):
                cf.api(path, method)

    def test_download_never_forwards_github_token_to_blob_host(self):
        http = FakeGitHub()
        receipt, _ = d.fetch_build(http, POLICY, "site", 17, 2, 19, "github-fixture-secret")
        self.assertEqual(receipt, prepared()[0])
        blob_calls = [(url, token) for url, token in http.calls if "blob.core" in url]
        self.assertEqual(len(blob_calls), 1)
        self.assertIsNone(blob_calls[0][1])
        self.assertNotIn("sig=", json.dumps(receipt))

    def test_artifact_ambiguity_redirect_and_rerun_rejected(self):
        for field in ("ambiguous", "bad_redirect", "stale"):
            http = FakeGitHub()
            setattr(http, field, True)
            with self.subTest(field=field), self.assertRaises(d.Refused):
                d.fetch_build(http, POLICY, "site", 17, 2, 19, "test")

    def test_worker_lock_serializes_processes_and_releases(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = d.acquire_lock(tmp, P)
            try:
                with self.assertRaises(d.Refused):
                    d.acquire_lock(tmp, P)
            finally:
                os.close(fd)
            os.close(d.acquire_lock(tmp, P))

    def test_failed_publish_leaves_reconciliation_receipt(self):
        receipt, files = prepared()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/"policy.json").write_text(json.dumps(POLICY))
            (root/"approved.json").write_text(json.dumps(receipt))
            http = FakeHTTP()
            http.fail_put = True
            argv = ["deployer", "deploy", "--policy", str(root/"policy.json"), "--project", "site",
                    "--run", "17", "--attempt", "2", "--artifact", "19", "--receipt", str(root/"result.json"),
                    "--approved-receipt", str(root/"approved.json"), "--expected-version", OLD, "--allow-live", "--lock-dir", tmp]
            # This fixture has already independently checked source revalidation.
            original_deploy = d.deploy
            def run_deploy(cf, rec, assets, approved, expected, journal, source_check):
                return original_deploy(cf, rec, assets, approved, expected, journal, lambda: None)
            with patch.object(sys, "argv", argv), patch.dict(os.environ, {"SOURCE_READ_TOKEN": "read-secret", "CLOUDFLARE_API_TOKEN": "cf-secret"}, clear=True), \
                 patch.object(d, "HTTP", return_value=http), patch.object(d, "fetch_build", return_value=(receipt, files)), \
                 patch.object(d, "deploy", side_effect=run_deploy), patch.object(d, "acquire_lock", return_value=None):
                with self.assertRaises(d.Refused):
                    d.main()
            state = json.loads((root/"result.json").read_text())
            self.assertEqual(state["state"], "needs-reconciliation")
            self.assertEqual(state["previous_version"], OLD)
            self.assertNotIn("secret", json.dumps(state))

    def test_cli_offline_plan_and_no_clobber(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = archive()
            (root/"policy.json").write_text(json.dumps(POLICY))
            (root/"run.json").write_text(json.dumps(RUN))
            (root/"artifact.json").write_text(json.dumps(artifact(data)))
            (root/"assets.zip").write_bytes(data)
            args = [sys.executable, "-I", str(Path(d.__file__)), "plan", "--policy", str(root/"policy.json"), "--project", "site",
                    "--run", "17", "--attempt", "2", "--artifact", "19", "--receipt", str(root/"receipt.json"),
                    "--run-json", str(root/"run.json"), "--artifact-json", str(root/"artifact.json"),
                    "--archive", str(root/"assets.zip"), "--head-sha", SHA]
            env = {"PATH": os.environ.get("PATH", ""), "HATCHKIT_KEYCHAIN_ACCESS": "deny"}
            first = subprocess.run(args, env=env, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            before = (root/"receipt.json").read_bytes()
            second = subprocess.run(args, env=env, capture_output=True, text=True)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual((root/"receipt.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
