import "dotenv/config";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env.development if it exists and NODE_ENV is not production
const __dirname = dirname(fileURLToPath(import.meta.url));
const devEnvPath = resolve(__dirname, "../../.env.development");
if (process.env.NODE_ENV !== "production" && existsSync(devEnvPath)) {
  const dotenv = await import("dotenv");
  dotenv.config({ path: devEnvPath });
}

function getRequired(key: string): string {
  const value = process.env[key];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value ?? "";
}

function getOptional(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

export const env = {
  NODE_ENV: getOptional("NODE_ENV", "development"),
  PORT: parseInt(getOptional("PORT", "5000"), 10),
  MONGODB_URI: getRequired("MONGODB_URI"),
  REDIS_URL: getOptional("REDIS_URL"),

  // Auth
  BETTER_AUTH_SECRET: getRequired("BETTER_AUTH_SECRET"),
  BETTER_AUTH_URL: getRequired("BETTER_AUTH_URL"),
  FRONTEND_URL: getRequired("FRONTEND_URL"),
  GOOGLE_CLIENT_ID: getOptional("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getOptional("GOOGLE_CLIENT_SECRET"),

  // Stripe
  STRIPE_SECRET_KEY: getOptional("STRIPE_SECRET_KEY"),
  STRIPE_WEBHOOK_SECRET: getOptional("STRIPE_WEBHOOK_SECRET"),

  // Email
  MAILGUN_API_KEY: getOptional("MAILGUN_API_KEY"),
  MAILGUN_DOMAIN: getOptional("MAILGUN_DOMAIN"),

  // S3
  S3_ENDPOINT: getOptional("S3_ENDPOINT"),
  S3_BUCKET_NAME: getOptional("S3_BUCKET_NAME", "starter-assets"),
  S3_PUBLIC_URL: getOptional("S3_PUBLIC_URL"),
  S3_FORCE_PATH_STYLE: getOptional("S3_FORCE_PATH_STYLE") === "true",
  AWS_REGION: getOptional("AWS_REGION", "us-east-1"),
  AWS_ACCESS_KEY_ID: getOptional("AWS_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: getOptional("AWS_SECRET_ACCESS_KEY"),

  // ML services (Modal/RunPod endpoints)
  ML_BACKGROUND_REMOVAL_ENDPOINT: getOptional("ML_BACKGROUND_REMOVAL_ENDPOINT"),
  ML_SUBTITLES_ENDPOINT: getOptional("ML_SUBTITLES_ENDPOINT"),
  ML_IMAGE_RECOGNITION_ENDPOINT: getOptional("ML_IMAGE_RECOGNITION_ENDPOINT"),
  ML_3D_EXTRACTION_ENDPOINT: getOptional("ML_3D_EXTRACTION_ENDPOINT"),

  // Monitoring
  SENTRY_DSN: getOptional("SENTRY_DSN"),

  isProduction: getOptional("NODE_ENV") === "production",
  isTest: getOptional("NODE_ENV") === "test",
} as const;
