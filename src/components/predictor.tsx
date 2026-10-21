import { useMemo, useState } from "react";
import { RefreshCw, ScanSearch, TrendingUp } from "lucide-react";
import profiles from "@/data/fighters.json";
import bundled from "@/data/schedule.json";
import { scoutFight } from "@/lib/ufc/enrich";
import { findFighter, indexFighters, predictBout } from "@/lib/ufc/model";
import {
  formatAmerican,
  gradeBout,
  orientFight,
  toAmerican,
  type Grade,
  type MarketFight,
  type ValuePick,
} from "@/lib/ufc/odds";
import { loadMarket } from "@/lib/ufc/odds-feed";
import { refreshSchedule } from "@/lib/ufc/refresh";
import type { Fighter, Prediction, UfcEvent } from "@/lib/ufc/types";

type Provider = "grok" | "openai" | "anthropic";

type ScoutState = { status: "idle" | "loading" | "done" | "error"; text: string };

type MarketState = {
  eventId: string;
  status: "idle" | "loading" | "live" | "saved" | "none" | "error";
  note: string;
  fights: MarketFight[];
};

const fighters = (profiles as { fighters: Fighter[]; asOf: string }).fighters;
const historyAsOf = (profiles as { asOf: string }).asOf;
const emptyMarket: MarketState = { eventId: "", status: "idle", note: "", fights: [] };

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function money(decimal: number | null): string {
  if (decimal == null) return "—";
  return formatAmerican(toAmerican(decimal));
}

function dollars(ev: number): string {
  return `$${Math.round(ev * 100)}`;
}

