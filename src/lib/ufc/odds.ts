import type { Prediction } from "./types";

export const BOOK_ORDER = [
  "DraftKings",
  "FanDuel",
  "BetMGM",
  "Caesars",
  "Fanatics",
  "BetRivers",
  "Hard Rock Bet",
  "Bovada",
] as const;

const BFO_BOOKS: Record<number, string> = {
  22: "DraftKings",
  21: "FanDuel",
  23: "BetMGM",
  24: "Caesars",
  25: "BetRivers",
  20: "BetWay",
  26: "Unibet",
};

export type BookLine = { book: string; a: number; b: number };

export type PropLine = {
  key: string;
  label: string;
  decimal: number;
  american: number;
  book: string;
};

export type MarketFight = {
  a: string;
  b: string;
  books: BookLine[];
  props: PropLine[];
};

export type ValuePick = {
  label: string;
  book: string;
  american: number;
  ev: number;
  model: number;
  market: number | null;
  kind: "Moneyline" | "Prop";
};

export type Grade = {
  book: string;
  a: number | null;
  b: number | null;
  noVigA: number | null;
  evA: number | null;
  evB: number | null;
  picks: ValuePick[];
  pass: string | null;
};

function normName(value: string): string {
  const base = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (base === "lasminlucindo") return "iasminlucindo";
  return base;
}

function lastName(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  return normName(parts[parts.length - 1] ?? name);
}

