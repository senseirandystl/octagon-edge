import { createServerFn } from "@tanstack/react-start";
import snapshot from "@/data/odds.json";
import { mergeMarkets, parseBestFightOddsHtml, parseDiaryHtml, type MarketFight } from "./odds";

const SOURCES: Record<string, { diary?: string; bfo?: string }> = {
  "ufc-333": {
    diary: "https://diaryofaprogambler.com/events/ufc-333",
    bfo: "https://www.bestfightodds.com/events/ufc-333-4321",
  },
  "ufc-fn-2026-10-31": {
    diary: "https://diaryofaprogambler.com/events/ufc-fight-night-october-31-2026",
  },
  "ufc-fn-2026-11-07": {
    diary: "https://diaryofaprogambler.com/events/ufc-fight-night-november-07-2026",
  },
  "ufc-334": {
    diary: "https://diaryofaprogambler.com/events/ufc-334",
    bfo: "https://www.bestfightodds.com/events/ufc-334-4370",
  },
  "ufc-fn-2026-11-21": {
    diary: "https://diaryofaprogambler.com/events/ufc-fight-night-november-21-2026",
  },
  "ufc-335": {
    diary: "https://diaryofaprogambler.com/events/ufc-335",
    bfo: "https://www.bestfightodds.com/events/ufc-335-4394",
  },
};

type Saved = { asOf: string; events: Record<string, MarketFight[]> };

const saved = snapshot as Saved;

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.text();
}

export const loadMarket = createServerFn({ method: "POST" })
  .validator((input: { eventId?: string }) => {
    const eventId = String(input?.eventId ?? "").slice(0, 80);
    if (!eventId) throw new Error("Missing event.");
    return { eventId };
  })
  .handler(async ({ data }) => {
    const source = SOURCES[data.eventId];
    let fights: MarketFight[] = [];
    let live = false;
    if (source) {
      const diary = source.diary
        ? fetchHtml(source.diary)
            .then(parseDiaryHtml)
            .catch(() => [] as MarketFight[])
        : Promise.resolve([] as MarketFight[]);
      const bfo = source.bfo
        ? fetchHtml(source.bfo)
            .then(parseBestFightOddsHtml)
            .catch(() => [] as MarketFight[])
        : Promise.resolve([] as MarketFight[]);
      const [diaryFights, bfoFights] = await Promise.all([diary, bfo]);
      fights = mergeMarkets(diaryFights, bfoFights);
      live = fights.length > 0;
    }
    if (!live) {
      const fallback = saved.events[data.eventId] ?? [];
      if (fallback.length) {
        return {
          ok: true as const,
          source: "saved" as const,
          asOf: saved.asOf,
          note: `Live books did not respond. Showing saved lines from ${saved.asOf.slice(0, 10)}.`,
          fights: fallback,
        };
      }
      return {
        ok: true as const,
        source: "none" as const,
        asOf: "",
        note: "No moneyline is posted for this card yet.",
        fights: [] as MarketFight[],
      };
    }
    return {
      ok: true as const,
      source: "live" as const,
      asOf: new Date().toISOString(),
      note: "Live moneylines from DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock, and Bovada.",
      fights,
    };
  });
