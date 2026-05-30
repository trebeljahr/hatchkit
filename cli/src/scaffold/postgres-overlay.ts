/*
 * Postgres overlay for the scaffolded starter.
 *
 * The starter ships with MongoDB (Mongoose + better-auth/adapters/mongodb)
 * baked in. When `config.dbEngine === "postgres"`, this overlay rewrites
 * the database-specific files in-place with Drizzle ORM + pg +
 * better-auth/adapters/drizzle equivalents. Public exports are kept
 * identical to the Mongo files (connectToDB, disconnectFromDB,
 * isDatabaseReady, initAuth, getAuth, disconnectAuth) so the rest of
 * the server doesn't need conditional imports.
 *
 * Why an overlay (rather than dual-tracking the starter): the starter
 * doubles as a live dev workspace + E2E target. Keeping one canonical
 * engine in starter/ and rewriting on scaffold means starter/ stays
 * clean and Mongo-native; only the rendered project carries the
 * Postgres files.
 *
 * Runs AFTER applyProjectName + feature-flag strips, BEFORE
 * pruneToSurface — that way the prune still sees a consistent
 * `mongo`-named compose service (we rename it here) and the file paths
 * we overwrite all exist.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PostgresOverlayResult {
  modifications: string[];
}

export function applyPostgresOverlay(outputDir: string): PostgresOverlayResult {
  const modifications: string[] = [];

  // ── packages/server/src/db/connection.ts ─────────────────────────────
  writeOverlayFile(
    outputDir,
    "packages/server/src/db/connection.ts",
    POSTGRES_CONNECTION,
    modifications,
    "db/connection.ts → drizzle + pg",
  );

  // ── packages/server/src/db/schema.ts (new) ───────────────────────────
  writeOverlayFile(
    outputDir,
    "packages/server/src/db/schema.ts",
    POSTGRES_SCHEMA,
    modifications,
    "db/schema.ts (drizzle tables: items, profiles, better-auth)",
  );

  // ── packages/server/src/auth/auth.ts ─────────────────────────────────
  writeOverlayFile(
    outputDir,
    "packages/server/src/auth/auth.ts",
    POSTGRES_AUTH,
    modifications,
    "auth/auth.ts → better-auth drizzle adapter",
  );

  // ── packages/server/src/config/env.ts ────────────────────────────────
  rewriteFile(outputDir, "packages/server/src/config/env.ts", (content) => {
    return content.replace(
      /MONGODB_URI:\s*getRequired\("MONGODB_URI"\),/,
      'POSTGRES_URL: getRequired("POSTGRES_URL"),',
    );
  });
  modifications.push("config/env.ts → POSTGRES_URL");

  // ── packages/server/.env.example ─────────────────────────────────────
  rewriteFile(outputDir, "packages/server/.env.example", (content) => {
    return content
      .replace(
        /# MongoDB connection string\s*\nMONGODB_URI=mongodb:\/\/[^\n]+/,
        `# Postgres connection string\nPOSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/${projectDevDbFromContent(content)}`,
      )
      .replace(/MONGODB_URI/g, "POSTGRES_URL");
  });
  modifications.push(".env.example → POSTGRES_URL");

  // ── packages/server/.env.development ─────────────────────────────────
  rewriteFile(outputDir, "packages/server/.env.development", (content) => {
    return content.replace(
      /MONGODB_URI=mongodb:\/\/[^\n]+/,
      `POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/${projectDevDbFromContent(content)}`,
    );
  });
  modifications.push(".env.development → POSTGRES_URL");

  // ── packages/server/package.json ─────────────────────────────────────
  patchServerPackageJson(outputDir);
  modifications.push("packages/server/package.json (swap mongoose/mongodb → drizzle-orm/pg)");

  // ── packages/server/drizzle.config.ts (new) ──────────────────────────
  writeOverlayFile(
    outputDir,
    "packages/server/drizzle.config.ts",
    POSTGRES_DRIZZLE_CONFIG,
    modifications,
    "drizzle.config.ts (drizzle-kit)",
  );

  // ── packages/server/src/models/Item.ts (kept as a repo, same export) ─
  writeOverlayFile(
    outputDir,
    "packages/server/src/models/Item.ts",
    POSTGRES_ITEM_REPO,
    modifications,
    "models/Item.ts → drizzle repo",
  );

  // ── packages/server/src/models/Profile.ts ────────────────────────────
  writeOverlayFile(
    outputDir,
    "packages/server/src/models/Profile.ts",
    POSTGRES_PROFILE_REPO,
    modifications,
    "models/Profile.ts → drizzle repo",
  );

  // ── packages/server/src/trpc/routers/items.ts ────────────────────────
  writeOverlayFile(
    outputDir,
    "packages/server/src/trpc/routers/items.ts",
    POSTGRES_ITEMS_ROUTER,
    modifications,
    "trpc/routers/items.ts → drizzle queries",
  );

  // ── packages/server/src/trpc/routers/profile.ts ──────────────────────
  writeOverlayFile(
    outputDir,
    "packages/server/src/trpc/routers/profile.ts",
    POSTGRES_PROFILE_ROUTER,
    modifications,
    "trpc/routers/profile.ts → drizzle queries",
  );

  // ── docker-compose.yml (prod): replace mongo service ─────────────────
  rewriteFile(outputDir, "docker-compose.yml", (content) => {
    let out = content;
    out = out.replace(
      /MONGODB_URI: mongodb:\/\/mongo:27017\/\$\{DB_NAME:-app\}/,
      "POSTGRES_URL: postgres://postgres:${POSTGRES_PASSWORD:-postgres}@postgres:5432/${DB_NAME:-app}",
    );
    out = out.replace(
      / {4}depends_on:\s*\n\s*- mongo\s*\n\s*- redis/,
      "    depends_on:\n      - postgres\n      - redis",
    );
    out = out.replace(
      / {2}mongo:\s*\n\s+image: mongo:7\s*\n\s+volumes:\s*\n\s+- mongo-data:\/data\/db\s*\n\s+restart: unless-stopped/,
      `  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: \${DB_NAME:-app}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: unless-stopped`,
    );
    out = out.replace(/mongo-data:/g, "postgres-data:");
    return out;
  });
  modifications.push("docker-compose.yml: mongo → postgres service");

  // ── docker-compose.dev.yml: replace mongo service ────────────────────
  rewriteFile(outputDir, "docker-compose.dev.yml", (content) =>
    rewriteDevComposeForPostgres(content),
  );
  modifications.push("docker-compose.dev.yml: mongo → postgres");

  // ── e2e/db-utils.ts ──────────────────────────────────────────────────
  writeOverlayFile(
    outputDir,
    "e2e/db-utils.ts",
    POSTGRES_E2E_DB_UTILS,
    modifications,
    "e2e/db-utils.ts → pg",
  );

  // ── e2e/start-server.sh ──────────────────────────────────────────────
  rewriteFile(outputDir, "e2e/start-server.sh", (content) =>
    rewriteStartServerForPostgres(content),
  );
  modifications.push("e2e/start-server.sh: mongo container → postgres");

  // ── playwright.config.ts: MONGODB_URI → POSTGRES_URL ─────────────────
  rewriteFile(outputDir, "playwright.config.ts", (content) =>
    content
      .replace(/MONGODB_URI/g, "POSTGRES_URL")
      .replace(
        /process\.env\.POSTGRES_URL\s*\?\?\s*"mongodb:\/\/[^"]+"/,
        'process.env.POSTGRES_URL ?? "postgres://postgres:postgres@127.0.0.1:5433/' +
          "starter-e2e" +
          '"',
      ),
  );
  modifications.push("playwright.config.ts: MONGODB_URI → POSTGRES_URL");

  // ── starter CLAUDE.md mention (best-effort) ──────────────────────────
  rewriteFile(outputDir, "CLAUDE.md", (content) =>
    content
      .replace("MongoDB (Mongoose) + Redis", "PostgreSQL (Drizzle ORM) + Redis")
      .replace("Mongoose schemas and models", "Drizzle schema + repositories"),
  );
  // Not strictly required — skip recording when the file isn't there.

  return { modifications };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function writeOverlayFile(
  outputDir: string,
  rel: string,
  content: string,
  modifications: string[],
  label: string,
): void {
  const path = join(outputDir, rel);
  writeFileSync(path, content, "utf-8");
  modifications.push(label);
}

function rewriteFile(outputDir: string, rel: string, transform: (content: string) => string): void {
  const path = join(outputDir, rel);
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  const next = transform(content);
  if (next !== content) writeFileSync(path, next, "utf-8");
}

/** Pull the project's local dev DB name out of an .env file. The
 *  starter's applyProjectName step has already rewritten it from the
 *  literal "starter-dev" to "<project>-dev"; we just need to read it
 *  back so the Postgres URL matches. Falls back to "app" if the file
 *  doesn't have the line yet (test fixtures, partial fixtures). */
