import { createServerFn } from "@tanstack/react-start";
import learned from "@/data/learned.json";
import type { SettledFight } from "./learn";

const RESULTS_URL = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/master/ufc_fight_results.csv";
const EVENTS_URL = "https://raw.githubusercontent.com/Greco1899/scrape_ufc_stats/master/ufc_event_details.csv";

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

async function pull(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/csv" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.text();
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
        fights.push({
          date: meta.date,
          event,
          a,
          b,
          y: outcome === "W/L" ? 1 : outcome === "L/W" ? 0 : null,
          elevationFt: meta.elevationFt,
        });
      }
      fights.sort((left, right) => left.date.localeCompare(right.date) || left.event.localeCompare(right.event));
      return { ok: true as const, fights, note: fights.length ? "" : `No settled fights after ${data.after}.` };
    } catch {
      return { ok: false as const, fights: [] as SettledFight[], note: "Could not read new results. Weights are unchanged." };
    }
  });
