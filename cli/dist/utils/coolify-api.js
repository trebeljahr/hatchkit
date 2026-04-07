/** Coolify REST API client. */
export class CoolifyApi {
    url;
    token;
    constructor(options) {
        this.url = options.url.replace(/\/$/, "");
        this.token = options.token;
    }
    async request(method, path, body) {
        const res = await fetch(`${this.url}/api/v1${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Coolify API ${method} ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
        }
        return res.json();
    }
    /** Test connection and get Coolify version. */
    async getVersion() {
        const data = await this.request("GET", "/version");
        return data.version;
    }
    /** List all servers. */
    async listServers() {
        const data = await this.request("GET", "/servers");
        return data.map((s) => ({
            id: s.id,
            name: s.name,
            ip: s.ip,
            description: s.description,
        }));
    }
    /** List all projects. */
    async listProjects() {
        return this.request("GET", "/projects");
    }
    /** Create a new project. */
    async createProject(name) {
        return this.request("POST", "/projects", { name });
    }
}
/** Verify Coolify connection. Returns version string or throws. */
export async function verifyCoolify(url, token) {
    const api = new CoolifyApi({ url, token });
    return api.getVersion();
}
//# sourceMappingURL=coolify-api.js.map