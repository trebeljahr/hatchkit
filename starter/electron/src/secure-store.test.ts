import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  MOCK_KEYCHAIN_SWITCH,
  createSecureStore,
  platformBackend,
  safeStorageEncryption,
  sessionFileAt,
  type Encryption,
  type SafeStorageLike,
  type SessionFile,
} from "./secure-store.ts";

/** Reversible and visibly not the plaintext, so a test can tell the two apart. */
const fakeEncryption = (backend: string, available = true): Encryption & { broken: boolean } => {
  const enc = {
    broken: false,
    isAvailable: () => available,
    backend: () => backend,
    encrypt: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString("base64")}`),
    decrypt: (cipher: Buffer) => {
      if (enc.broken) throw new Error("Error while decrypting the ciphertext provided to safeStorage");
      const text = cipher.toString();
      if (!text.startsWith("enc:")) throw new Error("not ours");
      return Buffer.from(text.slice(4), "base64").toString();
    },
  };
  return enc;
};

const memoryFile = (initial: Buffer | null = null): SessionFile & { data: Buffer | null } => {
  const file = {
    data: initial,
    read: () => file.data,
    write: (data: Buffer) => {
      file.data = data;
    },
    remove: () => {
      file.data = null;
    },
  };
  return file;
};

const store = (encryption: Encryption, file: SessionFile) =>
  createSecureStore({ dir: "/unused", encryption, file });

describe("createSecureStore", () => {
  it("writes ciphertext, never the token, and reads it back in a new run", () => {
    const file = memoryFile();
    const first = store(fakeEncryption("keychain"), file);
    assert.deepEqual(first.setToken("abc.def="), { persistent: true, backend: "keychain" });
    assert.ok(file.data);
    assert.equal(file.data.toString().includes("abc.def="), false);

    const relaunch = store(fakeEncryption("keychain"), file);
    assert.equal(relaunch.getToken(), "abc.def=");
  });

  it("refuses to persist on basic_text and keeps the token for this run only", () => {
    const file = memoryFile();
    const first = store(fakeEncryption("basic_text"), file);
    assert.deepEqual(first.setToken("secret"), { persistent: false, backend: "basic_text" });
    assert.equal(first.getToken(), "secret");
    assert.equal(file.data, null);

    const relaunch = store(fakeEncryption("basic_text"), file);
    assert.equal(relaunch.getToken(), null);
  });

  it("treats an unknown backend as no encryption either", () => {
    const file = memoryFile();
    assert.deepEqual(store(fakeEncryption("unknown"), file).status(), {
      persistent: false,
      backend: "unknown",
    });
  });

  it("does not persist when encryption is unavailable", () => {
    const file = memoryFile();
    const unavailable = store(fakeEncryption("gnome_libsecret", false), file);
    assert.deepEqual(unavailable.status(), { persistent: false, backend: "unavailable" });
    unavailable.setToken("secret");
    assert.equal(file.data, null);
  });

  it("removes an older ciphertext when a new token cannot be written", () => {
    const file = memoryFile();
    store(fakeEncryption("gnome_libsecret"), file).setToken("old");
    assert.ok(file.data);
    store(fakeEncryption("basic_text"), file).setToken("new");
    assert.equal(file.data, null);
  });

  it("signs out, and deletes the file, when the ciphertext no longer decrypts", () => {
    const file = memoryFile();
    store(fakeEncryption("keychain"), file).setToken("token");
    const encryption = fakeEncryption("keychain");
    encryption.broken = true;
    const relaunch = store(encryption, file);
    assert.equal(relaunch.getToken(), null);
    assert.equal(file.data, null);
  });

  it("forgets on delete, in memory and on disk", () => {
    const file = memoryFile();
    const signedIn = store(fakeEncryption("dpapi"), file);
    signedIn.setToken("token");
    signedIn.deleteToken();
    assert.equal(signedIn.getToken(), null);
    assert.equal(file.data, null);
  });

  it("ignores an empty token rather than storing it", () => {
    const file = memoryFile();
    const signedIn = store(fakeEncryption("keychain"), file);
    signedIn.setToken("good");
    signedIn.setToken("");
    assert.equal(signedIn.getToken(), "good");
    assert.equal(store(fakeEncryption("keychain"), file).getToken(), "good");
  });
});

describe("sessionFileAt", () => {
  it("writes an owner-only file atomically and removes it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "desktop-secure-store-"));
    const file = sessionFileAt(path.join(dir, "profile"));
    assert.equal(file.read(), null);
    file.write(Buffer.from("cipher"));
    const target = path.join(dir, "profile", "session.bin");
    assert.equal(readFileSync(target, "utf8"), "cipher");
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
    file.remove();
    assert.equal(file.read(), null);
    // Removing what is already gone is not an error: deleteToken runs on every
    // sign-out, including one where nothing was ever written.
    file.remove();
  });

  it("is the default file when the caller passes only a directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "desktop-secure-store-"));
    const signedIn = createSecureStore({ dir, encryption: fakeEncryption("keychain") });
    signedIn.setToken("token");
    assert.equal(readFileSync(path.join(dir, "session.bin"), "utf8").startsWith("enc:"), true);
    assert.equal(
      createSecureStore({ dir, encryption: fakeEncryption("keychain") }).getToken(),
      "token",
    );
  });
});

describe("platformBackend", () => {
  it("names the macOS and Windows backends", () => {
    assert.equal(platformBackend("darwin"), "keychain");
    assert.equal(platformBackend("win32"), "dpapi");
    assert.equal(platformBackend("linux"), "unknown");
  });
});

describe("safeStorageEncryption", () => {
  const fakeSafeStorage = (backend: string): SafeStorageLike => ({
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`ss:${plain}`),
    decryptString: (cipher) => cipher.toString().slice(3),
    getSelectedStorageBackend: () => backend,
  });

  it("asks safeStorage for the backend on Linux only", () => {
    assert.equal(safeStorageEncryption(fakeSafeStorage("kwallet6"), "linux").backend(), "kwallet6");
    // On macOS and Windows the API does not answer, so the platform names it.
    assert.equal(safeStorageEncryption(fakeSafeStorage("kwallet6"), "darwin").backend(), "keychain");
    assert.equal(safeStorageEncryption(fakeSafeStorage("kwallet6"), "win32").backend(), "dpapi");
  });

  it("reports unknown when the Linux backend cannot be read", () => {
    const throws: SafeStorageLike = {
      ...fakeSafeStorage("gnome_libsecret"),
      getSelectedStorageBackend: () => {
        throw new Error("no backend");
      },
    };
    assert.equal(safeStorageEncryption(throws, "linux").backend(), "unknown");
    const missing: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: (cipher) => cipher.toString(),
    };
    assert.equal(safeStorageEncryption(missing, "linux").backend(), "unknown");
  });

  it("round-trips a token through the injected safeStorage", () => {
    const encryption = safeStorageEncryption(fakeSafeStorage("gnome_libsecret"), "linux");
    const file = memoryFile();
    assert.deepEqual(store(encryption, file).setToken("bearer"), {
      persistent: true,
      backend: "gnome_libsecret",
    });
    assert.equal(store(encryption, file).getToken(), "bearer");
  });
});

describe("MOCK_KEYCHAIN_SWITCH", () => {
  it("is the Chromium switch name, without the leading dashes", () => {
    // `app.commandLine.appendSwitch` takes the bare name; passing
    // "--use-mock-keychain" registers a switch called "-use-mock-keychain",
    // which Chromium ignores and which nothing reports.
    assert.equal(MOCK_KEYCHAIN_SWITCH, "use-mock-keychain");
  });
});