function projectDevDbFromContent(content: string): string {
  const match = content.match(/mongodb:\/\/[^/]+\/([a-z0-9-]+)/i);
  return match?.[1] ?? "app";
}

function patchServerPackageJson(outputDir: string): void {
  const path = join(outputDir, "packages/server/package.json");
  if (!existsSync(path)) return;
  const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  pkg.dependencies = pkg.dependencies ?? {};
  delete pkg.dependencies.mongoose;
  delete pkg.dependencies.mongodb;
  pkg.dependencies.pg = "^8.13.1";
  pkg.dependencies["drizzle-orm"] = "^0.36.4";
  pkg.devDependencies = pkg.devDependencies ?? {};
  pkg.devDependencies["drizzle-kit"] = "^0.28.1";
  pkg.devDependencies["@types/pg"] = "^8.11.10";
  pkg.scripts = pkg.scripts ?? {};
  pkg.scripts["db:generate"] = "drizzle-kit generate";
  pkg.scripts["db:migrate"] = "drizzle-kit migrate";
  pkg.scripts["db:studio"] = "drizzle-kit studio";
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
}

function rewriteDevComposeForPostgres(content: string): string {
  // The dev compose mirrors prod but with bind-mounted ports for local
  // access. Rename the mongo service to postgres + swap the volume name.
  let out = content;
  out = out.replace(
    /^( *)mongo:\s*\n( *)image: mongo:7\s*\n( *)ports:\s*\n( *)- "27017:27017"\s*\n( *)volumes:\s*\n( *)- mongo-data:\/data\/db/m,
    `$1postgres:
$2image: postgres:16-alpine
$2environment:
$2  POSTGRES_USER: postgres
$2  POSTGRES_PASSWORD: postgres
$2  POSTGRES_DB: \${DB_NAME:-app}
$3ports:
$4- "5432:5432"
$5volumes:
$6- postgres-data:/var/lib/postgresql/data`,
  );
  out = out.replaceAll("mongo-data:", "postgres-data:");
  // Plain "mongo:" service header outside the multi-line capture (defensive)
  out = out.replace(/^( *)mongo:\s*$/gm, "$1postgres:");
  return out;
}

