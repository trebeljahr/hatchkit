/*
 * The map plate as inline SVG. Pure: FleetMap in, markup out.
 *
 * Layout: the public side (platforms, then outside services) on top,
 * the tailnet (this machine, servers, devices) below it inside a dashed
 * zone. Each side is one or more rows of node boxes, wrapped to the
 * plate width. Edges are orthogonal: out of a box's bottom or top, along
 * a lane in the channel between two rows, into the other box. Lanes are
 * packed so labels on one lane never overlap.
 */

import type { MapComponent, MapEdge, MapNode, Tier } from "./model.js";

export const PLATE_WIDTH = 1440;
const MARGIN = 28;
const GAP_X = 28;
const TITLE_H = 54;
const ROW_H = 18;
const NOTE_H = 14;
const PAD_BOTTOM = 14;
const LANE = 24;
const CHANNEL_PAD = 22;
const ZONE_PAD = 18;
const CHAR = 6.2; // average glyph width at 12.5px
const MONO = 6.3; // at 10.5px mono
const MIN_W = 150;
const MAX_W = 236;
const MAX_ROWS_SHOWN = 14;

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clip(text: string, width: number, char = CHAR): string {
  const max = Math.max(4, Math.floor(width / char));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Box {
  node: MapNode;
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  shown: MapComponent[];
  hidden: number;
}

function nodeWidth(node: MapNode): number {
  const texts = [
    node.name.length * 8.4,
    (node.subtitle?.length ?? 0) * MONO,
    ...node.components.map((c) => c.label.length * CHAR + 30),
  ];
  return Math.round(Math.min(MAX_W, Math.max(MIN_W, ...texts) + 24));
}

function nodeHeight(shown: MapComponent[], hidden: number): number {
  let h = TITLE_H;
  for (const c of shown) h += ROW_H + (c.note ? NOTE_H : 0);
  if (hidden) h += ROW_H;
  return h + PAD_BOTTOM;
}

/** Order inside a side: platforms, world, then this machine, servers, devices. */
const KIND_ORDER = { platform: 0, world: 1, device: 2, server: 3 } as const;

/** Wrap a side into rows that fit the plate, balanced so a wrap never
 *  leaves one box alone on the last row. */
export function rowsFor(nodes: MapNode[], width = PLATE_WIDTH): MapNode[][] {
  const avail = width - 2 * MARGIN;
  const widths = nodes.map(nodeWidth);
  const total = widths.reduce((a, b) => a + b + GAP_X, -GAP_X);
  if (nodes.length === 0) return [];
  if (total <= avail) return [nodes];
  const target = total / Math.ceil(total / avail);
  const rows: MapNode[][] = [];
  let cur: MapNode[] = [];
  let used = 0;
  nodes.forEach((n, i) => {
    const w = widths[i] + (cur.length ? GAP_X : 0);
    if (cur.length && (used + w > avail || used >= target)) {
      rows.push(cur);
      cur = [];
      used = 0;
    }
    used += cur.length ? widths[i] + GAP_X : widths[i];
    cur.push(n);
  });
  if (cur.length) rows.push(cur);
  return rows;
}

interface Attach {
  edge: number;
  box: Box;
  side: "top" | "bottom";
  other: number;
  x?: number;
}

export interface Plate {
  svg: string;
  width: number;
  height: number;
}

export function renderPlate(nodes: MapNode[], edges: MapEdge[]): Plate {
  const sorted = (zone: "public" | "tailnet") => {
    const list = nodes.filter((n) => n.zone === zone);
    return list
      .map((n, i) => ({ n, i }))
      .sort((a, b) => {
        // Devices other than this machine go after the servers.
        const ka = a.n.kind === "device" && a.n.id !== "local" ? 4 : KIND_ORDER[a.n.kind];
        const kb = b.n.kind === "device" && b.n.id !== "local" ? 4 : KIND_ORDER[b.n.kind];
        return ka - kb || a.i - b.i;
      })
      .map((x) => x.n);
  };
  const publicRows = rowsFor(sorted("public"));
  const tailnetRows = rowsFor(sorted("tailnet"));
  const rows = [...publicRows, ...tailnetRows];
  const firstTailnetRow = publicRows.length;

  // Boxes, x only for now.
  const boxes = new Map<string, Box>();
  rows.forEach((row, r) => {
    const widths = row.map(nodeWidth);
    const total = widths.reduce((a, b) => a + b, 0) + GAP_X * (row.length - 1);
    let x = Math.max(MARGIN, Math.round((PLATE_WIDTH - total) / 2));
    row.forEach((node, i) => {
      const shown = node.components.slice(0, MAX_ROWS_SHOWN);
      const hidden = node.components.length - shown.length;
      boxes.set(node.id, {
        node,
        x,
        y: 0,
        w: widths[i],
        h: nodeHeight(shown, hidden),
        row: r,
        shown,
        hidden,
      });
      x += widths[i] + GAP_X;
    });
  });

  // Edges between placed boxes. Each leaves the upper box's bottom (or,
  // within one row, both bottoms), runs along a lane in the channel under
  // the upper row, and enters the lower box's top. An edge that skips a
  // row drops through a gutter between that row's boxes and takes a
  // second lane in the channel above the lower box.
  const live = edges.filter((e) => boxes.has(e.from) && boxes.has(e.to));
  const attaches: Attach[] = [];
  interface Route {
    upper: Attach;
    lower: Attach;
    reversed: boolean;
    c1: number;
    c2?: number;
    gx?: number;
    lane1: number;
    lane2: number;
  }
  const routes: Route[] = [];
  live.forEach((e, i) => {
    const a = boxes.get(e.from) as Box;
    const b = boxes.get(e.to) as Box;
    const same = a.row === b.row;
    const [up, low] = a.row <= b.row ? [a, b] : [b, a];
    const upper: Attach = { edge: i, box: up, side: "bottom", other: low.x + low.w / 2 };
    const lower: Attach = {
      edge: i,
      box: low,
      side: same ? "bottom" : "top",
      other: up.x + up.w / 2,
    };
    attaches.push(upper, lower);
    routes.push({
      upper,
      lower,
      reversed: up !== a,
      c1: up.row,
      c2: low.row - up.row > 1 ? low.row - 1 : undefined,
      lane1: 0,
      lane2: 0,
    });
  });
  // Spread attach points along each side, ordered by where the other end is.
  const groups = new Map<string, Attach[]>();
  for (const at of attaches) {
    const key = `${at.box.node.id}:${at.side}`;
    groups.set(key, [...(groups.get(key) ?? []), at]);
  }
  for (const list of groups.values()) {
    list.sort((p, q) => p.other - q.other || p.edge - q.edge);
    const { x, w } = list[0].box;
    const inset = Math.min(26, w / 6);
    list.forEach((at, k) => {
      at.x = Math.round(x + inset + ((w - 2 * inset) * (k + 0.5)) / list.length);
    });
  }

  // Gutters for edges that skip rows: an x clear of every box in between.
  const gutterUse = new Map<number, number>();
  for (const r of routes) {
    if (r.c2 === undefined) continue;
    const between = [...boxes.values()].filter((b) => b.row > r.c1 && b.row <= (r.c2 as number));
    const candidates = new Set<number>([MARGIN / 2, PLATE_WIDTH - MARGIN / 2]);
    for (let row = r.c1 + 1; row <= r.c2; row++) {
      const inRow = between.filter((b) => b.row === row).sort((p, q) => p.x - q.x);
      inRow.forEach((b, k) => {
        candidates.add(b.x - GAP_X / 2);
        if (k === inRow.length - 1) candidates.add(b.x + b.w + GAP_X / 2);
      });
    }
    const clear = [...candidates].filter((x) =>
      between.every((b) => x < b.x - 4 || x > b.x + b.w + 4),
    );
    const want = ((r.upper.x as number) + (r.lower.x as number)) / 2;
    const gx = clear.sort((p, q) => Math.abs(p - want) - Math.abs(q - want))[0];
    const used = gutterUse.get(gx) ?? 0;
    gutterUse.set(gx, used + 1);
    r.gx = Math.round(gx + (used % 2 ? 1 : -1) * Math.ceil(used / 2) * 6);
  }

  // Lane packing per channel; labels ride the first horizontal segment.
  const lanesIn = new Map<number, Array<Array<[number, number]>>>();
  const take = (channel: number, from: number, to: number, label: string): number => {
    const mid = (from + to) / 2;
    const lw = label ? label.length * MONO + 12 : 0;
    const span: [number, number] = [
      Math.min(from, to, mid - lw / 2) - 6,
      Math.max(from, to, mid + lw / 2) + 6,
    ];
    const lanes = lanesIn.get(channel) ?? [];
    let k = lanes.findIndex((l) => l.every(([a, b]) => span[1] < a || span[0] > b));
    if (k < 0) {
      lanes.push([]);
      k = lanes.length - 1;
    }
    lanes[k].push(span);
    lanesIn.set(channel, lanes);
    return k;
  };
  routes.forEach((r, i) => {
    const ux = r.upper.x as number;
    const lx = r.lower.x as number;
    if (r.c2 === undefined) {
      r.lane1 = take(r.c1, ux, lx, live[i].label);
    } else {
      r.lane1 = take(r.c1, ux, r.gx as number, live[i].label);
      r.lane2 = take(r.c2, r.gx as number, lx, "");
    }
  });

  // Vertical placement: rows, channels, the zone gap.
  const rowTop: number[] = [];
  const channelTop: number[] = [];
  let y = 64;
  rows.forEach((row, r) => {
    if (r === firstTailnetRow && r > 0) y += ZONE_PAD + 24;
    rowTop[r] = y;
    const h = Math.max(...row.map((n) => (boxes.get(n.id) as Box).h));
    for (const n of row) (boxes.get(n.id) as Box).y = y;
    y += h;
    channelTop[r] = y;
    const lanes = lanesIn.get(r)?.length ?? 0;
    y += lanes ? CHANNEL_PAD + lanes * LANE : r === rows.length - 1 ? 0 : 40;
  });
  const zoneTop = firstTailnetRow < rows.length ? rowTop[firstTailnetRow] - ZONE_PAD : 0;
  const height = y + 60;

  const out: string[] = [];
  out.push(`<rect x="8" y="8" width="${PLATE_WIDTH - 16}" height="${height - 16}" class="frame"/>`);
  out.push(`<text x="${MARGIN}" y="44" class="zone-l">PUBLIC INTERNET</text>`);
  if (firstTailnetRow < rows.length) {
    out.push(
      `<rect x="16" y="${zoneTop}" width="${PLATE_WIDTH - 32}" height="${height - zoneTop - 28}" rx="12" class="zone"/>`,
    );
    out.push(`<text x="${MARGIN}" y="${zoneTop + 18}" class="zone-l">TAILNET</text>`);
  }

  for (const box of boxes.values()) out.push(renderBox(box));

  const laneY = (channel: number, lane: number) =>
    channelTop[channel] + CHANNEL_PAD / 2 + 8 + lane * LANE;
  live.forEach((e, i) => {
    const r = routes[i];
    const ux = r.upper.x as number;
    const lx = r.lower.x as number;
    const uy = r.upper.box.y + r.upper.box.h;
    const ly = r.lower.side === "bottom" ? r.lower.box.y + r.lower.box.h : r.lower.box.y;
    const y1 = laneY(r.c1, r.lane1);
    let pts: Array<[number, number]> =
      r.c2 === undefined
        ? [
            [ux, uy],
            [ux, y1],
            [lx, y1],
            [lx, ly],
          ]
        : [
            [ux, uy],
            [ux, y1],
            [r.gx as number, y1],
            [r.gx as number, laneY(r.c2, r.lane2)],
            [lx, laneY(r.c2, r.lane2)],
            [lx, ly],
          ];
    if (r.reversed) pts = pts.reverse();
    const d = `M${pts.map(([px, py]) => `${px} ${py}`).join(" L")}`;
    const cls = `edge${e.manual ? " dashed" : ""}`;
    const start = e.both ? ' marker-start="url(#arr)"' : "";
    out.push(`<path d="${d}" class="${cls}" marker-end="url(#arr)"${start}/>`);
    if (e.label) {
      const end = r.c2 === undefined ? lx : (r.gx as number);
      out.push(
        `<text x="${Math.round((ux + end) / 2)}" y="${y1 - 5}" class="e-label halo" text-anchor="middle">${esc(e.label)}</text>`,
      );
    }
  });

  const svg =
    `<svg class="map" viewBox="0 0 ${PLATE_WIDTH} ${height}" role="img" aria-label="${esc(ariaLabel(nodes, live))}">` +
    '<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="currentColor"/></marker></defs>' +
    out.join("") +
    "</svg>";
  return { svg, width: PLATE_WIDTH, height };
}

export function marker(
  tier: Tier | undefined,
  gap: boolean | undefined,
  cx: number,
  cy: number,
): string {
  if (gap)
    return `<path d="M${cx} ${cy - 4.6} L${cx + 4.4} ${cy + 3.4} L${cx - 4.4} ${cy + 3.4} Z" class="mk-gap"/>`;
  if (tier === "listed") return `<circle cx="${cx}" cy="${cy}" r="3.7" class="mk-listed"/>`;
  if (tier === "made") return `<circle cx="${cx}" cy="${cy}" r="3.2" class="mk-made"/>`;
  if (tier === "outside")
    return `<line x1="${cx - 3.8}" y1="${cy}" x2="${cx + 3.8}" y2="${cy}" class="mk-outside"/>`;
  return "";
}

function renderBox(box: Box): string {
  const { node, x, y, w, h } = box;
  const out: string[] = [];
  out.push(`<g class="node-g" data-node="${esc(node.id)}">`);
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" class="node"/>`);
  out.push(
    `<text x="${x + 14}" y="${y + 25}" class="n-title">${esc(clip(node.name, w - 28, 8.4))}</text>`,
  );
  if (node.subtitle) {
    out.push(
      `<text x="${x + 14}" y="${y + 41}" class="n-sub">${esc(clip(node.subtitle, w - 28, MONO))}</text>`,
    );
  }
  let cy = y + TITLE_H + 12;
  for (const c of box.shown) {
    out.push(marker(c.tier, c.gap, x + 18, cy - 4));
    const cls = c.gap ? "n-gaptext" : "n-item";
    const tx = c.tier || c.gap ? x + 28 : x + 14;
    out.push(
      `<text x="${tx}" y="${cy}" class="${cls}">${esc(clip(c.label, x + w - 10 - tx))}</text>`,
    );
    cy += ROW_H;
    if (c.note) {
      cy -= 3.5;
      out.push(
        `<text x="${tx}" y="${cy}" class="n-note">${esc(clip(c.note, x + w - 10 - tx, 6.1))}</text>`,
      );
      cy += NOTE_H + 3.5;
    }
  }
  if (box.hidden) {
    out.push(`<text x="${x + 14}" y="${cy}" class="n-note">+${box.hidden} more below</text>`);
  }
  out.push("</g>");
  return out.join("");
}

function ariaLabel(nodes: MapNode[], edges: MapEdge[]): string {
  const name = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  const places = nodes.map((n) => `${n.name} (${n.components.map((c) => c.label).join(", ")})`);
  const flows = edges.map(
    (e) => `${name(e.from)} to ${name(e.to)}${e.label ? `: ${e.label}` : ""}`,
  );
  return `Fleet map. Places: ${places.join("; ")}. Connections: ${flows.join("; ")}.`;
}
