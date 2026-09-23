// INWX JSON-RPC API client.
//
// The INWX Terraform provider can create DNS records inside a zone, but it
// can't change the nameservers that the TLD delegates a domain to. That's
// a "domain object" operation (domain.update), not a "nameserver object"
// operation — different part of the INWX API. This client handles the
// domain-level call so hatchkit can automatically point an INWX-registered
// domain at Cloudflare's nameservers after the CF zone is ready.
//
// API docs: https://www.inwx.com/en/help/apidoc
// Endpoints: https://api.domrobot.com/jsonrpc/  (OTE sandbox on api.ote)
//
// The API is JSON-RPC 2.0 over HTTPS, session-cookie authenticated. Call
// `account.login` once, capture the session cookie it sets (named
// `domrobot` as of 2026, `PHPSESSID` before that), include it on every
// follow-up request. When 2FA is enabled, login also requires an
// `account.unlock` with a TOTP before any command works.

import { generateTotp } from "./totp.js";

const PROD_URL = "https://api.domrobot.com/jsonrpc/";
const OTE_URL = "https://api.ote.domrobot.com/jsonrpc/";

export interface InwxApiOptions {
  username: string;
  password: string;
  /** Use the OTE sandbox instead of production. Set via INWX_SANDBOX=1. */
  sandbox?: boolean;
  /** Base32 TOTP shared secret for a 2FA-enabled account. When login
   *  reports 2FA is on, a current code is derived from this for
   *  `account.unlock`. Falls back to the INWX_TOTP_SECRET env var. */
  totpSecret?: string;
  /** A literal current 6-digit TOTP code. Takes precedence over
   *  `totpSecret` (a code can't be stored — it expires in 30s — so this is
   *  for one-shot runs). Falls back to the INWX_TOTP env var. */
  totpCode?: string;
}

interface JsonRpcResponse<T> {
  code: number;
  msg: string;
  resData?: T;
}

/** Fields of `account.login`'s resData we care about. INWX returns `tfa`
 *  = the enabled 2FA method (e.g. "GOOGLE-AUTH"), or "0" when 2FA is off.
 *  When on, no command works until `account.unlock` consumes a TOTP. */
interface InwxLoginResData {
  tfa?: string;
}

/** INWX JSON-RPC API client. */
export class InwxApi {
  private url: string;
  private username: string;
  private password: string;
  private totpSecret?: string;
  private totpCode?: string;
  /** Session cookie jar (name → value). INWX sets one session cookie on
   *  login; we replay whatever it sends on every follow-up call. */
  private cookies = new Map<string, string>();

  constructor(options: InwxApiOptions) {
    this.url = options.sandbox ? OTE_URL : PROD_URL;
    this.username = options.username;
    this.password = options.password;
    this.totpSecret = options.totpSecret;
    this.totpCode = options.totpCode;
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ method, params }),
    });

    if (!res.ok) {
      throw new Error(`INWX API ${method} failed: HTTP ${res.status} ${res.statusText}`);
    }

    // Capture whatever session cookie INWX sets on login and replay it on
    // every follow-up call. INWX used `PHPSESSID` for years then renamed it
    // to `domrobot` in 2026; matching one hard-coded name silently dropped
    // the session and broke auth ("login succeeded but no session cookie
    // was set"). Parse by name so a future rename can't regress this again.
    this.captureCookies(res);

    const json = (await res.json()) as JsonRpcResponse<T>;

    // INWX returns HTTP 200 with an error code in the body. 1000 = success,
    // anything else is a failure. The `msg` field is the human-readable
    // error — surface it verbatim so callers can see what went wrong
    // (e.g. "Authentication error" vs "Object does not exist").
    if (json.code !== 1000) {
      throw new Error(`INWX ${method} failed: ${json.code} ${json.msg}`);
    }

    return json.resData as T;
  }

  /** Serialize the cookie jar into a `Cookie:` header, or null when empty. */
  private cookieHeader(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Merge any `Set-Cookie` headers from a response into the jar. Uses
   *  `getSetCookie()` (the only correct way to read multiple Set-Cookie
   *  headers — `get("set-cookie")` comma-joins them, which corrupts the
   *  Expires date), with a single-header fallback for exotic runtimes. */
  private captureCookies(res: Response): void {
    const raw: string[] =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : (() => {
            const single = res.headers.get("set-cookie");
            return single ? [single] : [];
          })();
    for (const line of raw) {
      // Take the `name=value` pair before the first `;`; ignore attributes
      // (Path, HttpOnly, Secure, …).
      const pair = line.split(";", 1)[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  /** Log in and capture the session cookie. Must be called before any
   *  other method. Idempotent — safe to call twice. */
  async login(): Promise<void> {
    const data = await this.request<InwxLoginResData>("account.login", {
      user: this.username,
      pass: this.password,
    });
    if (!this.cookieHeader()) {
      throw new Error("INWX login succeeded but no session cookie was set");
    }
    // When 2FA is enabled, account.login reports the method in `tfa` ("0"
    // means off) and every subsequent command fails until account.unlock
    // consumes a TOTP. Handle it explicitly so a 2FA account gets a clear
    // path instead of an opaque downstream "Authentication error".
    const tfa = data?.tfa;
    if (tfa && tfa !== "0") {
      const tan = this.resolveTotp();
      if (!tan) {
        throw new Error(
          "INWX account has 2FA enabled but no TOTP is configured. Store the " +
            "base32 secret via `hatchkit config add dns` (INWX 2FA prompt), or " +
            "set INWX_TOTP_SECRET, or pass a current 6-digit code in INWX_TOTP.",
        );
      }
      await this.request("account.unlock", { tan });
    }
  }

  /** Resolve the 6-digit TOTP to send to account.unlock, or null when none
   *  is available. A literal code (option or INWX_TOTP env) wins; otherwise
   *  a current code is derived from the base32 secret (option or
   *  INWX_TOTP_SECRET env). Throws only if a secret is present but invalid. */
  private resolveTotp(): string | null {
    const literal = this.totpCode?.trim() || process.env.INWX_TOTP?.trim();
    if (literal) return literal;
    const secret = this.totpSecret?.trim() || process.env.INWX_TOTP_SECRET?.trim();
    if (secret) return generateTotp(secret);
    return null;
  }

  /** Log out and drop the session cookie. */
  async logout(): Promise<void> {
    try {
      await this.request("account.logout", {});
    } finally {
      this.cookies.clear();
    }
  }

  /** Look up a single domain. Returns the record including current
   *  nameservers. Throws if the domain isn't registered on this account. */
  async getDomainInfo(domain: string): Promise<{ domain: string; ns: string[] }> {
    const data = await this.request<{ domain: string; ns: string[] }>("domain.info", { domain });
    return data;
  }

  /**
   * Update the nameservers delegated at the registrar for `domain`.
   * Replaces the full list — pass all the NS you want, not a diff.
   *
   * INWX's `domain.update` also accepts many other fields (contacts,
   * transferLock, authinfo, ...). We only touch `ns` here so we never
   * accidentally clobber contact info set via the web UI.
   */
  async setDomainNameservers(domain: string, nameservers: string[]): Promise<void> {
    if (nameservers.length < 2) {
      // Most registries require ≥2 NS records. Fail loud rather than
      // letting the TLD registry reject it with a less obvious error.
      throw new Error(`At least 2 nameservers required, got ${nameservers.length}`);
    }
    await this.request("domain.update", { domain, ns: nameservers });
  }
}
