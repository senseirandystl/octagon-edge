import learned from "@/data/learned.json";
import {
  LEARNED_WEIGHTS,
  MODEL_KIND,
  PRIOR_WEIGHTS,
  RESIDUAL_ANCHOR,
  RESIDUAL_LR,
  baseLogit,
  normName,
  signalFeatures,
  signalProbability,
} from "./model";
import type { Fighter, FightWindow, InjuryItem, RoundStat } from "./types";

export const LEARN_LR = learned.lr;
export const LEARN_ANCHOR = learned.anchor;
const FALLBACK_SAPM = 3.8;
const FALLBACK_TD = 1.6;

export type SettledFight = {
  date: string;
  event: string;
  a: string;
  b: string;
  y: 0 | 1 | null;
  elevationFt: number;
  method: "ko" | "sub" | "dec" | "other";
  round: number;
  seconds: number;
  detail: string;
  methodText: string;
  nc: boolean;
  statsKnown: boolean;
  aStat: RoundStat;
  bStat: RoundStat;
};

export type LearnExtra = { n: number; correct: number; logLoss: number };

export type LearnMemory = {
  through: string;
  kind: "logistic" | "residual";
  stats: 1;
  weights: number[];
  seen: string[];
  extra: LearnExtra;
  fighters: Fighter[];
  injuries: InjuryItem[];
};

const MEMORY_KEY = "octagon-edge-learn";

export function readLearnMemory(): LearnMemory | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "") as LearnMemory;
    if (!parsed || parsed.kind !== MODEL_KIND || parsed.stats !== 1) return null;
    if (!parsed.weights || parsed.weights.length !== LEARNED_WEIGHTS.length) return null;
    if (parsed.through < learned.lastDate) return null;
    if (!Array.isArray(parsed.injuries)) return null;
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
    head15: 0,
    r3Strike: null,
    r3Acc: null,
    r3Def: null,
    r3Td: null,
    adjStrike: 0,
    adjTd: 0,
    distShare: null,
    clinchShare: null,
    groundShare: null,
    bodyShare: null,
    legShare: null,
    rev15: 0,
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
    marks: [],
    minRaw: 0,
    sigL: 0,
    sigA: 0,
    absorbed: 0,
    oppAtt: 0,
    tdL: 0,
    tdA: 0,
    tdDefL: 0,
    tdDefA: 0,
    kd: 0,
    ctrlSec: 0,
    headL: 0,
    bodyL: 0,
    legL: 0,
    distL: 0,
    clinchL: 0,
    groundL: 0,
    rev: 0,
    subAtt: 0,
    adjSNum: 0,
    adjSDen: 0,
    adjTNum: 0,
    adjTDen: 0,
    r1FinW: 0,
    lateFinW: 0,
    recent3: [],
  };
}

