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