function OddsBlock({
  grade,
  loading,
  aName,
  bName,
}: {
  grade: Grade | null;
  loading: boolean;
  aName: string;
  bName: string;
}) {
  if (loading && !grade) return <p className="mb-4 text-sm text-muted">Reading the books…</p>;
  if (!grade || grade.books.every((row) => row.a == null && row.b == null)) {
    return <p className="mb-4 text-sm text-muted">No moneyline posted at the major books yet.</p>;
  }
  const valueA = grade.picks.some((pick) => pick.kind === "Moneyline" && pick.label === aName);
  const valueB = grade.picks.some((pick) => pick.kind === "Moneyline" && pick.label === bName);
  return (
    <div className="mb-4">
      <p className="mb-1 text-xs tracking-wide text-muted uppercase">Books</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs tracking-wide text-muted uppercase">
              <th className="py-1 font-medium">Book</th>
              <th className="py-1 font-medium">{aName.split(" ").slice(-1)}</th>
              <th className="py-1 font-medium">{bName.split(" ").slice(-1)}</th>
            </tr>
          </thead>
          <tbody>
            {grade.books.map((row) => (
              <tr key={row.book} className="border-t border-line">
                <td className="py-1.5 text-muted">{row.book}</td>
                <td className={valueA && grade.bestA?.book === row.book ? "font-semibold text-ember" : "text-fg"}>
                  {money(row.a)}
                </td>
                <td className={valueB && grade.bestB?.book === row.book ? "font-semibold text-ember" : "text-fg"}>
                  {money(row.b)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-line">
              <td className="py-1.5 text-muted">Best</td>
              <td className={valueA ? "font-semibold text-ember" : "text-bone"}>
                {grade.bestA ? `${formatAmerican(grade.bestA.american)} ${grade.bestA.book}` : "—"}
              </td>
              <td className={valueB ? "font-semibold text-ember" : "text-bone"}>
                {grade.bestB ? `${formatAmerican(grade.bestB.american)} ${grade.bestB.book}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {grade.noVigA != null ? (
        <p className="mt-2 text-sm text-muted">
          No-vig market {pct(grade.noVigA)} / {pct(1 - grade.noVigA)}.
        </p>
      ) : null}
      {grade.picks.length > 0 ? (
        <div className="mt-3 rounded-md border border-ember bg-raised px-3 py-2">
          {grade.picks.slice(0, 2).map((pick) => (
            <p key={`${pick.kind}-${pick.label}`} className="text-sm">
              <span className="font-semibold text-ember">
                {pick.kind === "Moneyline" ? "Bet" : "Prop"} {pick.label} {formatAmerican(pick.american)} {pick.book}
              </span>
              <span className="text-fg">
                {" "}
                · model {pct(pick.model)} · {dollars(pick.ev)} per $100
              </span>
            </p>
          ))}
        </div>
      ) : grade.pass ? (
        <p className="mt-2 text-sm text-muted">{grade.pass}</p>
      ) : null}
    </div>
  );
}

export function Predictor() {
  const index = useMemo(() => indexFighters(fighters), []);
  const [events, setEvents] = useState<UfcEvent[]>(bundled.events as UfcEvent[]);
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [status, setStatus] = useState(bundled.note);
  const [refreshing, setRefreshing] = useState(false);
  const [analyzed, setAnalyzed] = useState(false);
  const [provider, setProvider] = useState<Provider>("grok");
  const [apiKey, setApiKey] = useState("");
  const [scouts, setScouts] = useState<Record<string, ScoutState>>({});
  const [market, setMarket] = useState<MarketState>(emptyMarket);

  const event = events.find((item) => item.id === eventId) ?? events[0];

  const predictions = useMemo(() => {
    if (!event || !analyzed) return [] as Prediction[];
    return event.bouts.map((bout) =>
      predictBout(findFighter(index, bout.a), findFighter(index, bout.b), bout, event),
    );
  }, [analyzed, event, index]);

  const grades = useMemo(() => {
    if (!event || !analyzed) return [] as (Grade | null)[];
    return event.bouts.map((bout, boutIndex) =>
      gradeBout(predictions[boutIndex], orientFight(market.fights, bout.a, bout.b)),
    );
  }, [analyzed, event, market.fights, predictions]);

  const board = useMemo(() => {
    const picks: (ValuePick & { bout: string })[] = [];
    event?.bouts.forEach((bout, boutIndex) => {
      for (const pick of grades[boutIndex]?.picks ?? []) {
        picks.push({ ...pick, bout: `${bout.a} vs ${bout.b}` });
      }
    });
    return picks
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "Moneyline" ? -1 : 1;
        return right.ev - left.ev;
      })
      .slice(0, 6);
  }, [event, grades]);

  async function pullOdds(id: string) {
    setMarket((current) => ({ ...current, eventId: id, status: "loading" }));
    try {
      const result = await loadMarket({ data: { eventId: id } });
      setMarket({
        eventId: id,
        status: result.source,
        note: result.note,
        fights: result.fights,
      });
    } catch {
      setMarket({ eventId: id, status: "error", note: "Odds feed failed.", fights: [] });
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      const result = await refreshSchedule();
      setEvents(result.events);
      setStatus(result.message);
      if (!result.events.some((item) => item.id === eventId)) {
        setEventId(result.events[0]?.id ?? "");
      }
      setAnalyzed(false);
      const nextId = result.events.some((item) => item.id === eventId) ? eventId : (result.events[0]?.id ?? "");
      if (nextId) await pullOdds(nextId);
    } catch {
      setStatus("Refresh failed. The saved card is still loaded.");
    } finally {
      setRefreshing(false);
    }
  }

  async function onAnalyze() {
    if (!event) return;
    setAnalyzed(true);
    if (market.eventId !== event.id || market.status === "idle" || market.status === "error") {
      await pullOdds(event.id);
    }
  }

  async function onScout(key: string, prediction: Prediction, weight: string) {
    if (!event) return;
    setScouts((current) => ({ ...current, [key]: { status: "loading", text: "" } }));
    const context = [
      `Model lean ${pct(prediction.pA)} ${prediction.aName}.`,
      ...prediction.flags.map((flag) => flag.text),
      ...prediction.diffs.slice(0, 6).map((row) => `${row.label}: ${row.a} vs ${row.b}`),
    ].join("\n");
    try {
      const result = await scoutFight({
        data: {
          provider,
          apiKey: provider === "grok" ? undefined : apiKey,
          event: event.name,
          date: event.date,
          location: `${event.venue}, ${event.location}`,
          a: prediction.aName,
          b: prediction.bName,
          weight,
          context,
        },
      });
      setScouts((current) => ({
        ...current,
        [key]: result.ok
          ? { status: "done", text: result.text }
          : { status: "error", text: result.error },
      }));
    } catch {
      setScouts((current) => ({
        ...current,
        [key]: { status: "error", text: "Scout notes could not be loaded." },
      }));
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-col gap-2 border-b border-line pb-5">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10" />
          <div>
            <p className="font-display text-sm tracking-[0.22em] text-ember uppercase">UFC model</p>
            <h1 className="font-display text-5xl leading-none font-semibold text-fg sm:text-6xl">Octagon Edge</h1>
          </div>
        </div>
        <p className="max-w-2xl text-muted">
          {fighters.length.toLocaleString()} fighters from UFC history through {historyAsOf}. Pick a card, then analyze.
          The model is scored against DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock, and Bovada. Records are
          UFC bouts only.
        </p>
      </header>

      <section className="mb-5 grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm text-muted">
            Event
            <select
              className="min-h-11 rounded-md border border-line bg-raised px-3 text-base text-fg"
              value={event?.id ?? ""}
              onChange={(change) => {
                setEventId(change.target.value);
                setAnalyzed(false);
                setMarket(emptyMarket);
              }}
            >
              {events.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-1 text-sm text-muted">
            Scout notes
            <select
              className="min-h-11 rounded-md border border-line bg-raised px-3 text-base text-fg"
              value={provider}
              onChange={(change) => setProvider(change.target.value as Provider)}
            >
              <option value="grok">Grok</option>
              <option value="openai">ChatGPT</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:justify-end">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-raised px-4 text-sm font-semibold text-fg disabled:opacity-60"
          >
            <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />
            {refreshing ? "Refreshing…" : "Refresh data"}
          </button>
          <button
            type="button"
            onClick={onAnalyze}
            disabled={market.status === "loading"}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-ember px-4 text-sm font-semibold text-bg disabled:opacity-60"
          >
            <ScanSearch className="size-4" aria-hidden="true" />
            {market.status === "loading" ? "Reading books…" : "Analyze"}
          </button>
        </div>
        {provider !== "grok" ? (
          <label className="grid gap-1 text-sm text-muted sm:col-span-2">
            {provider === "openai" ? "OpenAI API key" : "Anthropic API key"}
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(change) => setApiKey(change.target.value)}
              placeholder="Used for this session only. Not saved."
              className="min-h-11 rounded-md border border-line bg-raised px-3 text-base text-fg"
            />
          </label>
        ) : (
          <p className="text-sm text-muted sm:col-span-2">
            Grok notes use the app key and only run when you ask. ChatGPT and Anthropic need a key you paste here; it is not stored.
          </p>
        )}
        <p className="text-sm text-bone sm:col-span-2">{market.note || status}</p>
      </section>

      {event ? (
        <section className="mb-4">
          <h2 className="font-display text-3xl leading-none text-fg">{event.name}</h2>
          <p className="mt-1 text-sm text-muted">
            {event.date} · {event.venue}, {event.location}
            {event.elevationFt >= 4000 ? ` · ${event.elevationFt.toLocaleString()} ft` : ""}
          </p>
        </section>
      ) : null}

      {analyzed && board.length > 0 ? (
        <section className="mb-4 rounded-lg border border-ember bg-surface p-4">
          <div className="mb-2 flex items-center gap-2">
            <TrendingUp className="size-4 text-ember" aria-hidden="true" />
            <h2 className="font-display text-2xl leading-none text-fg">Mispriced</h2>
          </div>
          <ul className="grid gap-2">
            {board.map((pick) => (
              <li key={`${pick.bout}-${pick.label}-${pick.book}`} className="text-sm">
                <span className="font-semibold text-ember">
                  {pick.label} {formatAmerican(pick.american)}
                </span>
                <span className="text-muted">
                  {" "}
                  at {pick.book} · {pick.kind === "Moneyline" ? pick.bout : pick.kind} · model {pct(pick.model)} ·{" "}
                  {dollars(pick.ev)} expected per $100
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-3">
        {event?.bouts.map((bout, index) => {
          const prediction = predictions[index];
          const key = `${event.id}-${index}`;
          const scout = scouts[key];
          return (
            <article key={key} className="rounded-lg border border-line bg-surface p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-2xl leading-none text-fg">
                  {bout.a} <span className="text-muted">vs</span> {bout.b}
                </h3>
                <p className="text-sm text-muted">
                  {bout.weight}
                  {bout.title ? " · title · 5 rounds" : " · 3 rounds"}
                </p>
              </div>

              {!analyzed || !prediction ? (
                <p className="text-sm text-muted">On the card. Analyze to score the matchup.</p>
              ) : prediction.missing ? (
                <div>
                  <p className="text-sm text-bone">{prediction.missing} No bet without a history.</p>
                  <OddsBlock
                    grade={grades[index] ?? null}
                    loading={market.status === "loading"}
                    aName={bout.a}
                    bName={bout.b}
                  />
                </div>
              ) : (
                <>
                  <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                    <div>
                      <p className={`font-display text-4xl leading-none ${prediction.pA >= 0.5 ? "text-ember" : "text-fg"}`}>
                        {pct(prediction.pA)}
                      </p>
                      <p className="text-sm text-muted">{prediction.aName.split(" ").slice(-1)}</p>
                    </div>
                    <p className="pb-1 text-xs tracking-wide text-muted uppercase">win</p>
                    <div className="text-right">
                      <p className={`font-display text-4xl leading-none ${prediction.pA < 0.5 ? "text-ember" : "text-fg"}`}>
                        {pct(1 - prediction.pA)}
                      </p>
                      <p className="text-sm text-muted">{prediction.bName.split(" ").slice(-1)}</p>
                    </div>
                  </div>
                  <div className="mb-4 h-2 overflow-hidden rounded-full bg-raised">
                    <div className="h-full bg-ember" style={{ width: pct(prediction.pA) }} />
                  </div>
                  <OddsBlock
                    grade={grades[index] ?? null}
                    loading={market.status === "loading"}
                    aName={prediction.aName}
                    bName={prediction.bName}
                  />

                  <div className="mb-4 grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs tracking-wide text-muted uppercase">Likely paths</p>
                      <ul className="grid gap-1">
                        {prediction.methods.slice(0, 4).map((item) => (
                          <li key={item.label} className="flex justify-between text-sm">
                            <span>{item.label}</span>
                            <span className="text-bone">{pct(item.pct)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <p className="mb-1 text-xs tracking-wide text-muted uppercase">When it ends</p>
                      <ul className="grid gap-1">
                        {prediction.rounds.map((item) => (
                          <li key={item.label} className="flex justify-between text-sm">
                            <span>{item.label}</span>
                            <span className="text-bone">{pct(item.pct)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs tracking-wide text-muted uppercase">
                          <th className="py-1 font-medium">Signal</th>
                          <th className="py-1 font-medium">{prediction.aName.split(" ").slice(-1)}</th>
                          <th className="py-1 font-medium">{prediction.bName.split(" ").slice(-1)}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {prediction.diffs.map((row) => (
                          <tr key={row.label} className="border-t border-line">
                            <td className="py-1.5 text-muted">{row.label}</td>
                            <td className={row.edge === "a" ? "text-bone" : "text-fg"}>{row.a}</td>
                            <td className={row.edge === "b" ? "text-bone" : "text-fg"}>{row.b}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {prediction.flags.length > 0 ? (
                    <ul className="mt-3 grid gap-1">
                      {prediction.flags.map((flag) => (
                        <li key={flag.text} className="text-sm text-bone">
                          {flag.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-3">
                    <button
                      type="button"
                      className="min-h-11 rounded-md border border-line px-3 text-sm text-fg"
                      onClick={() => onScout(key, prediction, bout.weight)}
                      disabled={scout?.status === "loading"}
                    >
                      {scout?.status === "loading" ? "Reading…" : "Scout notes"}
                    </button>
                    {scout && scout.status !== "idle" && scout.status !== "loading" ? (
                      <p className={`mt-2 text-sm whitespace-pre-wrap ${scout.status === "error" ? "text-ember" : "text-fg"}`}>
                        {scout.text}
                      </p>
                    ) : null}
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>

      <footer className="mt-8 border-t border-line pt-4 text-sm text-muted">
        Moneylines are the best number at each book. A fight is marked mispriced when the model’s win chance beats that
        price by about 4% expected value, or 8% on a method or distance prop. Lines move. Confirm the number in your
        account before you bet. Surgery, camp, and scale weight are not in the file — Scout notes can add public context,
        and only when you ask.
      </footer>
    </main>
  );
}
