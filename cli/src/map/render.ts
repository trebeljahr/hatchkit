/*
 * FleetMap → one self-contained HTML page: header with counts, the map
 * plate, what hatchkit sees, every place in detail, projects, background
 * jobs, loose ends and the sources read. No scripts, no external
 * requests; system fonts only, light and dark.
 */

import { esc, marker, renderPlate } from "./layout.js";
import type { FleetMap, Health, MapComponent, MapItem, MapJob, Tier } from "./model.js";

const TIER_LABEL: Record<Tier, string> = {
  listed: "listed by hatchkit overview",
  made: "set up by hatchkit, listed nowhere",
  outside: "outside hatchkit",
};

function dot(tier: Tier | undefined, gap?: boolean): string {
  if (!tier && !gap) return "";
  return `<svg class="mk" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${marker(tier, gap, 6, 6.5)}</svg>`;
}

function health(h: Health | undefined): string {
  if (!h || h === "ok") return "";
  return ` <span class="h-${h}">${h === "fail" ? "failing" : "check"}</span>`;
}

function itemList(items: MapItem[] | undefined): string {
  if (!items?.length) return "";
  return `<ul class="items">${items
    .map(
      (i) =>
        `<li>${dot(i.tier)}<span>${esc(i.name)}</span>${i.note ? ` <small>${esc(i.note)}</small>` : ""}${health(i.health)}</li>`,
    )
    .join("")}</ul>`;
}

function componentRow(c: MapComponent): string {
  const tierText = c.gap ? "known gap" : c.tier ? TIER_LABEL[c.tier] : "";
  const head = `${dot(c.tier, c.gap)}<b${c.gap ? ' class="gaptext"' : ""}>${esc(c.label)}</b>${c.note ? ` <small>${esc(c.note)}</small>` : ""}`;
  const meta = `<span class="meta">${esc(tierText)}${tierText ? " · " : ""}${esc(c.source)}</span>`;
  if (c.items?.length) {
    return `<li><details><summary>${head} ${meta}</summary>${itemList(c.items)}</details></li>`;
  }
  return `<li>${head} ${meta}</li>`;
}

function jobsTable(jobs: MapJob[]): string {
  const groups = new Map<string, MapJob[]>();
  for (const j of jobs) groups.set(j.where, [...(groups.get(j.where) ?? []), j]);
  return [...groups]
    .map(
      ([where, list]) =>
        `<tbody><tr class="grp"><th colspan="3" scope="colgroup">${esc(where)} <span>${list.length}</span></th></tr>${list
          .map(
            (j) =>
              `<tr><td>${dot(j.tier)}<b>${esc(j.name)}</b>${health(j.health)}${j.detail ? `<small>${esc(j.detail)}</small>` : ""}</td><td class="when">${esc(j.when)}</td><td>${esc(j.what ?? "")}</td></tr>`,
          )
          .join("")}</tbody>`,
    )
    .join("");
}

