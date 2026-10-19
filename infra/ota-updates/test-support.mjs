// In-memory stand-ins for the R2 binding and the Cache API, for the tests.
import { createHash } from "node:crypto";

export class FakeBucket {
  constructor() {
    this.objects = new Map();
    this.reads = 0;
  }

  #object(key, entry, range) {
    const bytes = entry.bytes;
    let slice = bytes;
    let rangeInfo;
    if (range) {
      const offset = range.offset ?? bytes.length - range.suffix;
      const length = range.length ?? bytes.length - offset;
      slice = bytes.subarray(offset, offset + length);
      rangeInfo = range;
    }
    return {
      key,
      size: bytes.length,
      httpEtag: `"${entry.etag}"`,
      httpMetadata: entry.httpMetadata ?? {},
      range: rangeInfo,
      body: new Response(slice).body,
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async head(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { key, size: entry.bytes.length, httpEtag: `"${entry.etag}"`, httpMetadata: entry.httpMetadata };
  }

  async get(key, options = {}) {
    this.reads++;
    const entry = this.objects.get(key);
    if (!entry) return null;
    let range;
    const header = options.range?.get?.("range");
    if (header) {
      const m = header.match(/^bytes=(\d*)-(\d*)$/);
      if (m && m[1] !== "") {
        const offset = Number(m[1]);
        const end = m[2] === "" ? entry.bytes.length - 1 : Number(m[2]);
        range = { offset, length: end - offset + 1 };
      } else if (m) {
        range = { suffix: Number(m[2]) };
      }
    }
    return this.#object(key, entry, range);
  }

  async put(key, value, options = {}) {
    let bytes;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = value;
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (options.sha256 && options.sha256 !== digest) {
      throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
    }
    this.objects.set(key, { bytes, etag: digest.slice(0, 32), httpMetadata: options.httpMetadata });
    return { key, size: bytes.length };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({ key }));
    return { objects, truncated: false };
  }
}

export class FakeCache {
  constructor() {
    this.entries = new Map();
  }
  async match(key) {
    const hit = this.entries.get(String(key));
    return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
  }
  async put(key, response) {
    this.entries.set(String(key), { body: await response.text(), headers: response.headers });
  }
  async delete(key) {
    return this.entries.delete(String(key));
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
