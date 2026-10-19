/*
 * HMAC-signed JSON envelopes for the audit Worker's bucket.
 *
 * The operator token can write the bucket, so a leaked copy could add its
 * own token to the expected state or a fake run window covering its own
 * changes. Every object hatchkit writes there (expected state, run
 * windows) and the Worker writes there (alert state, last run) is signed
 * with a key only the laptop keychain (`cloudflare:audit-hmac`) and the
 * Worker secret `EXPECTED_HMAC_KEY` hold. `kind` is signed too, so a run
 * window cannot stand in for the expected state.
 *
 * No imports: this module is uploaded to the Worker as it is compiled.
 * WebCrypto only, which both Node and Workers have.
 */

export type SignedKind = "expected" | "run" | "alert-state" | "last-run";

export interface SignedEnvelope {
  v: 1;
  kind: SignedKind;
  payload: string;
  sig: string;
}

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(keyHex: string): Promise<CryptoKey> {
  const raw = hexToBytes(keyHex);
  if (raw.length < 32) throw new Error("The audit HMAC key must be at least 32 bytes.");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** A new random key, hex. */
export function newHmacKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

export async function signEnvelope(
  keyHex: string,
  kind: SignedKind,
  value: unknown,
): Promise<string> {
  const payload = JSON.stringify(value);
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(keyHex),
    enc.encode(`${kind}\n${payload}`),
  );
  const envelope: SignedEnvelope = { v: 1, kind, payload, sig: toHex(sig) };
  return JSON.stringify(envelope);
}

/** The payload, parsed; throws when the envelope is not one we signed for `kind`. */
export async function openEnvelope<T>(keyHex: string, kind: SignedKind, text: string): Promise<T> {
  let env: Partial<SignedEnvelope>;
  try {
    env = JSON.parse(text) as Partial<SignedEnvelope>;
  } catch {
    throw new Error("not a signed envelope");
  }
  if (
    env?.v !== 1 ||
    env.kind !== kind ||
    typeof env.payload !== "string" ||
    typeof env.sig !== "string"
  ) {
    throw new Error(`not a signed ${kind} envelope`);
  }
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = hexToBytes(env.sig);
  } catch {
    throw new Error("bad signature");
  }
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(keyHex),
    sig,
    enc.encode(`${kind}\n${env.payload}`),
  );
  if (!ok) throw new Error("bad signature");
  return JSON.parse(env.payload) as T;
}
