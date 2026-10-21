import { createServerFn } from "@tanstack/react-start";
import learned from "@/data/learned.json";
import type { SettledFight } from "./learn";
import type { RoundStat } from "./types";

const RESULTS_URL = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/master/ufc_fight_results.csv";
const EVENTS_URL = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/master/ufc_event_details.csv";
const STATS_URL = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/master/ufc_fight_stats.csv";

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function isoDate(value: string): string | null {
  const match = value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
}

function elevation(location: string): number {
  const text = location.toLowerCase();
  if (text.includes("mexico city") || text.includes("ciudad de mexico") || text.includes("cdmx")) return 7380;
  if (text.includes("denver")) return 5280;
  if (text.includes("albuquerque")) return 5312;
  return 0;
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const header = (rows[0] ?? []).map((item) => item.trim());
  return rows.slice(1).flatMap((fields) => {
    if (fields.every((field) => !field.trim())) return [];
    const record: Record<string, string> = {};
    header.forEach((name, index) => {
      record[name] = (fields[index] ?? "").trim();
    });
    return [record];
  });
}

async function pull(url: string, timeoutMs = 20000): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/csv" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
}

function emptyStat(): RoundStat {
  return {
    sigL: 0,
    sigA: 0,
    tdL: 0,
    tdA: 0,
    kd: 0,
    ctrl: 0,
    headL: 0,
    bodyL: 0,
    legL: 0,
    distL: 0,
    clinchL: 0,
    groundL: 0,
    rev: 0,
    sub: 0,
  };
}

function parseOf(value: string): [number, number] {
  const match = (value || "").match(/(\d+)\s+of\s+(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function parseClock(value: string): number {
  const text = (value || "").trim();
  if (!text || text === "--" || text === "---") return 0;
  const parts = text.split(":");
  if (parts.length !== 2) return 0;
  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  return Number.isFinite(minutes) && Number.isFinite(seconds) ? minutes * 60 + seconds : 0;
}

function parseIntish(value: string): number {
  const text = (value || "").trim();
  if (!text || text === "--" || text === "---") return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addRound(bucket: RoundStat, row: Record<string, string>): void {
  const [sigL, sigA] = parseOf(row["SIG.STR."] ?? "");
  const [tdL, tdA] = parseOf(row.TD ?? "");
  const [headL] = parseOf(row.HEAD ?? "");
  const [bodyL] = parseOf(row.BODY ?? "");
  const [legL] = parseOf(row.LEG ?? "");
  const [distL] = parseOf(row.DISTANCE ?? "");
  const [clinchL] = parseOf(row.CLINCH ?? "");
  const [groundL] = parseOf(row.GROUND ?? "");
  bucket.sigL += sigL;
  bucket.sigA += sigA;
  bucket.tdL += tdL;
  bucket.tdA += tdA;
  bucket.sub += parseIntish(row["SUB.ATT"] ?? "");
  bucket.kd += parseIntish(row.KD ?? "");
  bucket.ctrl += parseClock(row.CTRL ?? "");
  bucket.headL += headL;
  bucket.bodyL += bodyL;
  bucket.legL += legL;
  bucket.distL += distL;
  bucket.clinchL += clinchL;
  bucket.groundL += groundL;
  bucket.rev += parseIntish(row["REV."] ?? "");
}

function methodBucket(method: string): SettledFight["method"] {
  const text = method.toLowerCase();
  if (text.includes("ko") || text.includes("tko")) return "ko";
  if (text.includes("sub")) return "sub";
  if (text.includes("decision")) return "dec";
  return "other";
}

function scheduledRounds(timeFormat: string): number {
  const match = timeFormat.match(/(\d+)\s*Rnd/);
  return match ? Number(match[1]) : 3;
}

function fightSeconds(round: string, clock: string, timeFormat: string): { round: number; seconds: number } {
  const matched = (round || "1").match(/(\d+)/);
  const cap = scheduledRounds(timeFormat);
  const finish = Math.max(1, Math.min(matched ? Number(matched[1]) : 1, cap));
  return { round: finish, seconds: Math.max(1, (finish - 1) * 300 + Math.min(parseClock(clock), 300)) };
}

export const loadSettled = createServerFn({ method: "POST" })
  .validator((input: { after?: string }) => {
    const after = String(input?.after ?? "").slice(0, 10);
    return { after: after > learned.lastDate ? after : learned.lastDate };
  })
  .handler(async ({ data }) => {
    try {
      const [resultsText, eventsText] = await Promise.all([pull(RESULTS_URL), pull(EVENTS_URL)]);
      const events = new Map<string, { date: string; elevationFt: number }>();
      for (const row of parseCsv(eventsText)) {
        const date = isoDate(row.DATE ?? "");
        const name = (row.EVENT ?? "").trim();
        if (!date || !name) continue;
        events.set(name, { date, elevationFt: elevation(row.LOCATION ?? "") });
      }
      const fights: SettledFight[] = [];
      for (const row of parseCsv(resultsText)) {
        const event = (row.EVENT ?? "").trim();
        const meta = events.get(event);
        const bout = row.BOUT ?? "";
        if (!meta || meta.date <= data.after || !bout.includes(" vs. ")) continue;
        const outcome = row.OUTCOME ?? "";
        if (!["W/L", "L/W", "D/D", "NC/NC"].includes(outcome)) continue;
        const [a, b] = bout.split(" vs. ", 2).map((name) => name.trim());
        if (!a || !b) continue;
        const clock = fightSeconds(row.ROUND ?? "", row.TIME ?? "", row["TIME FORMAT"] ?? "");
        const methodText = (row.METHOD ?? "").trim();
        fights.push({
          date: meta.date,
          event,
          a,
          b,
          y: outcome === "W/L" ? 1 : outcome === "L/W" ? 0 : null,
          elevationFt: meta.elevationFt,
          method: methodBucket(methodText),
          round: clock.round,
          seconds: clock.seconds,
          detail: (row.DETAILS ?? "").trim() || methodText,
          methodText,
          nc: outcome === "NC/NC",
          statsKnown: false,
          aStat: emptyStat(),
          bStat: emptyStat(),
        });
      }
      fights.sort((left, right) => left.date.localeCompare(right.date) || left.event.localeCompare(right.event));
      if (fights.length) {
        try {
          const statsText = await pull(STATS_URL, 45000);
          const stats = new Map<string, RoundStat>();
          for (const row of parseCsv(statsText)) {
            const key = `${(row.EVENT ?? "").trim()}|${(row.BOUT ?? "").trim()}|${(row.FIGHTER ?? "").trim()}`;
            const bucket = stats.get(key) ?? emptyStat();
            addRound(bucket, row);
            stats.set(key, bucket);
          }
          for (const fight of fights) {
            const bout = `${fight.a} vs. ${fight.b}`;
            const left = stats.get(`${fight.event}|${bout}|${fight.a}`);
            const right = stats.get(`${fight.event}|${bout}|${fight.b}`);
            if (!left && !right) continue;
            fight.statsKnown = true;
            fight.aStat = left ?? emptyStat();
            fight.bStat = right ?? emptyStat();
          }
        } catch {
          // Results still update the record. Rates wait until the stats file can be read.
        }
      }
      const withStats = fights.filter((fight) => fight.statsKnown).length;
      const note = fights.length
        ? withStats === fights.length
          ? ""
          : "New results are in. Strike totals could not be read for every fight, so those rates stay as they were."
        : `No settled fights after ${data.after}.`;
      return { ok: true as const, fights, note };
    } catch {
      return { ok: false as const, fights: [] as SettledFight[], note: "Could not read new results. Weights are unchanged." };
    }
  });
