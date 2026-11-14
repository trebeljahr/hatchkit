// Fixture credentials only. Never imports or falls back to the OS backend.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.env.HATCHKIT_TEST_KEYCHAIN_DIR;
if (!root) throw new Error("Test keychain requires an isolated fixture directory.");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const directory = (service) => join(root, "secrets", hash(service));
const location = (service, account) => join(directory(service), `${hash(account)}.json`);
function read(service, account) {
  try {
    return JSON.parse(readFileSync(location(service, account), "utf8")).password;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const store = {
  async getPassword(service, account) {
    return read(service, account);
  },
  async setPassword(service, account, password) {
    mkdirSync(directory(service), { recursive: true, mode: 0o700 });
    const target = location(service, account);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ account, password }), { mode: 0o600 });
    renameSync(temp, target);
  },
  async deletePassword(service, account) {
    try {
      unlinkSync(location(service, account));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  },
  async findCredentials(service) {
    let entries;
    try {
      entries = readdirSync(directory(service));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(directory(service), name), "utf8")));
  },
  async findPassword(service) {
    return (await store.findCredentials(service))[0]?.password ?? null;
  },
};
export default store;