function applyResult(
  fighter: Fighter,
  result: "W" | "L" | "D" | "NC",
  method: SettledFight["method"],
  round: number,
  date: string,
): Fighter {
  const mark = result === "NC" ? "NC" : result;
  const marks = [...(fighter.marks ?? []), mark].slice(-5);
  const next = { ...fighter, last: date, marks, recent: marks.join("") };
  if (result === "W") {
    next.w += 1;
    if (method === "ko") next.koW += 1;
    else if (method === "sub") next.subW += 1;
    else if (method === "dec") next.decW += 1;
    if (method === "ko" || method === "sub") {
      if (round <= 1) next.r1FinW += 1;
      if (round >= 3) next.lateFinW += 1;
    }
  } else if (result === "L") {
    next.l += 1;
    if (method === "ko") next.koL += 1;
    else if (method === "sub") next.subL += 1;
  } else next.d += 1;
  if (result === "W" || result === "L") {
    const step = result === "W" ? 1 : -1;
    next.streak = fighter.streak === 0 || (fighter.streak > 0) === (step > 0) ? fighter.streak + step : step;
  } else next.streak = 0;
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

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function share(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return roundTo(part / whole, 3);
}

function preLevel(fighter: Fighter): { sapm: number; tdAllowed: number } | null {
  const minutes = fighter.minRaw ?? 0;
  if ((fighter.fights ?? 0) <= 0 || minutes <= 0) return null;
  return {
    sapm: fighter.absorbed / minutes,
    tdAllowed: ((fighter.tdDefA - fighter.tdDefL) / minutes) * 15,
  };
}

function applyLedger(
  fighter: Fighter,
  own: RoundStat,
  opp: RoundStat,
  seconds: number,
  oppLevel: { sapm: number; tdAllowed: number } | null,
): Fighter {
  const minutes = Math.max(seconds, 1) / 60;
  const sapm = oppLevel ? oppLevel.sapm : FALLBACK_SAPM;
  const allowed = oppLevel ? oppLevel.tdAllowed : FALLBACK_TD;
  const recent3: FightWindow[] = [
    ...(fighter.recent3 ?? []),
    {
      min: minutes,
      sigL: own.sigL,
      sigA: own.sigA,
      abs: opp.sigL,
      oppA: opp.sigA,
      tdL: own.tdL,
      tdAgainst: opp.tdA,
      tdConceded: opp.tdL,
    },
  ].slice(-3);
  return {
    ...fighter,
    fights: fighter.fights + 1,
    minRaw: (fighter.minRaw ?? 0) + minutes,
    recent3,
    sigL: (fighter.sigL ?? 0) + own.sigL,
    sigA: (fighter.sigA ?? 0) + own.sigA,
    absorbed: (fighter.absorbed ?? 0) + opp.sigL,
    oppAtt: (fighter.oppAtt ?? 0) + opp.sigA,
    tdL: (fighter.tdL ?? 0) + own.tdL,
    tdA: (fighter.tdA ?? 0) + own.tdA,
    tdDefA: (fighter.tdDefA ?? 0) + opp.tdA,
    tdDefL: (fighter.tdDefL ?? 0) + (opp.tdA - opp.tdL),
    subAtt: (fighter.subAtt ?? 0) + own.sub,
    kd: (fighter.kd ?? 0) + own.kd,
    ctrlSec: (fighter.ctrlSec ?? 0) + own.ctrl,
    headL: (fighter.headL ?? 0) + own.headL,
    bodyL: (fighter.bodyL ?? 0) + own.bodyL,
    legL: (fighter.legL ?? 0) + own.legL,
    distL: (fighter.distL ?? 0) + own.distL,
    clinchL: (fighter.clinchL ?? 0) + own.clinchL,
    groundL: (fighter.groundL ?? 0) + own.groundL,
    rev: (fighter.rev ?? 0) + own.rev,
    adjSNum: (fighter.adjSNum ?? 0) + (own.sigL - sapm * minutes),
    adjSDen: (fighter.adjSDen ?? 0) + minutes,
    adjTNum: (fighter.adjTNum ?? 0) + (own.tdL * 15 - allowed * minutes),
    adjTDen: (fighter.adjTDen ?? 0) + minutes,
  };
}

function recentBlock(window: FightWindow[]) {
  if (window.length < 2) return null;
  const minutes = window.reduce((sum, item) => sum + item.min, 0);
  if (minutes < 8) return null;
  const sigL = window.reduce((sum, item) => sum + item.sigL, 0);
  const sigA = window.reduce((sum, item) => sum + item.sigA, 0);
  const absorbed = window.reduce((sum, item) => sum + item.abs, 0);
  const oppA = window.reduce((sum, item) => sum + item.oppA, 0);
  const tdL = window.reduce((sum, item) => sum + item.tdL, 0);
  const tdAgainst = window.reduce((sum, item) => sum + item.tdAgainst, 0);
  const tdConceded = window.reduce((sum, item) => sum + item.tdConceded, 0);
  return {
    strike: sigL / minutes - absorbed / minutes,
    acc: sigA ? sigL / sigA : null,
    defn: oppA ? 1 - absorbed / oppA : null,
    td15: (tdL / minutes) * 15,
    tdDef: tdAgainst ? (tdAgainst - tdConceded) / tdAgainst : null,
  };
}

function derive(fighter: Fighter): Fighter {
  const minutes = Math.max(fighter.minRaw || 0, 0.1);
  const wins = fighter.w;
  const rates = recentBlock(fighter.recent3 ?? []);
  return {
    ...fighter,
    minutes: roundTo(fighter.minRaw, 1),
    slpm: roundTo(fighter.sigL / minutes, 2),
    sapm: roundTo(fighter.absorbed / minutes, 2),
    acc: fighter.sigA ? roundTo(fighter.sigL / fighter.sigA, 3) : null,
    defn: fighter.oppAtt ? roundTo(1 - fighter.absorbed / fighter.oppAtt, 3) : null,
    td15: roundTo((fighter.tdL / minutes) * 15, 2),
    tdAcc: fighter.tdA ? roundTo(fighter.tdL / fighter.tdA, 3) : null,
    tdDef: fighter.tdDefA ? roundTo(fighter.tdDefL / fighter.tdDefA, 3) : null,
    sub15: roundTo((fighter.subAtt / minutes) * 15, 2),
    kd15: roundTo((fighter.kd / minutes) * 15, 2),
    ctrl15: roundTo(((fighter.ctrlSec / minutes) * 15) / 60, 2),
    head15: roundTo((fighter.headL / minutes) * 15, 2),
    r3Strike: rates ? roundTo(rates.strike, 2) : null,
    r3Acc: rates && rates.acc != null ? roundTo(rates.acc, 3) : null,
    r3Def: rates && rates.defn != null ? roundTo(rates.defn, 3) : null,
    r3Td: rates ? roundTo(rates.td15, 2) : null,
    adjStrike: fighter.adjSDen ? roundTo(fighter.adjSNum / fighter.adjSDen, 2) : 0,
    adjTd: fighter.adjTDen ? roundTo(fighter.adjTNum / fighter.adjTDen, 2) : 0,
    distShare: share(fighter.distL, fighter.sigL),
    clinchShare: share(fighter.clinchL, fighter.sigL),
    groundShare: share(fighter.groundL, fighter.sigL),
    bodyShare: share(fighter.bodyL, fighter.sigL),
    legShare: share(fighter.legL, fighter.sigL),
    rev15: roundTo((fighter.rev / minutes) * 15, 2),
    r1Fin: wins ? roundTo(fighter.r1FinW / wins, 3) : 0,
    lateFin: wins ? roundTo(fighter.lateFinW / wins, 3) : 0,
    finRate: wins ? roundTo((fighter.koW + fighter.subW) / wins, 3) : 0,
    koRate: wins ? roundTo(fighter.koW / wins, 3) : 0,
    subRate: wins ? roundTo(fighter.subW / wins, 3) : 0,
    koVuln: fighter.l ? roundTo(fighter.koL / fighter.l, 3) : 0,
    subVuln: fighter.l ? roundTo(fighter.subL / fighter.l, 3) : 0,
  };
}

const STRUCTURAL: [string, string][] = [
  ["knee", "knee"],
  ["ankle", "ankle"],
  ["shoulder", "shoulder"],
  ["elbow", "elbow"],
  ["wrist", "wrist"],
  ["hand", "hand"],
  ["rib", "rib"],
  ["lumbar", "lumbar"],
  ["spine", "spine"],
  ["back", "back"],
  ["hip", "hip"],
  ["foot", "foot"],
  ["neck", "neck"],
  ["jaw", "jaw"],
  ["leg", "leg"],
  ["arm", "arm"],
];

function mentioned(text: string, name: string): boolean {
  const raw = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const last = parts[parts.length - 1]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (last.length >= 3 && new RegExp(`\\b${last}\\b`).test(raw)) return true;
  if (parts.length >= 2) {
    const duo = `${parts[parts.length - 2]} ${parts[parts.length - 1]}`
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (duo && raw.includes(duo)) return true;
  }
  return false;
}

function classifyInjury(text: string): { area: string; severity: number } | null {
  const low = text.toLowerCase();
  const structural = STRUCTURAL.find(([key]) => low.includes(key))?.[1] ?? null;
  const hasCut = ["eye", "cut", "lacerat"].some((word) => low.includes(word));
  const hasInjury = low.includes("injur") || low.includes("surgery") || low.includes("surgic");
  if (hasCut && !(structural && hasInjury && !low.includes("cut") && !low.includes("eye"))) {
    return { area: "eye/cut", severity: 0.25 };
  }
  if (structural && (hasInjury || low.includes("doctor"))) return { area: structural, severity: 0.75 };
  if (hasInjury) return { area: "unspecified injury", severity: 0.55 };
  if (low.includes("doctor")) return { area: "doctor stoppage", severity: 0.45 };
  return null;
}

export function injuryFromFight(fight: SettledFight): InjuryItem | null {
  const blob = `${fight.methodText} ${fight.detail}`;
  const low = blob.toLowerCase();
  if (!low.includes("injur") && !low.includes("doctor") && !low.includes("surgery") && !low.includes("cut")) return null;
  const classified = classifyInjury(blob);
  if (!classified) return null;
  const named = [fight.a, fight.b].filter((name) => mentioned(blob, name));
  const fighter = named.length === 1 ? named[0] : fight.y === 1 ? fight.b : fight.y === 0 ? fight.a : "";
  if (!fighter) return null;
  return {
    fighter,
    date: fight.date,
    area: classified.area,
    severity: classified.severity,
    kind: "result",
    detail: fight.detail.trim(),
    source: "UFCStats result",
    event: fight.event,
  };
}

export function nextWeights(
  weights: readonly number[],
  rows: { features: number[]; y: 0 | 1; debut: boolean }[],
): number[] {
  const residual = MODEL_KIND === "residual";
  const lr = residual ? RESIDUAL_LR : LEARN_LR;
  const anchor = residual ? RESIDUAL_ANCHOR : LEARN_ANCHOR;
  if (!rows.length || !lr) return weights.slice();
  const grad = weights.map(() => 0);
  let mass = 0;
  for (const row of rows) {
    const z = baseLogit(row.features) + row.features.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0);
    const clipped = Math.max(-12, Math.min(12, z));
    const probability = 1 / (1 + Math.exp(-clipped));
    const scale = row.debut ? 0.25 : 1;
    row.features.forEach((value, index) => {
      grad[index] += scale * (probability - row.y) * value;
    });
    mass += scale;
  }
  if (!mass) return weights.slice();
  return weights.map((weight, index) => {
    const prior = residual ? 0 : PRIOR_WEIGHTS[index];
    return weight - lr * (grad[index] / mass + anchor * (weight - prior));
  });
}

