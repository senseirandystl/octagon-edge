export type Fighter = {
  name: string;
  height: number | null;
  reach: number | null;
  stance: string | null;
  dob: string | null;
  weight: number | null;
  w: number;
  l: number;
  d: number;
  koW: number;
  subW: number;
  decW: number;
  koL: number;
  subL: number;
  fights: number;
  minutes: number;
  slpm: number;
  sapm: number;
  acc: number | null;
  defn: number | null;
  td15: number;
  tdAcc: number | null;
  tdDef: number | null;
  sub15: number;
  kd15: number;
  ctrl15: number;
  head15: number;
  r3Strike: number | null;
  r3Acc: number | null;
  r3Def: number | null;
  r3Td: number | null;
  adjStrike: number;
  adjTd: number;
  distShare: number | null;
  clinchShare: number | null;
  groundShare: number | null;
  bodyShare: number | null;
  legShare: number | null;
  rev15: number;
  r1Fin: number;
  lateFin: number;
  finRate: number;
  koRate: number;
  subRate: number;
  koVuln: number;
  subVuln: number;
  elo: number;
  streak: number;
  recent: string;
  last: string | null;
  marks: string[];
  minRaw: number;
  sigL: number;
  sigA: number;
  absorbed: number;
  oppAtt: number;
  tdL: number;
  tdA: number;
  tdDefL: number;
  tdDefA: number;
  kd: number;
  ctrlSec: number;
  headL: number;
  bodyL: number;
  legL: number;
  distL: number;
  clinchL: number;
  groundL: number;
  rev: number;
  subAtt: number;
  adjSNum: number;
  adjSDen: number;
  adjTNum: number;
  adjTDen: number;
  r1FinW: number;
  lateFinW: number;
  recent3: FightWindow[];
};

export type FightWindow = {
  min: number;
  sigL: number;
  sigA: number;
  abs: number;
  oppA: number;
  tdL: number;
  tdAgainst: number;
  tdConceded: number;
};

export type RoundStat = {
  sigL: number;
  sigA: number;
  tdL: number;
  tdA: number;
  kd: number;
  ctrl: number;
  headL: number;
  bodyL: number;
  legL: number;
  distL: number;
  clinchL: number;
  groundL: number;
  rev: number;
  sub: number;
};

export type InjuryItem = {
  fighter: string;
  date: string;
  area: string;
  severity: number;
  kind: string;
  detail: string;
  source: string;
  event: string | null;
};

export type Bout = {
  a: string;
  b: string;
  weight: string;
  title: boolean;
};

export type UfcEvent = {
  id: string;
  name: string;
  date: string;
  venue: string;
  location: string;
  elevationFt: number;
  bouts: Bout[];
};

export type DiffRow = {
  label: string;
  a: string;
  b: string;
  edge: "a" | "b" | "even";
};

export type Flag = {
  side: "a" | "b" | "both";
  text: string;
};

export type MethodSlice = {
  label: string;
  pct: number;
};

export type Prediction = {
  aName: string;
  bName: string;
  pA: number;
  methods: MethodSlice[];
  rounds: MethodSlice[];
  diffs: DiffRow[];
  flags: Flag[];
  missing: string | null;
};
