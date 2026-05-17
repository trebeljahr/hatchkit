/** Validate a domain name (e.g. app.example.com) */
export function validateDomain(value: string): boolean | string {
  const pattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  if (!pattern.test(value)) {
    return "Invalid domain. Use lowercase letters, numbers, and hyphens (e.g. app.example.com)";
  }
  return true;
}

/** Validate a project name (kebab-case) */
export function validateProjectName(value: string): boolean | string {
  const pattern = /^[a-z][a-z0-9-]*$/;
  if (!pattern.test(value)) {
    return "Project name must be kebab-case (lowercase letters, numbers, hyphens)";
  }
  if (value.length > 40) {
    return "Project name must be 40 characters or less";
  }
  return true;
}

/** Validate an S3 bucket name */
export function validateBucketName(value: string): boolean | string {
  if (value.length < 3 || value.length > 63) {
    return "Bucket name must be 3-63 characters";
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    return "Bucket name must be lowercase, start/end with letter or number";
  }
  if (value.includes("_")) {
    return "Bucket name cannot contain underscores";
  }
  return true;
}

/** Validate a URL */
export function validateUrl(value: string): boolean | string {
  try {
    new URL(value);
    return true;
  } catch {
    return "Invalid URL";
  }
}

/** Validate non-empty string */
export function validateRequired(value: string): boolean | string {
  if (!value.trim()) {
    return "This field is required";
  }
  return true;
}

/** Validate a Coolify project/application description. Empty is fine
 *  (callers fall back to a sensible default). Coolify's API rejects
 *  descriptions containing `:` and a few other glyphs — disallow the
 *  ones we know break the API and cap length so the dashboard renders
 *  the row cleanly. */
export function validateCoolifyDescription(value: string): boolean | string {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.length > 200) {
    return "Description must be 200 characters or less";
  }
  if (/[:<>]/.test(trimmed)) {
    return "Description can't contain `:`, `<`, or `>` (Coolify rejects these)";
  }
  return true;
}

/** Extract base domain and subdomain from a full domain. */
export function parseDomain(domain: string): {
  baseDomain: string;
  subdomain: string;
} {
  const parts = domain.split(".");
  if (parts.length < 3) {
    return { baseDomain: domain, subdomain: "" };
  }
  const baseDomain = parts.slice(-2).join(".");
  const subdomain = parts.slice(0, -2).join(".");
  return { baseDomain, subdomain };
}