function fightKey(fight: SettledFight): string {
  return `${fight.date}|${normName(fight.a)}|${normName(fight.b)}`;
}

export function foldSettled(
  weights: readonly number[],
  fights: SettledFight[],
  index: Map<string, Fighter>,
  memory: Pick<LearnMemory, "seen" | "extra" | "fighters" | "injuries">,
): LearnMemory {
  const overlay = new Map<string, Fighter>();
  for (const fighter of memory.fighters) overlay.set(normName(fighter.name), fighter);
  const seen = new Set(memory.seen);
  const extra = { ...memory.extra };
  const injuries = memory.injuries.slice();
  let current = weights.slice();
  const ordered = fights
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date) || left.event.localeCompare(right.event));
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
      let left = overlay.get(normName(fight.a)) ?? cloneOf(index.get(normName(fight.a))) ?? blankFighter(fight.a);
      let right = overlay.get(normName(fight.b)) ?? cloneOf(index.get(normName(fight.b))) ?? blankFighter(fight.b);
      if (fight.y === 0 || fight.y === 1) {
        const features = signalFeatures(left, right, fight.date, fight.elevationFt);
        const probability = signalProbability(features, current);
        extra.n += 1;
        extra.correct += Number((probability > 0.5 && fight.y === 1) || (probability < 0.5 && fight.y === 0));
        extra.logLoss += -(fight.y * Math.log(probability) + (1 - fight.y) * Math.log(1 - probability));
        rows.push({ features, y: fight.y, debut: left.fights === 0 || right.fights === 0 });
      }
      if (fight.statsKnown) {
        const levelLeft = preLevel(left);
        const levelRight = preLevel(right);
        left = applyLedger(left, fight.aStat, fight.bStat, fight.seconds, levelRight);
        right = applyLedger(right, fight.bStat, fight.aStat, fight.seconds, levelLeft);
      } else {
        left = { ...left, fights: left.fights + 1 };
        right = { ...right, fights: right.fights + 1 };
      }
      const leftResult = fight.y === 1 ? "W" : fight.y === 0 ? "L" : fight.nc ? "NC" : "D";
      const rightResult = fight.y === 1 ? "L" : fight.y === 0 ? "W" : fight.nc ? "NC" : "D";
      left = applyResult(left, leftResult, fight.method, fight.round, fight.date);
      right = applyResult(right, rightResult, fight.method, fight.round, fight.date);
      if (fight.statsKnown) {
        left = derive(left);
        right = derive(right);
      }
      const [nextLeft, nextRight] = applyElo(left, right, fight.y);
      const note = injuryFromFight(fight);
      if (note && !injuries.some((item) => item.date === note.date && normName(item.fighter) === normName(note.fighter))) {
        injuries.push(note);
      }
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
    kind: MODEL_KIND,
    stats: 1,
    weights: current.map((value) => Math.round(value * 10000) / 10000),
    seen: [...seen],
    extra,
    fighters: [...overlay.values()],
    injuries,
  };
}

function cloneOf(fighter: Fighter | undefined): Fighter | undefined {
  return fighter ? { ...fighter, marks: [...(fighter.marks ?? [])], recent3: [...(fighter.recent3 ?? [])] } : undefined;
}
