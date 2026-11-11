/*
 * The side effects `hatchkit auth providers` needs from the machine: the
 * clipboard, the Trash, a browser. Behind one interface so the tests swap
 * in fakes and never touch the real clipboard.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { execa } from "execa";

export interface ProvidersIo {
  /** The clipboard as text, or null when this machine has no clipboard
   *  tool hatchkit can use (the caller then asks for a hidden paste). */
  readClipboard(): Promise<string | null>;
  /** Empty the clipboard after a read, so a secret does not linger. */
  clearClipboard(): Promise<void>;
  openBrowser(url: string): Promise<void>;
  /** Move a file to the Trash. Returns where it went, or null when this
   *  machine has no Trash hatchkit can reach (the file stays). */
  trash(path: string): Promise<string | null>;
  /** Where browsers save downloads: Apple's `.p8` lands here. */
  downloadsDir: string;
}

const isMac = process.platform === "darwin";

async function readMacClipboard(): Promise<string | null> {
  const res = await execa("pbpaste", [], { reject: false, stripFinalNewline: false });
  return res.exitCode === 0 ? String(res.stdout) : null;
}

async function clearMacClipboard(): Promise<void> {
  await execa("pbcopy", [], { input: "", reject: false });
}

/** `/usr/bin/trash` (macOS 14 and later) keeps Finder's Put Back. Older
 *  systems get a plain move into `~/.Trash`, renamed on a collision. */
async function trashOnMac(path: string): Promise<string | null> {
  if (existsSync("/usr/bin/trash")) {
    const res = await execa("/usr/bin/trash", [path], { reject: false });
    if (res.exitCode === 0) return "the Trash";
  }
  const trashDir = join(homedir(), ".Trash");
  mkdirSync(trashDir, { recursive: true });
  const ext = extname(path);
  const stem = basename(path, ext);
  let target = join(trashDir, basename(path));
  for (let i = 2; existsSync(target); i++) target = join(trashDir, `${stem} ${i}${ext}`);
  renameSync(path, target);
  return "the Trash";
}

export function systemIo(): ProvidersIo {
  return {
    readClipboard: () => (isMac ? readMacClipboard() : Promise.resolve(null)),
    clearClipboard: () => (isMac ? clearMacClipboard() : Promise.resolve()),
    async openBrowser(url) {
      const opener = isMac ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      await execa(opener, [url], { reject: false });
    },
    trash: (path) => (isMac ? trashOnMac(path) : Promise.resolve(null)),
    downloadsDir: join(homedir(), "Downloads"),
  };
}
