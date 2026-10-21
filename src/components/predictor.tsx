import { useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCw, ScanSearch, TrendingUp } from "lucide-react";
import profiles from "@/data/fighters.json";
import bundled from "@/data/schedule.json";
import { scoutFight } from "@/lib/ufc/enrich";
import { findFighter, indexFighters, predictBout, LIVE_WEIGHTS, TREE_FILE, normName, setInjuryOverlay } from "@/lib/ufc/model";
import learned from "@/data/learned.json";
import { foldSettled, readLearnMemory, writeLearnMemory, type LearnExtra } from "@/lib/ufc/learn";
import { loadSettled } from "@/lib/ufc/learn-feed";
import {
  BOOK_ORDER,
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
import type { Fighter, InjuryItem, Prediction, UfcEvent } from "@/lib/ufc/types";

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

function hitRate(correct: number, fights: number): string {
  if (!fights) return "—";
  return `${((correct / fights) * 100).toFixed(1)}%`;
}

const emptyExtra: LearnExtra = { n: 0, correct: 0, logLoss: 0 };

function OddsBlock({
  grade,
  loading,
  book,
  aName,
  bName,
}: {
  grade: Grade | null;
  loading: boolean;
  book: string;
  aName: string;
  bName: string;
}) {
  if (loading && !grade) return <p className="mb-4 text-sm text-muted">Reading {book}…</p>;
  if (!grade || (grade.a == null && grade.b == null)) {
    return <p className="mb-4 text-sm text-muted">{book} has not posted a moneyline for this fight.</p>;
  }
  const valueA = grade.picks.some((pick) => pick.kind === "Moneyline" && pick.label === aName);
  const valueB = grade.picks.some((pick) => pick.kind === "Moneyline" && pick.label === bName);
  const last = (name: string) => name.split(" ").slice(-1);
  return (
    <div className="mb-4">
      <p className="mb-1 text-xs tracking-wide text-muted uppercase">{book}</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className={`font-display text-3xl leading-none ${valueA ? "text-ember" : "text-fg"}`}>{money(grade.a)}</p>
          <p className="text-sm text-muted">{last(aName)}</p>
        </div>
        <div className="text-right">
          <p className={`font-display text-3xl leading-none ${valueB ? "text-ember" : "text-fg"}`}>{money(grade.b)}</p>
          <p className="text-sm text-muted">{last(bName)}</p>
        </div>
      </div>
      {grade.noVigA != null ? (
        <p className="mt-2 text-sm text-muted">
          {book} no-vig {pct(grade.noVigA)} / {pct(1 - grade.noVigA)}.
        </p>
      ) : null}
      {grade.picks.length > 0 ? (
        <div className="mt-3 rounded-md border border-ember bg-raised px-3 py-2">
          {grade.picks.slice(0, 2).map((pick) => (
            <p key={`${pick.kind}-${pick.label}`} className="text-sm">
              <span className="font-semibold text-ember">
                {pick.kind === "Moneyline" ? "Bet" : "Prop"} {pick.label} {formatAmerican(pick.american)}
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
  const [book, setBook] = useState("DraftKings");
  const [apiKey, setApiKey] = useState("");
  const [scouts, setScouts] = useState<Record<string, ScoutState>>({});
  const [market, setMarket] = useState<MarketState>(emptyMarket);
  const [weights, setWeights] = useState<number[]>(LIVE_WEIGHTS);
  const [adjustments, setAdjustments] = useState<Record<string, Fighter>>({});
  const [extra, setExtra] = useState<LearnExtra>(emptyExtra);
  const [injuries, setInjuries] = useState<InjuryItem[]>([]);
  const [learnNote, setLearnNote] = useState(`Weights are current through ${learned.lastDate}.`);
  const [openSignals, setOpenSignals] = useState<Record<string, boolean>>({});

  const event = events.find((item) => item.id === eventId) ?? events[0];

  useEffect(() => {
    const saved = localStorage.getItem("octagon-edge-book");
    if (saved && (BOOK_ORDER as readonly string[]).includes(saved)) setBook(saved);
    const memory = readLearnMemory();
    if (!memory) return;
    setWeights(memory.weights);
    setExtra(memory.extra);
    setInjuries(memory.injuries);
    setAdjustments(Object.fromEntries(memory.fighters.map((fighter) => [normName(fighter.name), fighter])));
    if (memory.extra.n) {
      setLearnNote(`Learned ${memory.extra.n} fights settled after ${learned.lastDate}.`);
    }
  }, []);

  const predictions = useMemo(() => {
    setInjuryOverlay(injuries);
    if (!event || !analyzed) return [] as Prediction[];
    return event.bouts.map((bout) =>
      predictBout(
        adjustments[normName(bout.a)] ?? findFighter(index, bout.a),
        adjustments[normName(bout.b)] ?? findFighter(index, bout.b),
        bout,
        event,
        weights,
      ),
    );
  }, [adjustments, analyzed, event, index, injuries, weights]);

  const grades = useMemo(() => {
    if (!event || !analyzed) return [] as (Grade | null)[];
    return event.bouts.map((bout, boutIndex) =>
      gradeBout(predictions[boutIndex], orientFight(market.fights, bout.a, bout.b), book),
    );
  }, [analyzed, book, event, market.fights, predictions]);

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
    setLearnNote("Checking for settled fights…");
    try {
      const result = await refreshSchedule();
      setEvents(result.events);
      setStatus(result.message);
      const nextId = result.events.some((item) => item.id === eventId) ? eventId : (result.events[0]?.id ?? "");
      if (!result.events.some((item) => item.id === eventId)) setEventId(nextId);
      setAnalyzed(false);
      const memory = readLearnMemory();
      const settledPromise = loadSettled({ data: { after: memory?.through ?? learned.lastDate } });
      if (nextId) await pullOdds(nextId);
      const settled = await settledPromise;
      if (!settled.ok) {
        setLearnNote(settled.note);
      } else if (!settled.fights.length) {
        setLearnNote(settled.note);
      } else {
        const next = foldSettled(memory?.weights ?? weights, settled.fights, index, {
          seen: memory?.seen ?? [],
          extra: memory?.extra ?? emptyExtra,
          fighters: memory?.fighters ?? [],
          injuries: memory?.injuries ?? injuries,
        });
        const added = next.extra.n - (memory?.extra.n ?? 0);
        writeLearnMemory(next);
        setWeights(next.weights);
        setExtra(next.extra);
        setInjuries(next.injuries);
        setAdjustments(Object.fromEntries(next.fighters.map((fighter) => [normName(fighter.name), fighter])));
        setLearnNote(
          added
            ? `Learned ${added} newly settled fight${added === 1 ? "" : "s"}. Records and strike rates were updated${TREE_FILE.live ? ", along with the residual on the tree" : ""}.`
            : settled.note || "No new decisive fights to learn.",
        );
      }
    } catch {
      setStatus("Refresh failed. The saved card is still loaded.");
      setLearnNote("Refresh failed. Weights are unchanged.");
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
          {fighters.length.toLocaleString()} fighters from UFC history through {historyAsOf}. Pick a card and your
          sportsbook, then analyze. The model is scored against that book's price only. Records are UFC bouts only.
          Reported injuries move the percentage. Nothing on file is not a clean bill of health.{" "}
          {TREE_FILE.live
            ? "The win chance is a tree model. Refresh can still nudge it."
            : "The win chance stays the logistic. A tree model was tested against it."}
        </p>
      </header>

      <section className="mb-5 grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-3 sm:grid-cols-3">
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
          <label className="grid gap-1 text-sm text-muted">
            Sportsbook
            <select
              className="min-h-11 rounded-md border border-line bg-raised px-3 text-base text-fg"
              value={book}
              onChange={(change) => {
                setBook(change.target.value);
                localStorage.setItem("octagon-edge-book", change.target.value);
              }}
            >
              {BOOK_ORDER.map((name) => (
                <option key={name} value={name}>
                  {name}
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

      {analyzed &&
      book === "Fanatics" &&
      market.status !== "loading" &&
      grades.every((grade) => !grade || (grade.a == null && grade.b == null)) ? (
        <p className="mb-4 text-sm text-muted">
          Fanatics is not on the public board for this card. No number is copied from another book.
        </p>
      ) : null}

      {analyzed && board.length > 0 ? (
        <section className="mb-4 rounded-lg border border-ember bg-surface p-4">
          <div className="mb-2 flex items-center gap-2">
            <TrendingUp className="size-4 text-ember" aria-hidden="true" />
            <h2 className="font-display text-2xl leading-none text-fg">Mispriced at {book}</h2>
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
                    book={book}
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
                    book={book}
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

                  <button
                    type="button"
                    aria-expanded={Boolean(openSignals[key])}
                    className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-fg"
                    onClick={() => setOpenSignals((current) => ({ ...current, [key]: !current[key] }))}
                  >
                    <ChevronDown
                      className={`size-4 transition-transform ${openSignals[key] ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    />
                    {openSignals[key]
                      ? "Hide signals"
                      : `Show signals${prediction.flags.length ? ` · ${prediction.flags.length} note${prediction.flags.length === 1 ? "" : "s"}` : ""}`}
                  </button>

                  {openSignals[key] ? (
                    <>
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
                    <p className="mt-2 text-sm text-muted">
                      Last 3 strike, defense, and takedown gaps versus each career rate are in the win percentage. Opponent-adjusted
                      rates and strike location are on the card because they are in the history file. They were tested and did not
                      improve the fit, so they do not move the percentage. Weigh-ins, short notice, and regional records are not in
                      the file.
                    </p>
                  </div>

                  {prediction.flags.length > 0 ? (
                    <ul className="mt-3 grid gap-1">
                      {prediction.flags.map((flag) => (
                        <li key={flag.text} className="text-sm break-words text-bone">
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
                  ) : null}
                </>
              )}
            </article>
          );
        })}
      </div>

      <section className="mt-8 rounded-lg border border-line bg-surface p-4">
        <h2 className="font-display text-3xl leading-none text-fg">Learning record</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          {learned.summary.events.toLocaleString()} events, one at a time, from {learned.firstEvent} on {learned.firstDate}{" "}
          through {learned.lastEvent} on {learned.lastDate}. UFC 1 is not in the public extract, so the walk starts at UFC
          2. A card is scored before its results are allowed to move anything. The logistic below is that walk: each
          event updates the weights, and the betting line is never a feature. A gradient-boosted tree was walked the
          same way, refit at the start of each year on fights already settled, including the card with the corners
          swapped so winner-first early results are not a one-class trick. It is scored only in the posted order. On
          those {TREE_FILE.summary.fights.toLocaleString()} fights the tree log loss was {TREE_FILE.summary.logLoss.toFixed(3)} against{" "}
          {TREE_FILE.logistic.logLoss.toFixed(3)} for the logistic. Since 2018 it was {TREE_FILE.since2018.logLoss.toFixed(3)} against{" "}
          {TREE_FILE.logisticSince2018.logLoss.toFixed(3)}.{" "}
          {TREE_FILE.live
            ? "That full-history gain is large enough, and the recent gap is a tie, so the win chance is the tree plus a residual that starts at zero. Refresh moves the residual, not the trees. The trees stay frozen until the history file is rebuilt."
            : "The tree did not beat the logistic by enough to take the betting number, so the win chance stays the logistic."}{" "}
          Knockdowns, control time, and head strikes are in that number, plus an injury burden that fades over about
          seven months. The last three fights also count, but only as a gap versus that fighter’s own career rate.
          Opponent-adjusted striking and strike location were tested and left off the percentage. Weigh-ins, short
          notice, camp, and regional records are not in the file. A blank injury file is not a clean bill of health.
          The injury weight stayed on its prior because those reports are rare. A sourced surgery still moves the
          percentage through that prior. Refresh now folds new strike totals, the last three, and new fight-ending
          injury lines into this browser. It does not invent a surgery.
        </p>
        <p className="mt-2 text-sm text-bone">{learnNote}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <p className="text-sm">
            <span className="text-muted">Learned</span>{" "}
            <span className="font-semibold text-ember">
              {hitRate(learned.summary.learned.correct, learned.summary.learned.fights)}
            </span>
            <span className="text-muted"> · log loss {learned.summary.learned.logLoss.toFixed(3)}</span>
          </p>
          <p className="text-sm">
            <span className="text-muted">Hand weights</span>{" "}
            <span className="text-fg">{hitRate(learned.summary.frozen.correct, learned.summary.frozen.fights)}</span>
            <span className="text-muted"> · log loss {learned.summary.frozen.logLoss.toFixed(3)}</span>
          </p>
          <p className="text-sm">
            <span className="text-muted">Elo only</span>{" "}
            <span className="text-fg">{hitRate(learned.summary.elo.correct, learned.summary.elo.fights)}</span>
            <span className="text-muted"> · log loss {learned.summary.elo.logLoss.toFixed(3)}</span>
          </p>
        </div>
        <p className="mt-2 text-sm text-muted">
          Since 2018 the learned weights picked {hitRate(learned.since2018.learned.correct, learned.since2018.learned.fights)}{" "}
          against {hitRate(learned.since2018.frozen.correct, learned.since2018.frozen.fights)} for the old weights. Log loss
          is {learned.since2018.learned.logLoss.toFixed(3)} versus {learned.since2018.frozen.logLoss.toFixed(3)}. The loop
          is fit to the probability, which is what the bet uses.{" "}
          {learned.summary.draws.toLocaleString()} draws and no-contests were not scored.
          {extra.n
            ? ` After the file: ${extra.n} more fight${extra.n === 1 ? "" : "s"}, ${hitRate(extra.correct, extra.n)}, log loss ${(extra.logLoss / extra.n).toFixed(3)}.`
            : ""}
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs tracking-wide text-muted uppercase">By year</p>
            <ul className="grid gap-1">
              {learned.years.map((year) => (
                <li key={year.year} className="flex flex-wrap justify-between gap-x-3 text-sm">
                  <span className="text-muted">{year.year}</span>
                  <span className="text-fg">
                    {hitRate(year.learned, year.fights)}
                    <span className="text-muted"> learned · {hitRate(year.frozen, year.fights)} old · {year.fights}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 text-xs tracking-wide text-muted uppercase">Every event</p>
            <ul className="grid max-h-80 gap-1 overflow-y-auto pr-1">
              {learned.events.map((eventRow) => (
                <li key={`${eventRow.d}-${eventRow.n}`} className="text-sm break-words">
                  <span className="text-muted">{eventRow.d}</span> {eventRow.n}{" "}
                  <span className="text-bone">
                    {eventRow.f ? `${eventRow.c}/${eventRow.f}` : "no decision"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <footer className="mt-8 border-t border-line pt-4 text-sm text-muted">
        Prices are the sportsbook you selected, not the best number across books. A fight is marked mispriced when the
        model’s win chance beats that price by about 4% expected value, or 8% on a method or distance prop from the same
        book. Fanatics is listed, but a line shows only when a public board has posted one. Lines move. Confirm the
        number in your account before you bet. Injury burden is in the win percentage: fight-ending lines from UFC results,
        and sourced surgeries between fights. Petr Yan’s January 2026 lumbar surgery is one of those sourced notes. A
        missing line is not a clean bill of health. Camp quality, missed weight, and short notice are still not in the
        file. Refresh updates strike rates after a fight is in the public results. Scout notes can add public context,
        and only when you ask. They do not move the percentage.
      </footer>
    </main>
  );
}
