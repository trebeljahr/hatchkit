/** Validate a domain name (e.g. chess.ricos.site) */
export declare function validateDomain(value: string): boolean | string;
/** Validate a project name (kebab-case) */
export declare function validateProjectName(value: string): boolean | string;
/** Validate an S3 bucket name */
export declare function validateBucketName(value: string): boolean | string;
/** Validate a URL */
export declare function validateUrl(value: string): boolean | string;
/** Validate non-empty string */
export declare function validateRequired(value: string): boolean | string;
/** Extract base domain and subdomain from a full domain. */
export declare function parseDomain(domain: string): {
    baseDomain: string;
    subdomain: string;
};
//# sourceMappingURL=validate.d.ts.map