function rewriteStartServerForPostgres(content: string): string {
  // Replace the mongo container block with a postgres container block,
  // and the mongo readiness check with a pg one. Port: 5433 to avoid
  // clashing with a local-dev postgres on 5432.
  let out = content;
  out = out.replace(
    /(\s*# MongoDB on port 27018[\s\S]*?echo "\[e2e\] Started MongoDB on port 27018"\s*\n\s*fi)/,
    `
  # Postgres on port 5433
  if ! docker ps --format '{{.Names}}' | grep -q starter-e2e-postgres; then
    docker run -d --name starter-e2e-postgres -p 5433:5432 \\
      -e POSTGRES_USER=postgres \\
      -e POSTGRES_PASSWORD=postgres \\
      -e POSTGRES_DB=starter-e2e \\
      --tmpfs /var/lib/postgresql/data postgres:16-alpine
    echo "[e2e] Started Postgres on port 5433"
  fi`,
  );
  out = out.replace(
    /(\s*# Wait for MongoDB[\s\S]*?echo "\[e2e\] MongoDB ready")/,
    `
  # Wait for Postgres
  for i in $(seq 1 30); do
    docker exec starter-e2e-postgres pg_isready -U postgres -d starter-e2e 2>/dev/null && break
    sleep 1
  done
  echo "[e2e] Postgres ready"`,
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// File contents
// ─────────────────────────────────────────────────────────────────────────

const POSTGRES_CONNECTION = `import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;
let ready = false;

export async function connectToDB(): Promise<void> {
  if (ready) return;
  pool = new Pool({ connectionString: env.POSTGRES_URL });
  // Smoke a connection so a misconfigured URL fails fast at startup
  // instead of on the first query mid-request.
  const client = await pool.connect();
  client.release();
  _db = drizzle(pool, { schema });
  ready = true;
  console.log("[db] Connected to Postgres");
}

export async function disconnectFromDB(): Promise<void> {
  if (!ready || !pool) return;
  await pool.end();
  pool = null;
  _db = null;
  ready = false;
  console.log("[db] Disconnected from Postgres");
}

export function isDatabaseReady(): boolean {
  return ready;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!_db) throw new Error("DB not initialized. Call connectToDB() first.");
  return _db;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("DB not initialized. Call connectToDB() first.");
  return pool;
}
`;

const POSTGRES_SCHEMA = `import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { ItemStatus, ThemePreference } from "@starter/shared";

// ── Application tables ──────────────────────────────────────────────────

export const items = pgTable("items", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: varchar("title", { length: 200 }).notNull(),
  description: varchar("description", { length: 2000 }),
  status: text("status").$type<ItemStatus>().notNull().default("draft"),
  ownerId: text("owner_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const profiles = pgTable("profiles", {
  userId: text("user_id").primaryKey(),
  avatarUrl: text("avatar_url"),
  bio: varchar("bio", { length: 500 }),
  preferences: jsonb("preferences")
    .$type<{ theme: ThemePreference; notifications: boolean }>()
    .notNull()
    .default({ theme: "system", notifications: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── better-auth tables ──────────────────────────────────────────────────
// Shape comes from better-auth's drizzle adapter docs. Keep column
// names / types in sync if you upgrade better-auth.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
`;

const POSTGRES_AUTH = `import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { env, getTrustedOrigins } from "../config/env.js";
import { getDb } from "../db/connection.js";
import * as schema from "../db/schema.js";
import { sendEmail } from "../services/email.js";

/**
 * better-auth instance. Must be initialized AFTER connectToDB() because
 * the drizzle adapter is bound to the live pool.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _auth: any = null;

export async function initAuth(): Promise<void> {
  _auth = betterAuth({
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: getTrustedOrigins(),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      async sendResetPassword({ user, url }: { user: { email: string }; url: string }) {
        if (!env.LISTMONK_URL || !env.LISTMONK_TX_TEMPLATE_ID) {
          console.log(\`[auth] Password reset URL for \${user.email}: \${url}\`);
          return;
        }
        await sendEmail({
          to: user.email,
          subject: "Reset your password",
          text: \`Click this link to reset your password: \${url}\`,
          html: \`<p>Click <a href="\${url}">here</a> to reset your password.</p>\`,
        });
      },
      async sendVerificationEmail({ user, url }: { user: { email: string }; url: string }) {
        if (!env.LISTMONK_URL || !env.LISTMONK_TX_TEMPLATE_ID) {
          console.log(\`[auth] Verification URL for \${user.email}: \${url}\`);
          return;
        }
        await sendEmail({
          to: user.email,
          subject: "Verify your email",
          text: \`Click this link to verify your email: \${url}\`,
          html: \`<p>Click <a href="\${url}">here</a> to verify your email.</p>\`,
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
        maxAge: 5 * 60,
      },
    },
  });
}

export function getAuth() {
  if (!_auth) {
    throw new Error(
      "Auth not initialized. Call initAuth() after database connection.",
    );
  }
  return _auth;
}

export async function disconnectAuth(): Promise<void> {
  // The drizzle adapter shares the pool with the rest of the server, so
  // there's no separate client to close here — disconnectFromDB() owns
  // the pool lifecycle.
  _auth = null;
}
`;

const POSTGRES_DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/app",
  },
});
`;

const POSTGRES_ITEM_REPO = `import type { ItemStatus } from "@starter/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { items } from "../db/schema.js";

export interface ItemRow {
  id: string;
  title: string;
  description: string | null;
  status: ItemStatus;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export const Item = {
  async listForOwner(ownerId: string, cursor: string | undefined, limit: number): Promise<ItemRow[]> {
    const db = getDb();
    const conditions = cursor
      ? and(eq(items.ownerId, ownerId), lt(items.id, cursor))
      : eq(items.ownerId, ownerId);
    return db
      .select()
      .from(items)
      .where(conditions)
      .orderBy(desc(items.id))
      .limit(limit);
  },
  async findById(id: string): Promise<ItemRow | undefined> {
    const db = getDb();
    const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
    return row;
  },
  async create(input: { title: string; description?: string; status?: ItemStatus; ownerId: string }): Promise<ItemRow> {
    const db = getDb();
    const [row] = await db
      .insert(items)
      .values({
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? "draft",
        ownerId: input.ownerId,
      })
      .returning();
    return row;
  },
  async delete(id: string): Promise<void> {
    const db = getDb();
    await db.delete(items).where(eq(items.id, id));
  },
};
`;

const POSTGRES_PROFILE_REPO = `import type { ThemePreference } from "@starter/shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { profiles } from "../db/schema.js";

export interface ProfileRow {
  userId: string;
  avatarUrl: string | null;
  bio: string | null;
  preferences: { theme: ThemePreference; notifications: boolean };
}

export const Profile = {
  async findByUserId(userId: string): Promise<ProfileRow | undefined> {
    const db = getDb();
    const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
    return row;
  },
  async upsert(input: {
    userId: string;
    avatarUrl?: string | null;
    bio?: string | null;
    preferences?: { theme: ThemePreference; notifications: boolean };
  }): Promise<ProfileRow> {
    const db = getDb();
    const defaults: { theme: ThemePreference; notifications: boolean } = {
      theme: "system",
      notifications: true,
    };
    const [row] = await db
      .insert(profiles)
      .values({
        userId: input.userId,
        avatarUrl: input.avatarUrl ?? null,
        bio: input.bio ?? null,
        preferences: input.preferences ?? defaults,
      })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: {
          avatarUrl: input.avatarUrl ?? null,
          bio: input.bio ?? null,
          preferences: input.preferences ?? defaults,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  },
};
`;

const POSTGRES_ITEMS_ROUTER = `import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createItemSchema, paginationSchema } from "@starter/shared";
import { Item } from "../../models/Item.js";
import { protectedProcedure, router } from "../trpc.js";

export const itemsRouter = router({
  list: protectedProcedure.input(paginationSchema).query(async ({ ctx, input }) => {
    const rows = await Item.listForOwner(ctx.user.id, input.cursor, input.limit + 1);
    const hasMore = rows.length > input.limit;
    if (hasMore) rows.pop();
    return {
      items: rows.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description ?? undefined,
        status: item.status,
        ownerId: item.ownerId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      nextCursor: hasMore ? rows[rows.length - 1].id : undefined,
    };
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const item = await Item.findById(input.id);
      if (!item || item.ownerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return {
        id: item.id,
        title: item.title,
        description: item.description ?? undefined,
        status: item.status,
        ownerId: item.ownerId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    }),

  create: protectedProcedure
    .input(createItemSchema)
    .mutation(async ({ ctx, input }) => {
      const item = await Item.create({
        title: input.title,
        description: input.description,
        status: input.status,
        ownerId: ctx.user.id,
      });
      return {
        id: item.id,
        title: item.title,
        description: item.description ?? undefined,
        status: item.status,
        ownerId: item.ownerId,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const item = await Item.findById(input.id);
      if (!item || item.ownerId !== ctx.user.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      await Item.delete(input.id);
      return { success: true };
    }),
});
`;

const POSTGRES_PROFILE_ROUTER = `import { updateProfileSchema } from "@starter/shared";
import { Profile } from "../../models/Profile.js";
import { protectedProcedure, router } from "../trpc.js";

export const profileRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    let profile = await Profile.findByUserId(ctx.user.id);
    if (!profile) {
      profile = await Profile.upsert({
        userId: ctx.user.id,
        preferences: { theme: "system", notifications: true },
      });
    }
    return {
      userId: profile.userId,
      avatarUrl: profile.avatarUrl ?? undefined,
      bio: profile.bio ?? undefined,
      preferences: profile.preferences,
    };
  }),

  update: protectedProcedure
    .input(updateProfileSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await Profile.findByUserId(ctx.user.id);
      const preferences = {
        theme: input.preferences?.theme ?? existing?.preferences.theme ?? "system",
        notifications:
          input.preferences?.notifications ?? existing?.preferences.notifications ?? true,
      };
      const profile = await Profile.upsert({
        userId: ctx.user.id,
        avatarUrl: input.avatarUrl ?? existing?.avatarUrl ?? null,
        bio: input.bio ?? existing?.bio ?? null,
        preferences,
      });
      return {
        userId: profile.userId,
        avatarUrl: profile.avatarUrl ?? undefined,
        bio: profile.bio ?? undefined,
        preferences: profile.preferences,
      };
    }),
});
`;

const POSTGRES_E2E_DB_UTILS = `import pg from "pg";

const { Pool } = pg;

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? "postgres://postgres:postgres@127.0.0.1:5433/starter-e2e";

let pool: pg.Pool | null = null;

export async function getPool(): Promise<pg.Pool> {
  if (!pool) {
    pool = new Pool({ connectionString: POSTGRES_URL });
  }
  return pool;
}

export async function cleanDatabase(): Promise<void> {
  const p = await getPool();
  const { rows } = await p.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => '"' + r.tablename + '"').join(", ");
  await p.query("TRUNCATE TABLE " + list + " RESTART IDENTITY CASCADE");
}

export async function closeDbConnection(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
`;
