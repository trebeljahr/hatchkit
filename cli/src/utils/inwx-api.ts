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
// `account.login` once, capture the PHPSESSID cookie, include it on every
// follow-up request.

const PROD_URL = "https://api.domrobot.com/jsonrpc/";
const OTE_URL = "https://api.ote.domrobot.com/jsonrpc/";

export interface InwxApiOptions {
  username: string;
  password: string;
  /** Use the OTE sandbox instead of production. Set via INWX_SANDBOX=1. */
  sandbox?: boolean;
}

interface JsonRpcResponse<T> {
  code: number;
  msg: string;
  resData?: T;
}

/** INWX JSON-RPC API client. */
export class InwxApi {
  private url: string;
  private username: string;
  private password: string;
  private cookie: string | null = null;

  constructor(options: InwxApiOptions) {
    this.url = options.sandbox ? OTE_URL : PROD_URL;
    this.username = options.username;
    this.password = options.password;
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.cookie) headers.Cookie = this.cookie;

    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ method, params }),
    });

    if (!res.ok) {
      throw new Error(`INWX API ${method} failed: HTTP ${res.status} ${res.statusText}`);
    }

    // Capture the session cookie from the response on login. INWX sets
    // PHPSESSID; we pass it back on every subsequent call.
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const match = setCookie.match(/(PHPSESSID=[^;]+)/);
      if (match) this.cookie = match[1];
    }

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

  /** Log in and capture the session cookie. Must be called before any
   *  other method. Idempotent — safe to call twice. */
  async login(): Promise<void> {
    await this.request("account.login", {
      user: this.username,
      pass: this.password,
    });
    if (!this.cookie) {
      throw new Error("INWX login succeeded but no session cookie was set");
    }
  }

  /** Log out and drop the session cookie. */
  async logout(): Promise<void> {
    try {
      await this.request("account.logout", {});
    } finally {
      this.cookie = null;
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
