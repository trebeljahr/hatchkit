/*
 * Schedules in words: cron (Workers), systemd calendar and monotonic
 * timers (hosts), launchd plists (the Mac). Each falls back to the raw
 * expression rather than guessing.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number | string) => String(n).padStart(2, "0");

export function seconds(n: number): string {
  if (n < 60) return `every ${n} s`;
  if (n % 3600 === 0) return n === 3600 ? "hourly" : `every ${n / 3600} h`;
  if (n % 60 === 0) return n === 60 ? "every minute" : `every ${n / 60} min`;
  return `every ${n} s`;
}

/** Five-field cron, as Cloudflare stores it (UTC). */
export function humanizeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return `cron ${expr}`;
  const [min, hour, dom, mon, dow] = f;
  const anyDay = dom === "*" && mon === "*";
  if (!anyDay) return `cron ${expr}`;
  const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
  if (min === "*" && hour === "*" && dow === "*") return "every minute";
  if (step(min) && hour === "*" && dow === "*") return seconds(Number(step(min)) * 60);
  if (/^\d+$/.test(min) && hour === "*" && dow === "*")
    return min === "0" ? "hourly" : `hourly at :${pad(min)}`;
  if (/^\d+$/.test(min) && step(hour) && dow === "*") return seconds(Number(step(hour)) * 3600);
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${pad(hour)}:${pad(min)} UTC`;
    if (dow === "*") return `daily ${time}`;
    if (/^\d$/.test(dow)) return `${DAYS[Number(dow) % 7]} ${time}`;
  }
  return `cron ${expr}`;
}

/** One normalized systemd `OnCalendar=` value (as `systemctl show` prints it). */
export function humanizeCalendar(spec: string): string {
  const s = spec.trim();
  const short: Record<string, string> = {
    minutely: "every minute",
    hourly: "hourly",
    daily: "daily 00:00",
    weekly: "Mon 00:00",
  };
  if (short[s]) return short[s];
  const m =
    /^(?:([A-Za-z]{3}(?:\.\.[A-Za-z]{3})?(?:,[A-Za-z]{3})*)\s+)?\*-\*-\*\s+(\S+?)(?:\s+(UTC|\S+))?$/.exec(
      s,
    );
  if (!m) return s;
  const [, days, time, zone] = m;
  const tz = zone ? ` ${zone}` : "";
  const [h, mi = "00"] = time.split(":");
  let when: string;
  if (h === "*" && /^\d+$/.test(mi)) when = mi === "00" ? "hourly" : `hourly at :${mi}`;
  else if (h === "*" && /^\d+\/\d+$/.test(mi)) when = seconds(Number(mi.split("/")[1]) * 60);
  else if (/^\d+\/\d+$/.test(h)) when = seconds(Number(h.split("/")[1]) * 3600);
  else if (/^\d+$/.test(h) && /^\d+$/.test(mi)) when = `${pad(h)}:${pad(mi)}${tz}`;
  else return s;
  return days ? `${days} ${when}` : when;
}

/** systemd time span (`5min`, `60s`, `1h 30min`) in seconds, or null. */
export function parseTimespan(span: string): number | null {
  const units: Record<string, number> = {
    us: 1e-6,
    ms: 1e-3,
    s: 1,
    sec: 1,
    m: 60,
    min: 60,
    h: 3600,
    hr: 3600,
    d: 86400,
    w: 604800,
  };
  let total = 0;
  let matched = false;
  for (const part of span.trim().split(/\s+/)) {
    const m = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(part);
    if (!m || units[m[2]] === undefined) return null;
    total += Number(m[1]) * units[m[2]];
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

/**
 * A timer's schedule from `systemctl show -p TimersCalendar -p TimersMonotonic`:
 *   TimersCalendar={ OnCalendar=*-*-* 16:00:00 UTC ; next_elapse=… }
 *   TimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=… }
 */
export function humanizeTimer(calendar: string, monotonic: string): string {
  const parts: string[] = [];
  for (const m of calendar.matchAll(/OnCalendar=([^;}]+)/g)) parts.push(humanizeCalendar(m[1]));
  const active = /OnUnitActive(?:U)?Sec=([^;}]+)/.exec(monotonic)?.[1];
  if (active) {
    const n = parseTimespan(active.trim());
    parts.push(n ? seconds(n) : `every ${active.trim()}`);
  }
  if (parts.length === 0 && /OnBoot(?:U)?Sec=/.test(monotonic)) parts.push("at boot");
  return parts.join(", ") || "—";
}

/** launchd plist keys (as `plutil -convert json` gives them) in words. */
export function humanizeLaunchd(plist: Record<string, unknown>): string {
  const parts: string[] = [];
  const keepAlive = plist.KeepAlive;
  if (keepAlive === true || (keepAlive && typeof keepAlive === "object")) parts.push("always on");
  const interval = plist.StartInterval;
  if (typeof interval === "number" && interval > 0) parts.push(seconds(interval));
  const cal = plist.StartCalendarInterval;
  const cals = Array.isArray(cal) ? cal : cal && typeof cal === "object" ? [cal] : [];
  const times = cals
    .map((c) => {
      const e = c as Record<string, number>;
      const time =
        e.Hour !== undefined
          ? `${pad(e.Hour)}:${pad(e.Minute ?? 0)}`
          : e.Minute !== undefined
            ? `hourly at :${pad(e.Minute)}`
            : "";
      const day = e.Weekday !== undefined ? `${DAYS[e.Weekday % 7]} ` : "";
      const date = e.Day !== undefined ? `day ${e.Day} ` : "";
      return `${date}${day}${time}`.trim();
    })
    .filter(Boolean);
  if (times.length > 3) parts.push(`${times.length} times a day`);
  else if (times.length) parts.push(times.join(", "));
  if (plist.StartOnMount === true) parts.push("when a volume mounts");
  if (Array.isArray(plist.WatchPaths) && plist.WatchPaths.length)
    parts.push("when a watched path changes");
  if (Array.isArray(plist.QueueDirectories) && plist.QueueDirectories.length)
    parts.push("when its queue fills");
  if (parts.length === 0 && plist.RunAtLoad === true) parts.push("at login");
  return parts.join(", ") || "on demand";
}
