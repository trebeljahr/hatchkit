export interface CoolifyServer {
    id: number;
    name: string;
    ip: string;
    description?: string;
}
export interface CoolifyApiOptions {
    url: string;
    token: string;
}
/** Coolify REST API client. */
export declare class CoolifyApi {
    private url;
    private token;
    constructor(options: CoolifyApiOptions);
    private request;
    /** Test connection and get Coolify version. */
    getVersion(): Promise<string>;
    /** List all servers. */
    listServers(): Promise<CoolifyServer[]>;
    /** List all projects. */
    listProjects(): Promise<Array<{
        id: number;
        name: string;
    }>>;
    /** Create a new project. */
    createProject(name: string): Promise<{
        id: number;
        name: string;
    }>;
}
/** Verify Coolify connection. Returns version string or throws. */
export declare function verifyCoolify(url: string, token: string): Promise<string>;
//# sourceMappingURL=coolify-api.d.ts.map