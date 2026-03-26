import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { env } from "../config/env.js";
import { getMongoClient } from "../db/connection.js";
import { sendEmail } from "../services/email.js";

/**
 * better-auth instance. Must be initialized AFTER mongoose.connect() because
 * it needs the MongoClient from the established connection.
 *
 * Call `initAuth()` after database connection is established.
 */
let _auth: ReturnType<typeof betterAuth> | null = null;

export function initAuth(): void {
  const client = getMongoClient();
  const db = client.db();

  _auth = betterAuth({
    database: mongodbAdapter(db),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.FRONTEND_URL ? [env.FRONTEND_URL] : [],

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // Set to true once Mailgun is configured
      async sendResetPassword({ user, url }) {
        if (!env.MAILGUN_API_KEY) {
          console.log(`[auth] Password reset URL for ${user.email}: ${url}`);
          return;
        }
        await sendEmail({
          to: user.email,
          subject: "Reset your password",
          text: `Click this link to reset your password: ${url}`,
          html: `<p>Click <a href="${url}">here</a> to reset your password.</p>`,
        });
      },
      async sendVerificationEmail({ user, url }) {
        if (!env.MAILGUN_API_KEY) {
          console.log(`[auth] Verification URL for ${user.email}: ${url}`);
          return;
        }
        await sendEmail({
          to: user.email,
          subject: "Verify your email",
          text: `Click this link to verify your email: ${url}`,
          html: `<p>Click <a href="${url}">here</a> to verify your email.</p>`,
        });
      },
    },

    socialProviders: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
    },

    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
  });
}

export function getAuth(): ReturnType<typeof betterAuth> {
  if (!_auth) {
    throw new Error(
      "Auth not initialized. Call initAuth() after database connection.",
    );
  }
  return _auth;
}
