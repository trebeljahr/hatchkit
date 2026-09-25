#!/usr/bin/env node
/*
 * Generate the desktop app's bitmaps from build/icon.png:
 *
 *   build/icon.icns, build/icon.ico          — the app icon (macOS, Windows)
 *   electron/assets/tray/trayTemplate.png    — the macOS menu bar item
 *   electron/assets/tray/trayTemplate@2x.png
 *   electron/assets/tray/tray.png            — the Linux tray item
 *   electron/assets/tray/tray@2x.png
 *   electron/assets/tray/tray.ico            — the Windows notification area
 *   electron/assets/tray/overlay-badge.png   — the Windows taskbar overlay
 *
 * Linux uses build/icon.png directly via the electron-builder config, so no
 * Linux app-icon format is emitted here.
 *
 * scripts/build-desktop.mjs copies electron/assets/tray beside the bundle
 * (electron/dist/tray), which is where electron/src/tray.ts reads it in both a
 * packaged and an unpackaged run. The build runs this script itself when the
 * tray icons are missing, so a fresh checkout does not fail on them.
 *
 * Drop-in replacement for the legacy electron-icon-builder script, which
 * pulled phantomjs-prebuilt via icon-gen@2 → svg2png@4. We now use
 * icon-gen@5, which renders PNG variants through sharp.
 */
import iconGen from "icon-gen";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const src = path.join(root, "build", "icon.png");
const out = path.join(root, "build");

await iconGen(src, out, {
  report: true,
  ico: { name: "icon" },
  icns: { name: "icon" },
});

const trayDir = path.join(root, "electron", "assets", "tray");
mkdirSync(trayDir, { recursive: true });

function emit(name, buffer) {
  const file = path.join(trayDir, name);
  writeFileSync(file, buffer);
  console.log(`  ${path.relative(root, file)}`);
}

/** The icon scaled to a square, padded with transparency rather than cropped. */
function scaled(size) {
  return sharp(src)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha();
}

/*
 * macOS takes a *template* image for the menu bar: black on transparent, which
 * the OS tints for light and dark itself, and whose colours it strips. The
 * `Template` suffix is what tells Electron; `@2x` is picked up for Retina.
 *
 * The silhouette is the source icon's alpha channel filled with black, so an
 * icon whose background is opaque produces a solid black square. The check
 * below says so instead of leaving it to be discovered in the menu bar.
 */
for (const [size, name] of [
  [16, "trayTemplate.png"],
  [32, "trayTemplate@2x.png"],
]) {
  const alpha = await scaled(size).extractChannel("alpha").toBuffer();
  const silhouette = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  emit(name, silhouette);
}

// Windows and Linux draw the tray item in colour on a background nobody
// controls, so they get the icon itself. 22 and 44 are the AppIndicator sizes.
for (const [size, name] of [
  [22, "tray.png"],
  [44, "tray@2x.png"],
]) {
  emit(name, await scaled(size).png().toBuffer());
}

/*
 * Windows reads an `.ico` for the notification area (`trayIconFile("win32")`
 * in electron/src/tray-model.ts). One file carrying both sizes lets Windows
 * pick rather than scale, and a PNG scaled by Windows is visibly soft.
 * electron/src/tray.ts falls back to tray.png and warns when this is missing,
 * so a Windows launch without it works and says so on every start.
 */
emit(
  "tray.ico",
  icoFromPngs(
    await Promise.all(
      [16, 32].map(async (size) => ({ size, png: await scaled(size).png().toBuffer() })),
    ),
  ),
);

/*
 * The Windows taskbar overlay (`TRAY_OVERLAY_FILE`), drawn while the badge
 * count is not zero. A dot rather than the number: the overlay is a 16px
 * image, not text, so a count would have to be drawn into a bitmap per value.
 * The white ring keeps it visible on a light and a dark taskbar alike.
 * Replace the colour with the app's own; nothing else reads it.
 */
const OVERLAY_BADGE = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="26" fill="#DC2626" stroke="#FFFFFF" stroke-width="8"/>` +
    `</svg>`,
);
emit("overlay-badge.png", await sharp(OVERLAY_BADGE).resize(16, 16).png().toBuffer());

/** An ICO whose entries are PNGs — valid since Windows Vista, and what
 *  Explorer and the notification area read. Written here rather than pulled in
 *  as a dependency: the container is a 6-byte header and 16 bytes per size. */
function icoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    // 0 means 256 in an ICO directory; nothing here is that large.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

const stats = await sharp(src).ensureAlpha().stats();
if (stats.channels[3].min > 250) {
  console.warn(
    "\n  build/icon.png has no transparent background, so the macOS menu bar icon\n" +
      "  is a solid block. Give the icon a transparent background and re-run this.\n",
  );
}
