import { useMemo, useState } from "react";
import { RefreshCw, ScanSearch } from "lucide-react";
import profiles from "@/data/fighters.json";
import bundled from "@/data/schedule.json";
import { scoutFight } from "@/lib/ufc/enrich";
import { findFighter, indexFighters, predictBout } from "@/lib/ufc/model";
import { refreshSchedule } from "@/lib/ufc/refresh";
import type { Fighter, Prediction, UfcEvent } from "@/lib/ufc/types";

type Provider = "grok" | "openai" | "anthropic";

type ScoutState = { status: "idle" | "loading" | "done" | "error"; text: string };

const fighters = (profiles as { fighters: Fighter[]; asOf: string }).fighters;
const historyAsOf = (profiles as { asOf: string }).asOf;

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
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

  const event = events.find((item) => item.id === eventId) ?? events[0];

  const predictions = useMemo(() => {
    if (!event || !analyzed) return [] as Prediction[];
    return event.bouts.map((bout) =>
      predictBout(findFighter(index, bout.a), findFighter(index, bout.b), bout, event),
    );
  }, [analyzed, event, index]);

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
    } catch {
      setStatus("Refresh failed. The saved card is still loaded.");
    } finally {
      setRefreshing(false);
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
          Records are UFC bouts only, not regional or pro totals. Division labels are not weigh-in weights.
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
            onClick={() => setAnalyzed(true)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-ember px-4 text-sm font-semibold text-bg"
          >
            <ScanSearch className="size-4" aria-hidden="true" />
            Analyze
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
        <p className="text-sm text-bone sm:col-span-2">{status}</p>
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
                <p className="text-sm text-bone">{prediction.missing}</p>
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

                  <div className="mb-4 grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-1 text-xs tracking-wide text-muted uppercase">Likely paths</p>
                      <ul className="grid gap-1">
                        {prediction.methods.map((item) => (
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
        Estimates come from UFC history only: Elo, striking, wrestling, age, recent form, layoff, and streak. They are not
        betting advice. Surgery, camp changes, and scale weights are not in the file — Scout notes can add public context,
        and only when you ask. Grok uses the app key. ChatGPT and Anthropic use a key you paste for this session; it is not
        saved.
      </footer>
    </main>
  );
}
