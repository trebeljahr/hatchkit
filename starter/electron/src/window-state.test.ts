import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_SIZE,
  WINDOW_STATE_FILE,
  backgroundColorFor,
  initialBounds,
  parseWindowState,
  readWindowState,
  writeWindowState,
} from "./window-state.ts";

const primary = { x: 0, y: 25, width: 1512, height: 920 };

describe("parseWindowState", () => {
  it("keeps well-formed fields and drops the rest", () => {
    assert.deepEqual(
      parseWindowState(
        JSON.stringify({
          bounds: { x: 10, y: 20, width: 900, height: 600 },
          maximized: true,
          extra: 1,
        }),
      ),
      { bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true },
    );
    assert.deepEqual(
      parseWindowState(JSON.stringify({ bounds: { x: "1" }, fullscreen: "yes" })),
      {},
    );
  });

  it("treats a missing or corrupt file as no state", () => {
    assert.deepEqual(parseWindowState(null), {});
    assert.deepEqual(parseWindowState("{not json"), {});
    assert.deepEqual(parseWindowState("null"), {});
  });
});

describe("readWindowState / writeWindowState", () => {
  it("round-trips through the profile directory and merges patches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "window-state-"));
    assert.deepEqual(readWindowState(dir), {});
    writeWindowState(dir, { bounds: { x: 1, y: 2, width: 900, height: 600 }, maximized: false });
    writeWindowState(dir, { maximized: true });
    assert.deepEqual(readWindowState(dir), {
      bounds: { x: 1, y: 2, width: 900, height: 600 },
      maximized: true,
    });
    fs.rmSync(path.join(dir, WINDOW_STATE_FILE));
    fs.rmdirSync(dir);
  });
});

describe("initialBounds", () => {
  it("uses the default size with nothing saved", () => {
    assert.deepEqual(initialBounds(undefined, [primary]), { ...DEFAULT_SIZE });
  });

  it("restores bounds that are on a display", () => {
    assert.deepEqual(initialBounds({ x: 100, y: 80, width: 1000, height: 700 }, [primary]), {
      x: 100,
      y: 80,
      width: 1000,
      height: 700,
    });
  });

  it("keeps the size but drops the position of a window on a missing display", () => {
    assert.deepEqual(initialBounds({ x: 3000, y: 80, width: 1000, height: 700 }, [primary]), {
      width: 1000,
      height: 700,
    });
  });

  it("raises a too-small size to the minimum", () => {
    assert.deepEqual(initialBounds({ x: 100, y: 80, width: 200, height: 100 }, [primary]), {
      x: 100,
      y: 80,
      width: 800,
      height: 500,
    });
  });
});

describe("backgroundColorFor", () => {
  it("matches the client's --background token", () => {
    assert.equal(backgroundColorFor(false), "#ffffff");
    assert.equal(backgroundColorFor(true), "#0a0a0a");
  });
});
