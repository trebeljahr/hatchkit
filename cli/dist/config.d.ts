export interface ProviderStatus {
    status: "configured" | "unconfigured";
    lastVerified?: string;
}
export interface CoolifyConfig extends ProviderStatus {
    url: string;
    token: string;
    serversCache?: Array<{
        id: number;
        name: string;
        ip: string;
    }>;
}
export interface HetznerConfig extends ProviderStatus {
    token: string;
}
export interface DnsConfig extends ProviderStatus {
    provider: "inwx" | "cloudflare" | "manual";
    username?: string;
    password?: string;
    apiToken?: string;
}
export interface S3ProviderConfig extends ProviderStatus {
    accessKey: string;
    secretKey: string;
    location?: string;
    endpoint?: string;
    region?: string;
}
export interface GpuProviderConfig extends ProviderStatus {
    tokenId?: string;
    tokenSecret?: string;
    apiKey?: string;
    endpointId?: string;
}
export interface MlServiceEntry {
    platform: string;
    endpoint: string;
    deployedAt: string;
    gpu: string;
    model: string;
}
export interface CliConfig {
    version: number;
    providers: {
        github: ProviderStatus;
        coolify?: CoolifyConfig;
        hetzner?: HetznerConfig;
        dns?: DnsConfig;
        s3: Record<string, S3ProviderConfig>;
        gpu: Record<string, GpuProviderConfig>;
    };
    mlServices: Record<string, MlServiceEntry>;
}
export declare function getConfig(): CliConfig;
export declare function setConfig(config: Partial<CliConfig>): void;
export declare function getConfigPath(): string;
export declare function ensureGitHub(): Promise<void>;
export declare function ensureCoolify(): Promise<CoolifyConfig>;
export declare function ensureHetzner(): Promise<HetznerConfig>;
export declare function ensureDns(): Promise<DnsConfig>;
export declare function ensureS3(provider: "hetzner" | "aws" | "r2"): Promise<S3ProviderConfig>;
export declare function ensureGpuProvider(platform: "modal" | "runpod" | "hf" | "replicate"): Promise<GpuProviderConfig>;
export declare function getMlServices(): Record<string, MlServiceEntry>;
export declare function registerMlService(name: string, entry: MlServiceEntry): void;
export declare function isFirstRun(): Promise<boolean>;
export declare function runOnboarding(): Promise<void>;
//# sourceMappingURL=config.d.ts.map