/*
 * Opt-in plaintext secret file for machines with no OS credential store:
 * headless Linux servers, containers, WSL without a keyring.
 *
 * Enabled only with `HATCHKIT_SECRET_STORE=file`. The file is JSON, mode
 * 0600 inside a 0700 directory, the same protection `gh` and the AWS CLI
 * give their credential files. Anyone who can read the file as this user
 * (or as root) can read every token, so the OS store stays the default.
 *
 * Location: `HATCHKIT_SECRETS_FILE`, else `secrets.json` next to the
 * hatchkit config file.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretBackend } from "./os-keyring.js";

type FileShape = { version: 1; services: Record<string, Record<string, string>> };

export async function secretsFilePath(): Promise<string> {
  const override = process.env.HATCHKIT_SECRETS_FILE?.trim();
  if (override) return override;
  const { getConfigPath } = await import("../config.js");
  return join(dirname(getConfigPath()), "secrets.json");
}

async function load(): Promise<{ path: string; data: FileShape }> {
  const path = await secretsFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, data: { version: 1, services: {} } };
    }
    throw error;
  }
  const data = JSON.parse(raw) as FileShape;
  if (data?.version !== 1 || typeof data.services !== "object" || data.services === null) {
    throw new Error(
      `${path} is not a hatchkit secrets file (expected {"version":1,"services":{}}).`,
    );
  }
  return { path, data };
}

function save(path: string, data: FileShape): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync keeps an existing file's mode; force it on the temp file.
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

const fileSecretStore: SecretBackend = {
  async getPassword(service, account) {
    const { data } = await load();
    return data.services[service]?.[account] ?? null;
  },
  async setPassword(service, account, password) {
    const { path, data } = await load();
    data.services[service] = { ...data.services[service], [account]: password };
    save(path, data);
  },
  async deletePassword(service, account) {
    const { path, data } = await load();
    const entries = data.services[service];
    if (!entries || !(account in entries)) return false;
    delete entries[account];
    if (Object.keys(entries).length === 0) delete data.services[service];
    save(path, data);
    return true;
  },
  async findCredentials(service) {
    const { data } = await load();
    return Object.entries(data.services[service] ?? {}).map(([account, password]) => ({
      account,
      password,
    }));
  },
};

export default fileSecretStore;
