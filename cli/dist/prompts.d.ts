export type DeployTarget = "existing" | "new";
export type DnsProvider = "inwx" | "cloudflare" | "manual";
export type S3Provider = "hetzner" | "r2" | "aws" | "existing" | "none";
export type GpuPlatform = "modal" | "runpod" | "hf" | "replicate";
export type Feature = "websocket" | "stripe" | "analytics" | "s3";
export type MlService = "3d-extraction" | "subtitles" | "image-recognition" | "background-removal" | "custom-hf";
export interface ProjectConfig {
    name: string;
    domain: string;
    baseDomain: string;
    subdomain: string;
    deployTarget: DeployTarget;
    serverId?: number;
    serverIp?: string;
    serverSize?: string;
    serverLocation?: string;
    features: Feature[];
    s3Provider: S3Provider;
    s3ExistingEndpoint?: string;
    s3ExistingBucket?: string;
    s3ExistingAccessKey?: string;
    s3ExistingSecretKey?: string;
    s3ExistingRegion?: string;
    mlServices: MlService[];
    gpuPlatform?: GpuPlatform;
    customHfModelId?: string;
    customHfGpuType?: string;
    scaffoldRepo: boolean;
    createGithubRepo: boolean;
    runDeployment: boolean;
    dryRun: boolean;
}
export declare function collectProjectConfig(options: {
    dryRun?: boolean;
}): Promise<ProjectConfig>;
//# sourceMappingURL=prompts.d.ts.map