import { createServerFn } from "@tanstack/react-start";
import bundled from "@/data/schedule.json";
import type { UfcEvent } from "./types";

export const refreshSchedule = createServerFn({ method: "POST" }).handler(async () => {
  const events = bundled.events as UfcEvent[];
  try {
    const res = await fetch("https://www.ufc.com/events", {
      headers: { "User-Agent": "OctagonEdge/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {
        ok: true as const,
        events,
        message: `UFC.com returned ${res.status}. Showing the saved schedule through ${bundled.asOf}.`,
      };
    }
    const html = await res.text();
    const links = [...html.matchAll(/\/event\/([a-z0-9-]+)/g)].map((match) => match[1]);
    const known = new Set(events.map((event) => event.id));
    const fresh = [...new Set(links)].filter(
      (id) => id.length > 6 && /[a-z]/.test(id) && !/^\d+$/.test(id) && !known.has(id) && !id.includes("tbd"),
    );
    return {
      ok: true as const,
      events,
      message:
        fresh.length > 0
          ? `Schedule checked. Showing the saved cards from ${bundled.asOf}. UFC.com has other event pages this snapshot does not score yet.`
          : `Schedule checked. Showing cards captured ${bundled.asOf}. History is through Oct 17, 2026.`,
    };
  } catch {
    return {
      ok: true as const,
      events,
      message: `Live schedule check failed. Showing the saved cards from ${bundled.asOf}.`,
    };
  }
});