export function renderMapHtml(map: FleetMap): string {
  const plate = renderPlate(map.nodes, map.edges);
  const t = map.tiers;
  const total = t.listed + t.made + t.outside;
  const date = map.generatedAt.slice(0, 10);
  const byTier = (tier: Tier) =>
    map.nodes.flatMap((n) =>
      n.components.filter((c) => c.tier === tier && !c.gap).map((c) => `${c.label} (${n.name})`),
    );

  const stats = map.stats
    .map((s) => `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`)
    .join("");

  const places = map.nodes
    .map((n) => {
      const outgoing = map.edges
        .filter((e) => e.from === n.id || e.to === n.id)
        .map((e) => {
          const other = map.nodes.find((x) => x.id === (e.from === n.id ? e.to : e.from));
          const arrow = e.both ? "↔" : e.from === n.id ? "→" : "←";
          return `<li>${arrow} ${esc(other?.name ?? "?")}${e.label ? `: ${esc(e.label)}` : ""}${e.manual ? " <small>(waits for you)</small>" : ""}</li>`;
        })
        .join("");
      return `<article class="place"><h3>${esc(n.name)}</h3>${n.subtitle ? `<p class="sub">${esc(n.subtitle)}</p>` : ""}<ul class="comps">${n.components.map(componentRow).join("")}</ul>${outgoing ? `<ul class="flows">${outgoing}</ul>` : ""}</article>`;
    })
    .join("");

  const projects = map.projectGroups
    .map((g) => {
      const rows = map.projects.filter((p) => p.group === g);
      return `<tbody><tr class="grp"><th colspan="5" scope="colgroup">${esc(g)} <span>${rows.length}</span></th></tr>${rows
        .map((p) => {
          const chips = p.ships.map((s) => `<span class="chip">${esc(s)}</span>`).join("");
          const doms = p.domains.length
            ? `${esc(p.domains.slice(0, 2).join(", "))}${p.domains.length > 2 ? ` <small>+${p.domains.length - 2}</small>` : ""}`
            : '<span class="dim">–</span>';
          return `<tr><td class="pname">${dot(p.tier)}<b>${esc(p.name)}</b>${p.blurb ? `<small>${esc(p.blurb)}</small>` : ""}</td><td class="chips">${chips || '<span class="dim">–</span>'}</td><td class="dom">${doms}</td><td class="mono">${p.servers.length ? esc(p.servers.join(", ")) : '<span class="dim">–</span>'}</td><td class="mono">${p.hatchkit ? esc(p.hatchkit) : '<span class="dim">–</span>'}${p.lastCommit ? `<small>${esc(p.lastCommit)}</small>` : ""}</td></tr>`;
        })
        .join("")}</tbody>`;
    })
    .join("");

  const findings = map.findings
    .map(
      (f) =>
        `<li class="sev-${f.severity}"><b>${esc(f.title)}</b> ${esc(f.detail)} <small>${esc(f.source)}</small></li>`,
    )
    .join("");

  const sources = map.sources
    .map(
      (s) =>
        `<li class="src-${s.status}"><b>${esc(s.label)}</b> <span>${esc(s.status === "ok" ? "read" : s.status === "skip" ? "skipped" : "not read")}</span>${s.detail ? ` <small>${esc(s.detail)}</small>` : ""}</li>`,
    )
    .join("");

  const tierCol = (tier: Tier) => {
    const list = byTier(tier);
    return `<div><h3>${dot(tier)} ${list.length} ${esc(TIER_LABEL[tier])}</h3><ul>${list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`;
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="hatchkit ${esc(map.cliVersion)}">
<title>${esc(map.title)}</title>
<style>
:root {
  --paper: #EEF2F1; --sheet: #F9FBFA; --ink: #16202A; --muted: #586571; --rule: #C2CBCA;
  --zone: #E1E9F1; --accent: #2445C4; --warn: #9A5200; --warn-bg: #F5E8D4; --fail: #B3261E;
  --f-body: ui-sans-serif, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --f-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #0F151B; --sheet: #151D25; --ink: #DCE3E9; --muted: #8C98A4; --rule: #2B3640;
  --zone: #13202D; --accent: #86A2FF; --warn: #E8A658; --warn-bg: #2A2115; --fail: #FF8A80; color-scheme: dark; } }
:root[data-theme="dark"] {
  --paper: #0F151B; --sheet: #151D25; --ink: #DCE3E9; --muted: #8C98A4; --rule: #2B3640;
  --zone: #13202D; --accent: #86A2FF; --warn: #E8A658; --warn-bg: #2A2115; --fail: #FF8A80; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--f-body); font-size: 15px; line-height: 1.5; padding: 0 16px; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 40px 0 64px; display: grid; gap: 44px; }
.wide { max-width: 1440px; width: 100%; justify-self: center; }
header { display: grid; gap: 12px; }
.eyebrow { font-family: var(--f-mono); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { font-weight: 800; font-size: clamp(28px, 5vw, 48px); line-height: 1.05; margin: 0; letter-spacing: -.01em; text-transform: uppercase; }
.lede { max-width: 66ch; margin: 0; color: var(--muted); font-size: 17px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border-top: 1.5px solid var(--ink); border-left: 1px solid var(--rule); margin-top: 8px; }
.stat { display: grid; gap: 2px; padding: 12px 14px 14px; border-right: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.stat b { font-weight: 700; font-size: 26px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat span { font-size: 12.5px; color: var(--muted); line-height: 1.3; }
h2 { font-weight: 750; font-size: 21px; text-transform: uppercase; letter-spacing: .02em; margin: 0; }
h3 { font-size: 14px; margin: 0 0 6px; font-weight: 700; }
section { display: grid; gap: 14px; min-width: 0; }
section > p { margin: 0; max-width: 70ch; color: var(--muted); }
figure { margin: 0; display: grid; gap: 12px; }
.map-scroll { overflow-x: auto; }
svg.map { display: block; width: 100%; min-width: 1060px; height: auto; color: var(--ink); }
figcaption { font-size: 13.5px; color: var(--muted); max-width: 90ch; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 13px; align-items: center; }
.legend span { display: inline-flex; gap: 7px; align-items: center; }
.frame { fill: none; stroke: var(--ink); stroke-width: 1.4; }
.zone { fill: var(--zone); stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 4; }
.zone-l { font-weight: 700; font-size: 12px; letter-spacing: .14em; fill: var(--muted); }
.node { fill: var(--sheet); stroke: var(--ink); stroke-width: 1.2; }
.n-title { font-weight: 750; font-size: 15px; fill: var(--ink); }
.n-sub { font-family: var(--f-mono); font-size: 10.5px; fill: var(--muted); }
.n-item { font-size: 12.5px; fill: var(--ink); }
.n-note { font-size: 11px; fill: var(--muted); }
.n-gaptext { font-size: 12.5px; font-weight: 600; fill: var(--warn); }
.mk-listed { fill: var(--accent); }
.mk-made { fill: var(--sheet); stroke: var(--accent); stroke-width: 1.7; }
.mk-outside { stroke: var(--muted); stroke-width: 1.6; }
.mk-gap { fill: var(--warn); }
svg.mk { vertical-align: -1px; margin-right: 6px; overflow: visible; flex: none; }
.edge { fill: none; stroke: currentColor; stroke-width: 1.3; }
.edge.dashed { stroke-dasharray: 6 4; }
.e-label { font-family: var(--f-mono); font-size: 10.5px; fill: var(--ink); }
.halo { paint-order: stroke; stroke: var(--paper); stroke-width: 5px; stroke-linejoin: round; }
.tierbar { display: flex; height: 30px; border: 1px solid var(--ink); }
.tierbar div { display: flex; align-items: center; padding: 0 10px; font-family: var(--f-mono); font-size: 12px; white-space: nowrap; overflow: hidden; }
.tb-listed { background: var(--accent); color: var(--paper); }
.tb-made { background: var(--sheet); color: var(--accent); border-left: 1px solid var(--ink); border-right: 1px solid var(--ink); }
.tb-outside { background: var(--zone); color: var(--muted); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px 32px; }
.cols ul { margin: 0; padding-left: 18px; display: grid; gap: 3px; font-size: 13.5px; }
.places { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.place { background: var(--sheet); border: 1px solid var(--rule); border-top: 2px solid var(--ink); padding: 12px 14px; min-width: 0; }
.place h3 { font-size: 16px; margin: 0; }
.place .sub { margin: 0 0 8px; font-family: var(--f-mono); font-size: 11.5px; color: var(--muted); }
.comps, .flows, .items { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 13.5px; }
.flows { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--rule); font-family: var(--f-mono); font-size: 12px; }
.items { margin: 4px 0 6px 18px; font-size: 12.5px; }
.items li { display: flex; gap: 2px; align-items: baseline; flex-wrap: wrap; }
summary { cursor: pointer; }
small, .meta { color: var(--muted); font-size: 12px; }
.meta { font-family: var(--f-mono); font-size: 11px; }
.gaptext { color: var(--warn); }
.h-warn { color: var(--warn); font-family: var(--f-mono); font-size: 11px; }
.h-fail { color: var(--fail); font-family: var(--f-mono); font-size: 11px; font-weight: 600; }
.table-scroll { overflow-x: auto; border-top: 1.5px solid var(--ink); }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--rule); }
thead th { font-family: var(--f-mono); font-weight: 500; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
tr.grp th { font-weight: 700; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; padding-top: 18px; border-bottom: 1px solid var(--ink); }
tr.grp th span { font-family: var(--f-mono); font-weight: 400; color: var(--muted); margin-left: 6px; }
td small { display: block; }
.pname { min-width: 220px; }
.pname b { font-weight: 650; }
.chip { display: inline-block; font-family: var(--f-mono); font-size: 11px; padding: 1px 6px; margin: 0 4px 4px 0; border: 1px solid var(--rule); border-radius: 3px; background: var(--sheet); white-space: nowrap; }
.dom, .mono, .when { font-family: var(--f-mono); font-size: 12px; }
.when { white-space: nowrap; }
.dim { color: var(--muted); }
ol.loose { margin: 0; padding: 0; list-style: none; border-top: 1.5px solid var(--ink); counter-reset: le; }
ol.loose li { counter-increment: le; padding: 9px 12px 9px 44px; position: relative; border-bottom: 1px solid var(--rule); font-size: 14px; }
ol.loose li::before { content: counter(le); position: absolute; left: 10px; top: 9px; width: 22px; height: 22px; display: grid; place-items: center; font-family: var(--f-mono); font-size: 11.5px; background: var(--warn-bg); color: var(--warn); border-radius: 3px; }
ol.loose li.sev-info::before { background: var(--zone); color: var(--muted); }
ul.sources { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; font-size: 13.5px; }
.src-error span { color: var(--warn); font-family: var(--f-mono); font-size: 12px; }
.src-ok span, .src-skip span { color: var(--muted); font-family: var(--f-mono); font-size: 12px; }
footer { font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 14px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="eyebrow">hatchkit map · ${esc(date)}</div>
  <h1>${esc(map.title)}</h1>
  <p class="lede">Every project, server, edge service and background job, with a marker for what hatchkit can see. Read live; rerun <code>hatchkit map</code> to refresh.</p>
  <div class="stats">${stats}</div>
</header>

<figure class="wide">
  <div class="legend" aria-label="Map legend">
    <span>${dot("listed")}listed by <code>hatchkit overview</code></span>
    <span>${dot("made")}set up by hatchkit, listed nowhere</span>
    <span>${dot("outside")}outside hatchkit</span>
    <span>${dot(undefined, true)}known gap</span>
    <span><svg width="34" height="8" viewBox="0 0 34 8"><line x1="0" y1="4" x2="34" y2="4" class="edge" style="color:var(--ink)"/></svg>runs on its own</span>
    <span><svg width="34" height="8" viewBox="0 0 34 8"><line x1="0" y1="4" x2="34" y2="4" class="edge dashed" style="color:var(--ink)"/></svg>waits for you</span>
  </div>
  <div class="map-scroll">${plate.svg}</div>
  <figcaption>Boxes are places; marked lines inside are the pieces running there. Arrows show who starts the traffic. Details for every place follow below.</figcaption>
</figure>

<section>
  <h2>What hatchkit sees</h2>
  <p>Of the ${total} pieces marked on the map, <code>hatchkit overview</code> lists ${t.listed}. hatchkit set up ${t.made} more but lists them nowhere. The other ${t.outside} grew around it.${t.gaps ? ` ${t.gaps} known ${t.gaps === 1 ? "gap is" : "gaps are"} marked in amber.` : ""}</p>
  <div class="tierbar" role="img" aria-label="${t.listed} listed, ${t.made} set up but unlisted, ${t.outside} outside hatchkit">
    <div class="tb-listed" style="flex:${t.listed || 0.0001}">${t.listed} listed</div>
    <div class="tb-made" style="flex:${t.made || 0.0001}">${t.made} set up, unlisted</div>
    <div class="tb-outside" style="flex:${t.outside || 0.0001}">${t.outside} outside</div>
  </div>
  <div class="cols">${tierCol("listed")}${tierCol("made")}${tierCol("outside")}</div>
</section>

<section class="wide">
  <h2>Places</h2>
  <div class="places">${places}</div>
</section>

<section>
  <h2>Projects</h2>
  <p>${map.projects.length} projects from hatchkit's run ledgers, Worker tokens, Coolify, repo manifests and the extras registry. The hatchkit column names the strongest record: starter (created), adopted, manifest, provisioned, worker (deploy token only), coolify (app only).</p>
  <div class="table-scroll"><table>
    <thead><tr><th scope="col">Project</th><th scope="col">Ships to</th><th scope="col">Address</th><th scope="col">Server</th><th scope="col">hatchkit</th></tr></thead>
    ${projects}
  </table></div>
</section>

<section>
  <h2>Clockwork</h2>
  <p>${map.jobs.length} jobs run without you, on a clock or always on, grouped by where they run.</p>
  <div class="table-scroll"><table>
    <thead><tr><th scope="col">Job</th><th scope="col">When</th><th scope="col">What</th></tr></thead>
    ${jobsTable(map.jobs)}
  </table></div>
</section>

<section>
  <h2>Loose ends</h2>
  ${findings ? `<ol class="loose">${findings}</ol>` : "<p>Nothing found.</p>"}
</section>

<section>
  <h2>Sources</h2>
  <ul class="sources">${sources}</ul>
</section>

<footer>Generated by hatchkit ${esc(map.cliVersion)} on ${esc(map.generatedAt)}. Read-only: every provider call was a GET. Addresses, account ids and resource ids are left out on purpose.</footer>
</div>
</body>
</html>
`;
}
