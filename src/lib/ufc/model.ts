import type { Bout, DiffRow, Fighter, Flag, Prediction, UfcEvent } from "./types";

export function normName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function indexFighters(fighters: Fighter[]): Map<string, Fighter> {
  const map = new Map<string, Fighter>();
  for (const fighter of fighters) map.set(normName(fighter.name), fighter);
  return map;
}

export function findFighter(index: Map<string, Fighter>, name: string): Fighter | undefined {
  return index.get(normName(name));
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function ageOn(dob: string | null, on: string): number | null {
  if (!dob) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  const day = new Date(`${on}T00:00:00Z`);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(day.getTime())) return null;
  let years = day.getUTCFullYear() - birth.getUTCFullYear();
  const month = day.getUTCMonth() - birth.getUTCMonth();
  if (month < 0 || (month === 0 && day.getUTCDate() < birth.getUTCDate())) years -= 1;
  return years;
}

function daysSince(last: string | null, on: string): number | null {
  if (!last) return null;
  const start = new Date(`${last}T00:00:00Z`).getTime();
  const end = new Date(`${on}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

function formScore(recent: string): number {
  const weights = [0.35, 0.25, 0.2, 0.12, 0.08];
  const chars = recent.slice(-5).split("").reverse();
  let total = 0;
  let used = 0;
  chars.forEach((mark, index) => {
    const weight = weights[index] ?? 0.05;
    if (mark === "W") total += weight;
    else if (mark === "L") total -= weight;
    used += weight;
  });
  return used ? total / used : 0;
}

function layoffTerm(days: number | null): number {
  if (days == null) return -0.15;
  if (days < 90) return 0.05;
  if (days < 240) return 0.12;
  if (days < 400) return 0;
  if (days < 700) return -0.35;
  return -0.6;
}

function pct(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

function num(value: number | null, digits = 2): string {
  if (value == null) return "—";
  return value.toFixed(digits);
}

function edge(a: number | null, b: number | null, higherIsBetter = true): DiffRow["edge"] {
  if (a == null || b == null) return "even";
  const delta = higherIsBetter ? a - b : b - a;
  if (Math.abs(delta) < 0.015) return "even";
  return delta > 0 ? "a" : "b";
}

function record(fighter: Fighter): string {
  return `${fighter.w}-${fighter.l}${fighter.d ? `-${fighter.d}` : ""}`;
}

export function predictBout(
  a: Fighter | undefined,
  b: Fighter | undefined,
  bout: Bout,
  event: UfcEvent,
): Prediction {
  if (!a || !b) {
    const missing = [!a ? bout.a : null, !b ? bout.b : null].filter(Boolean).join(", ");
    return {
      aName: bout.a,
      bName: bout.b,
      pA: 0.5,
      methods: [],
      rounds: [],
      diffs: [],
      flags: [],
      missing: `No UFC history on file for ${missing}.`,
    };
  }

  const ageA = ageOn(a.dob, event.date);
  const ageB = ageOn(b.dob, event.date);
  const layoffA = daysSince(a.last, event.date);
  const layoffB = daysSince(b.last, event.date);
  const strikeA = a.slpm - a.sapm;
  const strikeB = b.slpm - b.sapm;
  const peak = (years: number) => -((years - 30) ** 2) / 55;
  const ageEdge = ageA != null && ageB != null ? peak(ageA) - peak(ageB) : 0;
  const wrestleA = a.td15 > 1.4 ? 1 : 0.35;
  const wrestleB = b.td15 > 1.4 ? 1 : 0.35;

  const z =
    0.62 * ((a.elo - b.elo) / 90) +
    0.34 * ((strikeA - strikeB) / 2.1) +
    0.16 * (((a.acc ?? 0.45) - (b.acc ?? 0.45)) / 0.08) +
    0.16 * (((a.defn ?? 0.55) - (b.defn ?? 0.55)) / 0.08) +
    0.28 * (((a.td15 - b.td15) / 2.4) * (1.15 - (b.tdDef ?? 0.65)) * wrestleA) -
    0.28 * (((b.td15 - a.td15) / 2.4) * (1.15 - (a.tdDef ?? 0.65)) * wrestleB) +
    0.2 * (((a.tdDef ?? 0.65) - (b.tdDef ?? 0.65)) * (wrestleA + wrestleB)) +
    0.07 * (a.reach != null && b.reach != null ? (a.reach - b.reach) / 4 : 0) +
    0.42 * ageEdge +
    0.26 * (formScore(a.recent) - formScore(b.recent)) +
    0.22 * (layoffTerm(layoffA) - layoffTerm(layoffB)) +
    0.14 * (clamp(a.streak, -4, 4) / 4 - clamp(b.streak, -4, 4) / 4) +
    0.06 * (Math.log(a.fights + 1) - Math.log(b.fights + 1)) +
    (event.elevationFt >= 5000 ? -0.08 * Math.sign((a.minutes || 1) - (b.minutes || 1)) : 0);

  const pA = clamp(logistic(z), 0.07, 0.93);
  const pB = 1 - pA;
  const rounds = bout.title ? 5 : 3;

  const mix = (winner: Fighter, loser: Fighter) => {
    const ko = 0.35 + winner.koRate * 1.15 * (0.7 + loser.koVuln) + winner.kd15 * 0.35;
    const sub = 0.22 + winner.subRate * 1.2 * (0.7 + loser.subVuln) + winner.sub15 * 0.45;
    const dec = 0.85 + (1 - winner.finRate) * 1.1 + (loser.defn ?? 0.5);
    const sum = ko + sub + dec;
    return { ko: ko / sum, sub: sub / sum, dec: dec / sum };
  };
  const mixA = mix(a, b);
  const mixB = mix(b, a);

  const methods = [
    { label: `${short(a.name)} KO/TKO`, pct: pA * mixA.ko },
    { label: `${short(a.name)} submission`, pct: pA * mixA.sub },
    { label: `${short(a.name)} decision`, pct: pA * mixA.dec },
    { label: `${short(b.name)} KO/TKO`, pct: pB * mixB.ko },
    { label: `${short(b.name)} submission`, pct: pB * mixB.sub },
    { label: `${short(b.name)} decision`, pct: pB * mixB.dec },
  ].sort((left, right) => right.pct - left.pct);

  const finishA = pA * (mixA.ko + mixA.sub);
  const finishB = pB * (mixB.ko + mixB.sub);
  const decision = pA * mixA.dec + pB * mixB.dec;
  const r1Share = clamp((a.r1Fin * pA + b.r1Fin * pB) / Math.max(pA + pB, 0.01) + 0.28, 0.22, 0.62);
  const early = (finishA + finishB) * r1Share;
  const middle = rounds === 5 ? (finishA + finishB) * (1 - r1Share) * 0.62 : (finishA + finishB) * (1 - r1Share);
  const lateFinish = rounds === 5 ? (finishA + finishB) * (1 - r1Share) * 0.38 : 0;
  const roundRows =
    rounds === 5
      ? [
          { label: "Round 1", pct: early },
          { label: "Round 2", pct: middle * 0.7 },
          { label: "Rounds 3–4", pct: middle * 0.3 + lateFinish },
          { label: "Decision", pct: decision },
        ]
      : [
          { label: "Round 1", pct: early },
          { label: "Round 2", pct: middle },
          { label: "Decision", pct: decision },
        ];

  const diffs: DiffRow[] = [
    { label: "UFC record", a: record(a), b: record(b), edge: edge(a.elo, b.elo) },
    { label: "Elo", a: a.elo.toFixed(0), b: b.elo.toFixed(0), edge: edge(a.elo, b.elo) },
    {
      label: "Strike diff / min",
      a: num(strikeA),
      b: num(strikeB),
      edge: edge(strikeA, strikeB),
    },
    { label: "Accuracy", a: pct(a.acc), b: pct(b.acc), edge: edge(a.acc, b.acc) },
    { label: "Strike defense", a: pct(a.defn), b: pct(b.defn), edge: edge(a.defn, b.defn) },
    { label: "Takedowns / 15", a: num(a.td15), b: num(b.td15), edge: edge(a.td15, b.td15) },
    { label: "Takedown defense", a: pct(a.tdDef), b: pct(b.tdDef), edge: edge(a.tdDef, b.tdDef) },
    { label: "Reach", a: a.reach ? `${a.reach}"` : "—", b: b.reach ? `${b.reach}"` : "—", edge: edge(a.reach, b.reach) },
    {
      label: "Age",
      a: ageA == null ? "—" : String(ageA),
      b: ageB == null ? "—" : String(ageB),
      edge: ageA == null || ageB == null ? "even" : edge(peak(ageA), peak(ageB)),
    },
    { label: "Last 5", a: a.recent || "—", b: b.recent || "—", edge: edge(formScore(a.recent), formScore(b.recent)) },
    {
      label: "Days since last",
      a: layoffA == null ? "—" : String(layoffA),
      b: layoffB == null ? "—" : String(layoffB),
      edge: edge(layoffTerm(layoffA), layoffTerm(layoffB)),
    },
  ];

  const flags: Flag[] = [];
  const note = (side: "a" | "b", fighter: Fighter, years: number | null, layoff: number | null) => {
    if (fighter.streak <= -3) flags.push({ side, text: `${short(fighter.name)} is on a ${Math.abs(fighter.streak)}-fight UFC losing streak.` });
    if (fighter.streak >= 4) flags.push({ side, text: `${short(fighter.name)} has won ${fighter.streak} UFC fights in a row.` });
    if (layoff != null && layoff > 420) flags.push({ side, text: `${short(fighter.name)} has been out ${Math.round(layoff / 30)} months.` });
    if (years != null && years >= 38) flags.push({ side, text: `${short(fighter.name)} is ${years} — past the typical peak window.` });
    if (fighter.fights < 3) flags.push({ side, text: `${short(fighter.name)} has only ${fighter.fights} UFC fight${fighter.fights === 1 ? "" : "s"} on file.` });
    if (fighter.l >= 2 && fighter.koVuln >= 0.45) flags.push({ side, text: `${short(fighter.name)} has been stopped by KO/TKO in ${Math.round(fighter.koVuln * 100)}% of UFC losses.` });
  };
  note("a", a, ageA, layoffA);
  note("b", b, ageB, layoffB);
  if (a.stance && b.stance && a.stance !== b.stance && (a.stance === "Southpaw" || b.stance === "Southpaw")) {
    flags.push({ side: "both", text: `Stance mismatch: ${a.stance} vs ${b.stance}.` });
  }
  if (event.elevationFt >= 4500) {
    flags.push({ side: "both", text: `Card is at about ${event.elevationFt.toLocaleString()} ft. Cardio usually matters more than the finish rate.` });
  }

  return {
    aName: a.name,
    bName: b.name,
    pA,
    methods: methods.slice(0, 4),
    rounds: roundRows,
    diffs,
    flags,
    missing: null,
  };
}

function short(name: string): string {
  const parts = name.split(" ");
  return parts[parts.length - 1] ?? name;
}