function decode(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\u0026#189;/g, " ")
    .replace(/\u0026#0?39;|\u0026#8217;|\u0026rsquo;/g, "'")
    .replace(/\u0026amp;/g, "\u0026")
    .replace(/\u0026nbsp;/g, " ")
    .replace(/\u0026quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const ML_EV = 0.04;
const PROP_EV = 0.08;

export function decimalFromAmerican(american: number): number {
  if (american > 0) return 1 + american / 100;
  if (american < 0) return 1 + 100 / Math.abs(american);
  return 0;
}

export function toAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1.01) return 0;
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

export function formatAmerican(american: number | null): string {
  if (american == null || american === 0) return "—";
  return american > 0 ? `+${american}` : String(american);
}

function fair(decimalA: number, decimalB: number): [number, number] | null {
  if (decimalA <= 1 || decimalB <= 1) return null;
  const impA = 1 / decimalA;
  const impB = 1 / decimalB;
  const sum = impA + impB;
  if (sum <= 0) return null;
  return [impA / sum, impB / sum];
}

export function parseDiaryHtml(html: string): MarketFight[] {
  const fights: MarketFight[] = [];
  for (const part of html.split(/<table\b/i).slice(1)) {
    const table = part.split(/<\/table>/i)[0] ?? "";
    if (!table.includes('class="bk"')) continue;
    const head = table.match(/<thead>[\s\S]*?<\/thead>/i)?.[0] ?? "";
    const names = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((match) => decode(match[1]));
    if (names[0] !== "Book" || names.length < 3) continue;
    const books: BookLine[] = [];
    const seen = new Set<string>();
    for (const row of table.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      if (!row[0].includes('class="bk"')) continue;
      const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => decode(match[1]));
      const book = cells[0];
      const a = Number(cells[1]);
      const b = Number(cells[2]);
      if (!book || seen.has(book) || !(a > 1) || !(b > 1)) continue;
      seen.add(book);
      books.push({ book, a, b });
    }
    if (books.length) fights.push({ a: names[1], b: names[2], books, props: [] });
  }
  return fights;
}

function cellAmerican(row: string): Record<number, number> {
  const prices: Record<number, number> = {};
  for (const cell of row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
    const book = cell[1].match(/data-li="\[(\d+)/);
    const price = cell[2].match(/>([+-]\d+)</);
    if (!book || !price) continue;
    prices[Number(book[1])] = Number(price[1]);
  }
  return prices;
}

function linesFromSides(aPrices: Record<number, number>, bPrices: Record<number, number>): BookLine[] {
  const books: BookLine[] = [];
  for (const [id, name] of Object.entries(BFO_BOOKS)) {
    const americanA = aPrices[Number(id)];
    const americanB = bPrices[Number(id)];
    if (americanA == null || americanB == null) continue;
    const a = decimalFromAmerican(americanA);
    const b = decimalFromAmerican(americanB);
    if (a > 1 && b > 1) books.push({ book: name, a, b });
  }
  return books;
}

function propsFor(label: string, key: string, prices: Record<number, number>): PropLine[] {
  const props: PropLine[] = [];
  for (const [id, name] of Object.entries(BFO_BOOKS)) {
    const american = prices[Number(id)];
    if (american == null) continue;
    const decimal = decimalFromAmerican(american);
    if (decimal <= 1) continue;
    props.push({ key, label, decimal, american, book: name });
  }
  return props;
}

export function parseBestFightOddsHtml(html: string): MarketFight[] {
  const table = html.split('<table class="odds-table">')[1];
  if (!table) return [];
  const body = table.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  const fights: MarketFight[] = [];
  let current: MarketFight | null = null;
  let expect: "a" | "b" = "a";

  for (const chunk of body.split(/<tr\b/).slice(1)) {
    const row = `<tr${chunk}`;
    const fighter = row.match(/class="t-b-fcc">([^<]+)/);
    if (fighter) {
      const name = decode(fighter[1]);
      const prices = cellAmerican(row);
      if (expect === "b" && current) {
        const aPrices: Record<number, number> = {};
        for (const line of current.books) aPrices[Number(line.book)] = line.a;
        current.b = name;
        current.books = linesFromSides(aPrices, prices);
        expect = "a";
      } else {
        if (current?.a && current.b) fights.push(current);
        current = { a: name, b: "", books: holdSide(prices), props: [] };
        expect = "b";
      }
      continue;
    }
    if (!current || expect === "b") continue;
    const label = decode(row.match(/<th[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? "");
    const props = propFromLabel(label, current, cellAmerican(row));
    current.props.push(...props);
  }
  if (current?.a && current.b) fights.push(current);
  return fights.filter((fight) => fight.books.length || fight.props.length);
}

function holdSide(prices: Record<number, number>): BookLine[] {
  return Object.entries(prices).map(([id, american]) => ({
    book: id,
    a: american,
    b: 0,
  }));
}

function propFromLabel(label: string, fight: MarketFight, prices: Record<number, number>): PropLine[] {
  const ko = label.match(/^(.*) wins by TKO\/KO$/i);
  const sub = label.match(/^(.*) wins by submission$/i);
  const dec = label.match(/^(.*) wins by decision$/i);
  if (ko || sub || dec) {
    const who = (ko ?? sub ?? dec)![1].trim();
    const kind = ko ? "ko" : sub ? "sub" : "dec";
    const side = lastName(who) === lastName(fight.a) ? "a" : lastName(who) === lastName(fight.b) ? "b" : "";
    if (!side) return [];
    const pretty = kind === "ko" ? "KO/TKO" : kind === "sub" ? "submission" : "decision";
    return propsFor(`${who} ${pretty}`, `${side}:${kind}`, prices);
  }
  if (/^fight goes to decision$/i.test(label)) return propsFor("Fight goes to decision", "distance", prices);
  if (/^fight doesn't go to decision$/i.test(label)) return propsFor("Fight doesn't go to decision", "inside", prices);
  return [];
}

export function mergeMarkets(primary: MarketFight[], extra: MarketFight[]): MarketFight[] {
  const merged = primary.map((fight) => ({ ...fight, books: [...fight.books], props: [...fight.props] }));
  for (const fight of extra) {
    const host = merged.find((item) => sameBout(item, fight));
    if (!host) {
      merged.push(fight);
      continue;
    }
    const flipped = normName(host.a) !== normName(fight.a);
    for (const line of fight.books) {
      if (host.books.some((book) => book.book === line.book)) continue;
      host.books.push(flipped ? { book: line.book, a: line.b, b: line.a } : line);
    }
    for (const prop of fight.props) {
      const key = flipped ? flipKey(prop.key) : prop.key;
      const next = { ...prop, key };
      const existing = host.props.find((item) => item.key === key && item.book === next.book);
      if (!existing) host.props.push(next);
      else if (next.decimal > existing.decimal) Object.assign(existing, next);
    }
  }
  return merged;
}

function flipKey(key: string): string {
  if (key.startsWith("a:")) return `b:${key.slice(2)}`;
  if (key.startsWith("b:")) return `a:${key.slice(2)}`;
  return key;
}

function sameBout(left: MarketFight, right: MarketFight): boolean {
  const a = normName(left.a);
  const b = normName(left.b);
  const c = normName(right.a);
  const d = normName(right.b);
  return (a === c && b === d) || (a === d && b === c);
}

export function orientFight(fights: MarketFight[], a: string, b: string): MarketFight | null {
  const na = normName(a);
  const nb = normName(b);
  const fight = fights.find((item) => sameBout(item, { a, b, books: [], props: [] }));
  if (!fight) return null;
  if (normName(fight.a) === na && normName(fight.b) === nb) return fight;
  return {
    a,
    b,
    books: fight.books.map((line) => ({ book: line.book, a: line.b, b: line.a })),
    props: fight.props.map((prop) => ({ ...prop, key: flipKey(prop.key) })),
  };
}

export function gradeBout(
  prediction: Prediction | undefined,
  fight: MarketFight | null,
  book: string,
): Grade | null {
  if (!fight) return null;
  const line = fight.books.find((item) => item.book === book);
  const a = line && line.a > 1 ? line.a : null;
  const b = line && line.b > 1 ? line.b : null;
  const fairPair = a != null && b != null ? fair(a, b) : null;
  const noVigA = fairPair ? fairPair[0] : null;
  const pA = prediction && !prediction.missing ? prediction.pA : null;
  const evA = pA != null && a != null ? pA * a - 1 : null;
  const evB = pA != null && b != null ? (1 - pA) * b - 1 : null;
  const picks: ValuePick[] = [];
  if (pA != null && a != null && evA != null && evA >= ML_EV) {
    picks.push({
      label: prediction!.aName,
      book,
      american: toAmerican(a),
      ev: evA,
      model: pA,
      market: noVigA,
      kind: "Moneyline",
    });
  }
  if (pA != null && b != null && evB != null && evB >= ML_EV) {
    picks.push({
      label: prediction!.bName,
      book,
      american: toAmerican(b),
      ev: evB,
      model: 1 - pA,
      market: noVigA == null ? null : 1 - noVigA,
      kind: "Moneyline",
    });
  }
  if (prediction && !prediction.missing) {
    for (const prop of fight.props) {
      if (prop.book !== book) continue;
      const model = outcomeProb(prediction, prop.key);
      if (model == null || model < 0.08) continue;
      const implied = 1 / prop.decimal;
      if (model < 0.1 || model > implied * 2) continue;
      const ev = model * prop.decimal - 1;
      if (ev < PROP_EV || ev > 0.45) continue;
      picks.push({
        label: prop.label,
        book: prop.book,
        american: prop.american,
        ev,
        model,
        market: null,
        kind: "Prop",
      });
    }
  }
  picks.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "Moneyline" ? -1 : 1;
    return right.ev - left.ev;
  });
  let pass: string | null = null;
  if (pA != null && a != null && b != null && picks.every((pick) => pick.kind !== "Moneyline")) {
    const preferA = pA >= 0.5;
    const ev = preferA ? evA : evB;
    const price = preferA ? a : b;
    const name = preferA ? prediction!.aName : prediction!.bName;
    if (ev != null && ev <= -0.04) {
      pass = `${name.split(" ").slice(-1)} is the model side, but ${formatAmerican(toAmerican(price))} at ${book} is too short. Pass.`;
    }
  }
  return { book, a, b, noVigA, evA, evB, picks, pass };
}

function outcomeProb(prediction: Prediction, key: string): number | null {
  if (key === "distance") return prediction.rounds.find((row) => row.label === "Decision")?.pct ?? null;
  if (key === "inside") {
    const decision = prediction.rounds.find((row) => row.label === "Decision")?.pct;
    return decision == null ? null : 1 - decision;
  }
  const [side, kind] = key.split(":");
  const name = side === "a" ? prediction.aName : prediction.bName;
  const last = name.split(" ").slice(-1)[0] ?? name;
  const tag = kind === "ko" ? "KO/TKO" : kind === "sub" ? "submission" : "decision";
  return prediction.methods.find((row) => row.label === `${last} ${tag}`)?.pct ?? null;
}
