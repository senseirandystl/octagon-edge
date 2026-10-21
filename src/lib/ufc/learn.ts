import learned from "@/data/learned.json";
import {
  LEARNED_WEIGHTS,
  PRIOR_WEIGHTS,
  normName,
  signalFeatures,
  signalProbability,
} from "./model";
import type { Fighter } from "./types";

export const LEARN_LR = learned.lr;
export const LEARN_ANCHOR = learned.anchor;

export type SettledFight = {
  date: string;
  event: string;
  a: string;
  b: string;
  y: 0 | 1 | null;
  elevationFt: number;
};

export type LearnExtra = { n: number; correct: number; logLoss: number };

export type LearnMemory = {
  through: string;
  weights: number[];
  seen: string[];
  extra: LearnExtra;
  fighters: Fighter[];
};

const MEMORY_KEY = "octagon-edge-learn";

export function readLearnMemory(): LearnMemory | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "") as LearnMemory;
    if (!parsed || parsed.weights?.length !== LEARNED_WEIGHTS.length) return null;
    if (parsed.through < learned.lastDate) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLearnMemory(memory: LearnMemory): void {
  localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
}

export function blankFighter(name: string): Fighter {
  return {
    name,
    height: null,
    reach: null,
    stance: null,
    dob: null,
    weight: null,
    w: 0,
    l: 0,
    d: 0,
    koW: 0,
    subW: 0,
    decW: 0,
    koL: 0,
    subL: 0,
    fights: 0,
    minutes: 0,
    slpm: 0,
    sapm: 0,
    acc: null,
    defn: null,
    td15: 0,
    tdAcc: null,
    tdDef: null,
    sub15: 0,
    kd15: 0,
    ctrl15: 0,
    r1Fin: 0,
    lateFin: 0,
    finRate: 0,
    koRate: 0,
    subRate: 0,
    koVuln: 0,
    subVuln: 0,
    elo: 1500,
    streak: 0,
    recent: "",
    last: null,
  };
}

function applyResult(fighter: Fighter, result: "W" | "L" | "D" | "NC", date: string): Fighter {
  const next = { ...fighter, fights: fighter.fights + 1, last: date };
  if (result === "W") next.w += 1;
  else if (result === "L") next.l += 1;
  else next.d += 1;
  next.recent = `${fighter.recent}${result === "NC" ? "N" : result}`.slice(-5);
  if (result === "W" || result === "L") {
    const step = result === "W" ? 1 : -1;
    next.streak = fighter.streak === 0 || (fighter.streak > 0) === (step > 0) ? fighter.streak + step : step;
  } else {
    next.streak = 0;
  }
  return next;
}

function applyElo(a: Fighter, b: Fighter, y: 0 | 1 | null): [Fighter, Fighter] {
  const expected = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
  const score = y == null ? 0.5 : y;
  const round = (value: number) => Math.round(value * 10) / 10;
  return [
    { ...a, elo: round(a.elo + 28 * (score - expected)) },
    { ...b, elo: round(b.elo + 28 * ((1 - score) - (1 - expected))) },
  ];
}

export function nextWeights(
  weights: readonly number[],
  rows: { features: number[]; y: 0 | 1; debut: boolean }[],
): number[] {
  if (!rows.length || !LEARN_LR) return weights.slice();
  const grad = weights.map(() => 0);
  let mass = 0;
  for (const row of rows) {
    const z = row.features.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0);
    const clipped = Math.max(-12, Math.min(12, z));
    const probability = 1 / (1 + Math.exp(-clipped));
    const scale = row.debut ? 0.25 : 1;
    row.features.forEach((value, index) => {
      grad[index] += scale * (probability - row.y) * value;
    });
    mass += scale;
  }
  if (!mass) return weights.slice();
  return weights.map(
    (weight, index) =>
      weight - LEARN_LR * (grad[index] / mass + LEARN_ANCHOR * (weight - PRIOR_WEIGHTS[index])),
  );
}

function fightKey(fight: SettledFight): string {
  return `${fight.date}|${normName(fight.a)}|${normName(fight.b)}`;
}

export function foldSettled(
  weights: readonly number[],
  fights: SettledFight[],
  index: Map<string, Fighter>,
  memory: Pick<LearnMemory, "seen" | "extra" | "fighters">,
): LearnMemory {
  const overlay = new Map<string, Fighter>();
  for (const fighter of memory.fighters) overlay.set(normName(fighter.name), fighter);
  const seen = new Set(memory.seen);
  const extra = { ...memory.extra };
  let current = weights.slice();
  const ordered = fights.slice().sort((left, right) => left.date.localeCompare(right.date) || left.event.localeCompare(right.event));
  const groups = new Map<string, SettledFight[]>();
  for (const fight of ordered) {
    const key = `${fight.date}|${fight.event}`;
    const group = groups.get(key);
    if (group) group.push(fight);
    else groups.set(key, [fight]);
  }
  let through = learned.lastDate;
  for (const group of groups.values()) {
    const rows: { features: number[]; y: 0 | 1; debut: boolean }[] = [];
    const pending: { key: string; aName: string; bName: string; a: Fighter; b: Fighter }[] = [];
    for (const fight of group) {
      const key = fightKey(fight);
      if (fight.date <= learned.lastDate || seen.has(key)) continue;
      seen.add(key);
      const left = overlay.get(normName(fight.a)) ?? cloneOf(index.get(normName(fight.a))) ?? blankFighter(fight.a);
      const right = overlay.get(normName(fight.b)) ?? cloneOf(index.get(normName(fight.b))) ?? blankFighter(fight.b);
      if (fight.y === 0 || fight.y === 1) {
        const features = signalFeatures(left, right, fight.date, fight.elevationFt);
        const probability = signalProbability(features, current);
        extra.n += 1;
        extra.correct += Number((probability > 0.5 && fight.y === 1) || (probability < 0.5 && fight.y === 0));
        extra.logLoss += -(fight.y * Math.log(probability) + (1 - fight.y) * Math.log(1 - probability));
        rows.push({ features, y: fight.y, debut: left.fights === 0 || right.fights === 0 });
      }
      const leftResult = fight.y === 1 ? "W" : fight.y === 0 ? "L" : "D";
      const rightResult = fight.y === 1 ? "L" : fight.y === 0 ? "W" : "D";
      const [nextLeft, nextRight] = applyElo(
        applyResult(left, leftResult, fight.date),
        applyResult(right, rightResult, fight.date),
        fight.y,
      );
      pending.push({ key, aName: fight.a, bName: fight.b, a: nextLeft, b: nextRight });
      if (fight.date > through) through = fight.date;
    }
    current = nextWeights(current, rows);
    for (const item of pending) {
      seen.add(item.key);
      overlay.set(normName(item.aName), item.a);
      overlay.set(normName(item.bName), item.b);
    }
  }
  return {
    through,
    weights: current.map((value) => Math.round(value * 10000) / 10000),
    seen: [...seen],
    extra,
    fighters: [...overlay.values()],
  };
}

function cloneOf(fighter: Fighter | undefined): Fighter | undefined {
  return fighter ? { ...fighter } : undefined;
}
