/**
 * App Store Connect API client tests with mocked HTTP.
 *
 * Covers:
 *   1. JWT structure (header alg/kid/typ, payload iss/aud/exp window).
 *   2. ensureBundleId GET-before-POST and idempotency.
 *   3. ensureProfile GET-before-POST.
 *   4. validateBundleIdRef returns false on 404.
 *   5. provisionAppleForProject end-to-end with a stub .p8 key.
 *
 * Generates an ephemeral ES256 private key and writes it to a temp
 * file so the JWT signer can run against real crypto. Never hits Apple.
 *
 * Run: pnpm --filter hatchkit test:signing-asc
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AscClient, getAscJwt, provisionAppleForProject } from "./src/features/signing/apple.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "signing-asc-"));
try {
  // 1. Generate an ES256 keypair, write .p8.
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const p8Pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const p8Path = join(tmp, "AuthKey_TEST123ABC.p8");
  writeFileSync(p8Path, p8Pem);

  const apple = {
    teamId: "ABCDEF1234",
    distributionP12Path: "/dev/null",
    distributionP12PasswordKeychainAccount: "stub",
    apiKeyId: "TEST123ABC",
    apiIssuerId: "11111111-2222-3333-4444-555555555555",
    apiKeyP8Path: p8Path,
  };

  // 2. JWT shape.
  const jwt = getAscJwt(apple);
  const [hB64, pB64] = jwt.split(".");
  const header = JSON.parse(Buffer.from(hB64, "base64url").toString("utf-8"));
  const payload = JSON.parse(Buffer.from(pB64, "base64url").toString("utf-8"));
  assert(header.alg === "ES256", `JWT alg: ${header.alg}`);
  assert(header.kid === "TEST123ABC", `JWT kid: ${header.kid}`);
  assert(header.typ === "JWT", `JWT typ: ${header.typ}`);
  assert(payload.iss === apple.apiIssuerId, `JWT iss: ${payload.iss}`);
  assert(payload.aud === "appstoreconnect-v1", `JWT aud: ${payload.aud}`);
  assert(typeof payload.iat === "number", `JWT iat present`);
  assert(typeof payload.exp === "number", `JWT exp present`);
  assert(payload.exp - payload.iat <= 1200, `JWT exp window ≤ 1200`);
  assert(payload.exp - payload.iat > 0, `JWT exp window > 0`);

  // 3. Mock fetch — narrow stubs per endpoint.
  type FetchCall = { url: string; init?: RequestInit };
  const calls: FetchCall[] = [];

  let bundleIdExists = false;
  let profileExists = false;

  const makeRes = (status: number, body: unknown): Response =>
    ({
      ok: status < 400,
      status,
      statusText: String(status),
      json: async () => body,
      headers: new Headers(),
    }) as unknown as Response;

  const mockFetch: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const method = (init?.method ?? "GET").toUpperCase();
    // GET bundle ids by identifier filter.
    if (method === "GET" && url.includes("/v1/bundleIds?filter[identifier]=")) {
      return makeRes(
        200,
        bundleIdExists
          ? {
              data: [
                {
                  type: "bundleIds",
                  id: "BUNDLE_ID_RES_42",
                  attributes: { identifier: "com.example.tiao", name: "Tiao" },
                },
              ],
            }
          : { data: [] },
      );
    }
    // POST /v1/bundleIds.
    if (method === "POST" && url.endsWith("/v1/bundleIds")) {
      bundleIdExists = true;
      return makeRes(201, {
        data: {
          type: "bundleIds",
          id: "BUNDLE_ID_RES_42",
          attributes: { identifier: "com.example.tiao", name: "Tiao" },
        },
      });
    }
    // GET /v1/bundleIds/{id} (validateBundleIdRef).
    if (method === "GET" && url.includes("/v1/bundleIds/BUNDLE_ID_RES_42")) {
      return makeRes(200, {
        data: { type: "bundleIds", id: "BUNDLE_ID_RES_42", attributes: {} },
      });
    }
    if (method === "GET" && url.includes("/v1/bundleIds/STALE")) {
      return makeRes(404, { errors: [{ detail: "not found" }] });
    }
    // GET /v1/apps?filter[bundleId]
    if (method === "GET" && url.includes("/v1/apps?filter[bundleId]=")) {
      return makeRes(200, { data: [] });
    }
    // POST /v1/apps
    if (method === "POST" && url.endsWith("/v1/apps")) {
      return makeRes(201, {
        data: {
          type: "apps",
          id: "APP_REC_999",
          attributes: { bundleId: "com.example.tiao", name: "Tiao", sku: "tiao", primaryLocale: "en-US" },
        },
      });
    }
    // GET /v1/certificates?filter[certificateType]=DISTRIBUTION
    if (method === "GET" && url.includes("/v1/certificates?filter[certificateType]=DISTRIBUTION")) {
      return makeRes(200, {
        data: [{ type: "certificates", id: "CERT_777", attributes: { certificateType: "DISTRIBUTION" } }],
      });
    }
    // GET /v1/profiles?filter[name]
    if (method === "GET" && url.includes("/v1/profiles?filter[name]=")) {
      return makeRes(
        200,
        profileExists
          ? {
              data: [
                {
                  type: "profiles",
                  id: "PROF_3",
                  attributes: { name: "Tiao App Store", profileType: "IOS_APP_STORE" },
                },
              ],
            }
          : { data: [] },
      );
    }
    // POST /v1/profiles
    if (method === "POST" && url.endsWith("/v1/profiles")) {
      profileExists = true;
      return makeRes(201, {
        data: {
          type: "profiles",
          id: "PROF_3",
          attributes: { name: "Tiao App Store", profileType: "IOS_APP_STORE" },
        },
      });
    }
    // GET /v1/profiles/{id}?fields[profiles]=profileContent
    if (method === "GET" && url.includes("/v1/profiles/PROF_3?fields")) {
      return makeRes(200, {
        data: {
          type: "profiles",
          id: "PROF_3",
          attributes: { name: "Tiao App Store", profileContent: "BASE64PROFILEMOCK" },
        },
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  const client = new AscClient({ apple, fetchImpl: mockFetch });

  // 4. validateBundleIdRef true / false.
  const refOk = await client.validateBundleIdRef("BUNDLE_ID_RES_42");
  assert(refOk === true, `validateBundleIdRef ok`);
  const refStale = await client.validateBundleIdRef("STALE");
  assert(refStale === false, `validateBundleIdRef 404 → false`);

  // 5. ensureBundleId: not found → POST → returns id with created=true.
  const r1 = await client.ensureBundleId({
    identifier: "com.example.tiao",
    name: "Tiao",
  });
  assert(r1.created === true, `first ensureBundleId created=true`);
  assert(r1.id === "BUNDLE_ID_RES_42", `first ensureBundleId id`);

  // 6. ensureBundleId again: now found → GET only, created=false.
  const r2 = await client.ensureBundleId({
    identifier: "com.example.tiao",
    name: "Tiao",
  });
  assert(r2.created === false, `second ensureBundleId created=false`);
  assert(r2.id === "BUNDLE_ID_RES_42", `second ensureBundleId id`);

  // 7. End-to-end provisionAppleForProject.
  const out = await provisionAppleForProject({
    apple,
    project: {
      bundleId: "com.example.tiao",
      appName: "Tiao",
      appSlug: "tiao",
      appleSku: "tiao",
    },
    fetchImpl: mockFetch,
  });
  assert(out.bundleIdResourceId === "BUNDLE_ID_RES_42", `bundleIdResourceId`);
  assert(out.appRecordId === "APP_REC_999", `appRecordId`);
  assert(out.profileId === "PROF_3", `profileId`);
  assert(out.profileName === "Tiao App Store", `profileName`);
  assert(out.profileBase64 === "BASE64PROFILEMOCK", `profileBase64`);
  assert(out.certificateId === "CERT_777", `certificateId`);
  assert(out.createdAppRecord === true, `createdAppRecord true (record was new)`);
  assert(out.createdProfile === true, `createdProfile true (profile was new)`);

  // 8. Authorization header carries Bearer <jwt>.
  const lastAuth = (calls[calls.length - 1].init?.headers as Record<string, string>)?.Authorization;
  assert(typeof lastAuth === "string" && lastAuth.startsWith("Bearer "), `Bearer auth header`);

  if (failed === 0) {
    console.log("test-signing-asc: ok");
    process.exit(0);
  } else {
    console.error(`test-signing-asc: ${failed} assertion(s) failed`);
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
