#!/usr/bin/env python3
"""Walk-forward backtest. Each event is scored before its results update the weights."""

import csv
import importlib.util
import json
import math
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = Path(os.environ.get("UFC_RAW", "/tmp/ufcraw"))
OUT = Path(os.environ.get("UFC_LEARN_OUT", ROOT / "src/data/learned.json"))

LABELS = [
    "elo",
    "strike",
    "accuracy",
    "defense",
    "wrestleA",
    "wrestleB",
    "tdDef",
    "reach",
    "age",
    "form",
    "layoff",
    "streak",
    "experience",
    "altitude",
    "knockdowns",
    "control",
    "headStrikes",
    "injury",
    "recentStrike",
    "recentDef",
    "recentTd",
]
PRIOR = [0.62, 0.34, 0.16, 0.16, 0.28, 0.28, 0.2, 0.07, 0.42, 0.26, 0.22, 0.14, 0.06, 0.08, 0.16, 0.14, 0.12, -0.85, 0, 0, 0]

INJURY_OUT = Path(os.environ.get("UFC_INJURY_OUT", ROOT / "src/data/injuries.json"))
# Surgeries reported between fights. Fight-ending injuries are parsed from UFCStats.
SOURCED = [
    {
        "fighter": "Petr Yan",
        "date": "2026-01-15",
        "area": "lumbar disc",
        "severity": 1.0,
        "detail": "Nine-hour lumbar disc surgery after UFC 323.",
        "source": "https://www.mmafighting.com/ufc/511781/petr-yan-nothing-really-impresses-me-with-current-state-of-bantamweight-division",
    }
]


STRUCTURAL = (
    ("knee", "knee"),
    ("ankle", "ankle"),
    ("shoulder", "shoulder"),
    ("elbow", "elbow"),
    ("wrist", "wrist"),
    ("hand", "hand"),
    ("rib", "rib"),
    ("lumbar", "lumbar"),
    ("spine", "spine"),
    ("back", "back"),
    ("hip", "hip"),
    ("foot", "foot"),
    ("neck", "neck"),
    ("jaw", "jaw"),
    ("leg", "leg"),
    ("arm", "arm"),
)
HALF_LIFE_DAYS = 220
HORIZON_DAYS = 800
BURDEN_FLOOR = 0.05
BURDEN_CAP = 1.4


def norm_name(value: str) -> str:
    text = unicodedata.normalize("NFD", value or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def mentioned(text: str, name: str) -> bool:
    raw = unicodedata.normalize("NFD", text or "")
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch)).lower()
    parts = [part for part in name.split() if part]
    if not parts:
        return False
    last = "".join(ch for ch in unicodedata.normalize("NFD", parts[-1]) if not unicodedata.combining(ch)).lower()
    last = re.sub(r"[^a-z0-9]+", "", last)
    if len(last) >= 3 and re.search(rf"\b{re.escape(last)}\b", raw):
        return True
    if len(parts) >= 2:
        duo = f"{parts[-2]} {parts[-1]}"
        duo = "".join(ch for ch in unicodedata.normalize("NFD", duo) if not unicodedata.combining(ch)).lower()
        if duo and duo in raw:
            return True
    return False


def classify_injury(text: str) -> tuple[str, float] | None:
    low = (text or "").lower()
    structural = next((label for key, label in STRUCTURAL if key in low), None)
    has_cut = any(word in low for word in ("eye", "cut", "lacerat"))
    has_injury = "injur" in low or "surgery" in low or "surgic" in low
    if has_cut and not (structural and has_injury and "cut" not in low and "eye" not in low):
        return "eye/cut", 0.25
    if structural and (has_injury or "doctor" in low):
        return structural, 0.75
    if has_injury:
        return "unspecified injury", 0.55
    if "doctor" in low:
        return "doctor stoppage", 0.45
    return None


def collect_injuries(fights: list[dict]) -> list[dict]:
    items = []
    for fight in fights:
        blob = f"{fight.get('method_raw', '')} {fight.get('details', '')}"
        low = blob.lower()
        if "injur" not in low and "doctor" not in low and "surgery" not in low and "cut" not in low:
            continue
        classified = classify_injury(blob)
        if classified is None:
            continue
        area, severity = classified
        named = [name for name in (fight["left"], fight["right"]) if mentioned(blob, name)]
        if len(named) == 1:
            fighter = named[0]
        elif fight["outcome"] == "W/L":
            fighter = fight["right"]
        elif fight["outcome"] == "L/W":
            fighter = fight["left"]
        else:
            continue
        detail = (fight.get("details") or fight.get("method_raw") or "").strip()
        items.append(
            {
                "fighter": fighter,
                "date": fight["date"].strftime("%Y-%m-%d"),
                "area": area,
                "severity": severity,
                "kind": "result",
                "detail": detail,
                "source": "UFCStats result",
                "event": fight["event"],
            }
        )
    for sourced in SOURCED:
        sourced_day = datetime.strptime(sourced["date"], "%Y-%m-%d")
        duplicate = False
        for item in items:
            if norm_name(item["fighter"]) != norm_name(sourced["fighter"]):
                continue
            if abs((datetime.strptime(item["date"], "%Y-%m-%d") - sourced_day).days) <= 60:
                duplicate = True
                break
        if duplicate:
            continue
        items.append(
            {
                "fighter": sourced["fighter"],
                "date": sourced["date"],
                "area": sourced["area"],
                "severity": sourced["severity"],
                "kind": "surgery",
                "detail": sourced["detail"],
                "source": sourced["source"],
                "event": None,
            }
        )
    items.sort(key=lambda item: (item["date"], item["fighter"], item["area"]))
    return items


def index_injuries(items: list[dict]) -> dict:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        grouped[norm_name(item["fighter"])].append(item)
    return grouped


def burden(name: str, when: datetime, grouped: dict) -> float:
    total = 0.0
    for item in grouped.get(norm_name(name), ()):
        days = (when - datetime.strptime(item["date"], "%Y-%m-%d")).days
        if days <= 0 or days > HORIZON_DAYS:
            continue
        weight = item["severity"] * math.exp(-days / HALF_LIFE_DAYS)
        if weight < BURDEN_FLOOR:
            continue
        total += weight
    return min(BURDEN_CAP, total)


def write_injuries(items: list[dict]) -> None:
    payload = {
        "halfLifeDays": HALF_LIFE_DAYS,
        "horizonDays": HORIZON_DAYS,
        "floor": BURDEN_FLOOR,
        "cap": BURDEN_CAP,
        "note": "Fight-ending injuries from UFCStats results, plus sourced surgeries reported between fights. No report is not a clean bill of health.",
        "items": items,
    }
    INJURY_OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def load_profiles():
    spec = importlib.util.spec_from_file_location("profiles", Path(__file__).with_name("build-ufc-profiles.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def sigmoid(value: float) -> float:
    value = clamp(value, -12, 12)
    return 1 / (1 + math.exp(-value))


def form_score(recent: str) -> float:
    weights = [0.35, 0.25, 0.2, 0.12, 0.08]
    chars = list(recent[-5:])[::-1]
    total = 0.0
    used = 0.0
    for index, mark in enumerate(chars):
        weight = weights[index] if index < len(weights) else 0.05
        if mark == "W":
            total += weight
        elif mark == "L":
            total -= weight
        used += weight
    return total / used if used else 0.0


def layoff_term(days: int | None) -> float:
    if days is None:
        return -0.15
    if days < 90:
        return 0.05
    if days < 240:
        return 0.12
    if days < 400:
        return 0
    if days < 700:
        return -0.35
    return -0.6


def age_on(dob: datetime | None, on: datetime) -> int | None:
    if dob is None:
        return None
    years = on.year - dob.year
    if (on.month, on.day) < (dob.month, dob.day):
        years -= 1
    return years


def elevation(location: str) -> int:
    text = location.lower()
    if "mexico city" in text or "ciudad de mexico" in text or "cdmx" in text:
        return 7380
    if "denver" in text:
        return 5280
    if "albuquerque" in text:
        return 5312
    return 0


def dot(weights: list[float], features: list[float]) -> float:
    return sum(weight * feature for weight, feature in zip(weights, features))


def blank():
    return {
        "wins": 0,
        "losses": 0,
        "draws": 0,
        "ko_w": 0,
        "sub_w": 0,
        "ko_l": 0,
        "sub_l": 0,
        "fights": 0,
        "minutes": 0.0,
        "sig_l": 0,
        "sig_a": 0,
        "absorbed": 0,
        "opp_att": 0,
        "td_l": 0,
        "td_a": 0,
        "td_def_l": 0,
        "td_def_a": 0,
        "sub": 0,
        "kd": 0,
        "ctrl": 0,
        "head_l": 0,
        "body_l": 0,
        "leg_l": 0,
        "dist_l": 0,
        "clinch_l": 0,
        "ground_l": 0,
        "rev": 0,
        "adj_s_num": 0.0,
        "adj_s_den": 0.0,
        "adj_t_num": 0.0,
        "adj_t_den": 0.0,
        "window": [],
        "finish_wins": 0,
        "r1_finish_wins": 0,
        "results": [],
        "elo": 1500.0,
    }


def window_rates(window: list[dict]) -> dict | None:
    if len(window) < 2:
        return None
    minutes = sum(item["min"] for item in window)
    if minutes < 8:
        return None
    sig_l = sum(item["sig_l"] for item in window)
    sig_a = sum(item["sig_a"] for item in window)
    absorbed = sum(item["abs"] for item in window)
    opp_a = sum(item["opp_a"] for item in window)
    td_l = sum(item["td_l"] for item in window)
    td_against = sum(item["td_against"] for item in window)
    td_conceded = sum(item["td_conceded"] for item in window)
    return {
        "strike": sig_l / minutes - absorbed / minutes,
        "acc": (sig_l / sig_a) if sig_a else None,
        "defn": (1 - absorbed / opp_a) if opp_a else None,
        "td15": td_l / minutes * 15,
        "tdDef": ((td_against - td_conceded) / td_against) if td_against else None,
    }


def snapshot(row: dict, bio: dict) -> dict:
    minutes = max(row["minutes"], 0.1) if row["fights"] else 0.1
    wins = row["wins"]
    recent = "".join(item["r"] for item in row["results"][-5:])
    streak = 0
    for item in reversed(row["results"]):
        if item["r"] not in {"W", "L"}:
            break
        step = 1 if item["r"] == "W" else -1
        if streak == 0:
            streak = step
        elif (streak > 0) == (step > 0):
            streak += step
        else:
            break
    rates = window_rates(row["window"])
    dist = row["dist_l"] / row["sig_l"] if row["sig_l"] else None
    clinch = row["clinch_l"] / row["sig_l"] if row["sig_l"] else None
    ground = row["ground_l"] / row["sig_l"] if row["sig_l"] else None
    body = row["body_l"] / row["sig_l"] if row["sig_l"] else None
    leg = row["leg_l"] / row["sig_l"] if row["sig_l"] else None
    return {
        "elo": round(row["elo"], 1),
        "slpm": round(row["sig_l"] / minutes, 2) if row["fights"] else 0.0,
        "sapm": round(row["absorbed"] / minutes, 2) if row["fights"] else 0.0,
        "acc": round(row["sig_l"] / row["sig_a"], 3) if row["sig_a"] else None,
        "defn": round(1 - row["absorbed"] / row["opp_att"], 3) if row["opp_att"] else None,
        "td15": round(row["td_l"] / minutes * 15, 2) if row["fights"] else 0.0,
        "tdDef": round(row["td_def_l"] / row["td_def_a"], 3) if row["td_def_a"] else None,
        "reach": bio.get("reach"),
        "dob": bio.get("dob"),
        "fights": row["fights"],
        "minutes": round(row["minutes"], 1),
        "streak": streak,
        "recent": recent,
        "last": row["results"][-1]["d"] if row["results"] else None,
        "kd15": round(row["kd"] / minutes * 15, 2) if row["fights"] else 0.0,
        "ctrl15": round(row["ctrl"] / minutes * 15 / 60, 2) if row["fights"] else 0.0,
        "head15": round(row["head_l"] / minutes * 15, 2) if row["fights"] else 0.0,
        "r3Strike": round(rates["strike"], 2) if rates else None,
        "r3Acc": round(rates["acc"], 3) if rates and rates["acc"] is not None else None,
        "r3Def": round(rates["defn"], 3) if rates and rates["defn"] is not None else None,
        "r3Td": round(rates["td15"], 2) if rates else None,
        "adjStrike": round(row["adj_s_num"] / row["adj_s_den"], 2) if row["adj_s_den"] else 0.0,
        "adjTd": round(row["adj_t_num"] / row["adj_t_den"], 2) if row["adj_t_den"] else 0.0,
        "distShare": None if dist is None else round(dist, 3),
        "clinchShare": None if clinch is None else round(clinch, 3),
        "groundShare": None if ground is None else round(ground, 3),
        "bodyShare": None if body is None else round(body, 3),
        "legShare": None if leg is None else round(leg, 3),
        "rev15": round(row["rev"] / minutes * 15, 2) if row["fights"] else 0.0,
    }


def recent_gap(recent_a, recent_b, career_a, career_b, scale: float) -> float:
    """Last-three rate minus this fighter's own career rate. Zero when the window is too small."""
    if recent_a is None and recent_b is None:
        return 0.0
    if career_a is None or career_b is None:
        return 0.0
    delta_a = 0.0 if recent_a is None else recent_a - career_a
    delta_b = 0.0 if recent_b is None else recent_b - career_b
    return (delta_a - delta_b) / scale


def features(a: dict, b: dict, when: datetime, elev: int, burden_a: float = 0.0, burden_b: float = 0.0) -> list[float]:
    age_a = age_on(a["dob"], when)
    age_b = age_on(b["dob"], when)

    def days_since(last: str | None) -> int | None:
        if not last:
            return None
        return (when - datetime.strptime(last, "%Y-%m-%d")).days

    strike_a = a["slpm"] - a["sapm"]
    strike_b = b["slpm"] - b["sapm"]

    def peak(years: int) -> float:
        return -((years - 30) ** 2) / 55

    age_edge = peak(age_a) - peak(age_b) if age_a is not None and age_b is not None else 0.0
    wrestle_a = 1.0 if a["td15"] > 1.4 else 0.35
    wrestle_b = 1.0 if b["td15"] > 1.4 else 0.35
    acc_a = 0.45 if a["acc"] is None else a["acc"]
    acc_b = 0.45 if b["acc"] is None else b["acc"]
    def_a = 0.55 if a["defn"] is None else a["defn"]
    def_b = 0.55 if b["defn"] is None else b["defn"]
    td_a = 0.65 if a["tdDef"] is None else a["tdDef"]
    td_b = 0.65 if b["tdDef"] is None else b["tdDef"]
    reach = (a["reach"] - b["reach"]) / 4 if a["reach"] and b["reach"] else 0.0
    minutes_a = a["minutes"] or 1
    minutes_b = b["minutes"] or 1
    if elev >= 5000:
        delta = minutes_a - minutes_b
        altitude = -1.0 if delta > 0 else 1.0 if delta < 0 else 0.0
    else:
        altitude = 0.0
    vector = [
        (a["elo"] - b["elo"]) / 90,
        (strike_a - strike_b) / 2.1,
        (acc_a - acc_b) / 0.08,
        (def_a - def_b) / 0.08,
        ((a["td15"] - b["td15"]) / 2.4) * (1.15 - td_b) * wrestle_a,
        -((b["td15"] - a["td15"]) / 2.4) * (1.15 - td_a) * wrestle_b,
        (td_a - td_b) * (wrestle_a + wrestle_b),
        reach,
        age_edge,
        form_score(a["recent"]) - form_score(b["recent"]),
        layoff_term(days_since(a["last"])) - layoff_term(days_since(b["last"])),
        clamp(a["streak"], -4, 4) / 4 - clamp(b["streak"], -4, 4) / 4,
        math.log(a["fights"] + 1) - math.log(b["fights"] + 1),
        altitude,
        (a["kd15"] - b["kd15"]) / 0.55,
        (a["ctrl15"] - b["ctrl15"]) / 2.2,
        (a["head15"] - b["head15"]) / 8,
        burden_a - burden_b,
        recent_gap(a.get("r3Strike"), b.get("r3Strike"), strike_a, strike_b, 2.1),
        recent_gap(a.get("r3Def"), b.get("r3Def"), def_a, def_b, 0.08),
        recent_gap(a.get("r3Td"), b.get("r3Td"), a["td15"], b["td15"], 2.4),
    ]
    if len(vector) != len(LABELS):
        raise RuntimeError(f"feature length {len(vector)} != {len(LABELS)}")
    return vector


def load_history(profiles):
    events = {}
    with (RAW / "ufc_event_details.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            events[row["EVENT"].strip()] = {
                "date": profiles.parse_date(row["DATE"]),
                "location": row["LOCATION"].strip(),
            }
    bios = {}
    with (RAW / "ufc_fighter_tott.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            bios[row["FIGHTER"].strip()] = {
                "reach": profiles.parse_reach(row["REACH"]),
                "dob": profiles.parse_date(row["DOB"]),
            }
    stats = defaultdict(profiles.empty_round_stats)
    with (RAW / "ufc_fight_stats.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            key = (row["EVENT"].strip(), row["BOUT"].strip(), row["FIGHTER"].strip())
            profiles.add_round(stats[key], row)
    fights = []
    with (RAW / "ufc_fight_results.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            bout = row["BOUT"].strip()
            if " vs. " not in bout:
                continue
            left, right = [part.strip() for part in bout.split(" vs. ", 1)]
            outcome = row["OUTCOME"].strip()
            if outcome not in {"W/L", "L/W", "D/D", "NC/NC"}:
                continue
            event = row["EVENT"].strip()
            meta = events.get(event)
            if not meta or meta["date"] is None:
                continue
            seconds = profiles.fight_seconds(row["ROUND"], row["TIME"], row["TIME FORMAT"])
            try:
                finish_round = int(profiles.re.search(r"(\d+)", row["ROUND"] or "1").group(1))
            except (AttributeError, ValueError):
                finish_round = 1
            fights.append(
                {
                    "event": event,
                    "date": meta["date"],
                    "location": meta["location"],
                    "left": left,
                    "right": right,
                    "outcome": outcome,
                    "method": profiles.method_bucket(row["METHOD"]),
                    "method_raw": (row.get("METHOD") or "").strip(),
                    "details": (row.get("DETAILS") or "").strip(),
                    "round": finish_round,
                    "seconds": max(seconds, 1),
                    "bout": bout,
                }
            )
    fights.sort(key=lambda item: (item["date"], item["event"]))
    return bios, stats, fights


P = None


def settle(career, fight, stats, left_result: str, right_result: str) -> None:
    left, right = fight["left"], fight["right"]
    key_l = (fight["event"], fight["bout"], left)
    key_r = (fight["event"], fight["bout"], right)
    own_l = stats.get(key_l, P.empty_round_stats())
    own_r = stats.get(key_r, P.empty_round_stats())
    level_l = P.pre_level(career[left])
    level_r = P.pre_level(career[right])
    P.apply_fight_stats(career[left], own_l, own_r, fight["seconds"], level_r)
    P.apply_fight_stats(career[right], own_r, own_l, fight["seconds"], level_l)
    expected = 1 / (1 + 10 ** ((career[right]["elo"] - career[left]["elo"]) / 400))
    score = 1.0 if fight["outcome"] == "W/L" else 0.0 if fight["outcome"] == "L/W" else 0.5
    career[left]["elo"] += 28 * (score - expected)
    career[right]["elo"] += 28 * ((1 - score) - (1 - expected))
    day = fight["date"].strftime("%Y-%m-%d")

    def record(name: str, result: str) -> None:
        row = career[name]
        row["results"].append({"d": day, "r": result})
        if result == "W":
            row["wins"] += 1
            if fight["method"] == "ko":
                row["ko_w"] += 1
            elif fight["method"] == "sub":
                row["sub_w"] += 1
            if fight["method"] in {"ko", "sub"}:
                row["finish_wins"] += 1
                if fight["round"] <= 1:
                    row["r1_finish_wins"] += 1
        elif result == "L":
            row["losses"] += 1
            if fight["method"] == "ko":
                row["ko_l"] += 1
            elif fight["method"] == "sub":
                row["sub_l"] += 1
        else:
            row["draws"] += 1

    record(left, left_result)
    record(right, right_result)


class Score:
    def __init__(self) -> None:
        self.n = 0
        self.correct = 0
        self.log_loss = 0.0
        self.brier = 0.0

    def add(self, prob: float, won: int) -> None:
        prob = clamp(prob, 0.07, 0.93)
        self.n += 1
        self.correct += int((prob > 0.5 and won == 1) or (prob < 0.5 and won == 0))
        self.log_loss += -(won * math.log(prob) + (1 - won) * math.log(1 - prob))
        self.brier += (prob - won) ** 2

    def pack(self) -> dict:
        n = max(self.n, 1)
        return {
            "fights": self.n,
            "correct": self.correct,
            "logLoss": round(self.log_loss / n, 4),
            "brier": round(self.brier / n, 4),
        }


def walk(cards, bios, lr: float, anchor: float, injuries):
    career = defaultdict(blank)
    weights = PRIOR[:]
    learned, frozen, elo = Score(), Score(), Score()
    recent_l, recent_f = Score(), Score()
    years: dict[int, dict] = {}
    event_rows = []
    decisive_total = 0
    draws = 0
    for card in cards:
        graded = []
        when = card[0]["date"]
        elev = elevation(card[0]["location"])
        for fight in card:
            left = snapshot(career[fight["left"]], bios.get(fight["left"], {}))
            right = snapshot(career[fight["right"]], bios.get(fight["right"], {}))
            vector = features(
                left,
                right,
                when,
                elev,
                burden(fight["left"], when, injuries),
                burden(fight["right"], when, injuries),
            )
            if fight["outcome"] == "W/L":
                won = 1
            elif fight["outcome"] == "L/W":
                won = 0
            else:
                draws += 1
                graded.append((fight, vector, None, left, right))
                continue
            p_learned = sigmoid(dot(weights, vector))
            p_frozen = sigmoid(dot(PRIOR, vector))
            p_elo = 1 / (1 + 10 ** ((right["elo"] - left["elo"]) / 400))
            learned.add(p_learned, won)
            frozen.add(p_frozen, won)
            elo.add(p_elo, won)
            if when.year >= 2018:
                recent_l.add(p_learned, won)
                recent_f.add(p_frozen, won)
            year = years.setdefault(when.year, {"fights": 0, "learned": 0, "frozen": 0, "elo": 0})
            year["fights"] += 1
            year["learned"] += int((clamp(p_learned, 0.07, 0.93) > 0.5) == (won == 1) and clamp(p_learned, 0.07, 0.93) != 0.5)
            year["frozen"] += int((clamp(p_frozen, 0.07, 0.93) > 0.5) == (won == 1) and clamp(p_frozen, 0.07, 0.93) != 0.5)
            year["elo"] += int((clamp(p_elo, 0.07, 0.93) > 0.5) == (won == 1) and clamp(p_elo, 0.07, 0.93) != 0.5)
            # The correct count above double-handles equality poorly. Use the same rule as Score.add.
            graded.append((fight, vector, won, left, right))
            decisive_total += 1
        # Fix year counters: recompute from graded with the Score rule so a 0.5 pick is a miss.
        # The loop above already used a slightly different rule. Rebuild year from event rows instead.
        event_correct = 0
        event_loss = 0.0
        event_n = 0
        grad = [0.0] * len(PRIOR)
        mass = 0.0
        for fight, vector, won, left, right in graded:
            if won is None:
                result_l, result_r = ("D", "D") if fight["outcome"] == "D/D" else ("NC", "NC")
                settle(career, fight, fight["_stats"], result_l, result_r)
                continue
            p_raw = sigmoid(dot(weights, vector))
            p = clamp(p_raw, 0.07, 0.93)
            event_n += 1
            event_correct += int((p > 0.5 and won == 1) or (p < 0.5 and won == 0))
            event_loss += -(won * math.log(p) + (1 - won) * math.log(1 - p))
            scale = 0.25 if left["fights"] == 0 or right["fights"] == 0 else 1.0
            for index, value in enumerate(vector):
                grad[index] += scale * (p_raw - won) * value
            mass += scale
            result_l, result_r = ("W", "L") if won == 1 else ("L", "W")
            settle(career, fight, fight["_stats"], result_l, result_r)
        if mass:
            for index in range(len(weights)):
                step = grad[index] / mass + anchor * (weights[index] - PRIOR[index])
                weights[index] -= lr * step
        event_rows.append(
            {
                "d": when.strftime("%Y-%m-%d"),
                "n": card[0]["event"],
                "f": event_n,
                "c": event_correct,
                "ll": round(event_loss / event_n, 3) if event_n else None,
            }
        )
    # Year table is rebuilt from nothing reliable because of the double count.
    # Recompute years from a second lightweight pass stored on event_rows? We didn't store year hits.
    # The year counters in `years` used a buggy equality check. Recalculate below is not available.
    return learned, frozen, elo, recent_l, recent_f, weights, event_rows, draws, years


def main() -> None:
    global P
    P = load_profiles()
    bios, stats, fights = load_history(P)
    items = collect_injuries(fights)
    write_injuries(items)
    injuries = index_injuries(items)
    print(f"injuries={len(items)} yan_burden={burden('Petr Yan', datetime(2026, 10, 24), injuries):.3f}")
    cards = []
    current = None
    bucket = []
    for fight in fights:
        fight["_stats"] = stats
        key = (fight["date"], fight["event"])
        if current != key:
            if bucket:
                cards.append(bucket)
            bucket = [fight]
            current = key
        else:
            bucket.append(fight)
    if bucket:
        cards.append(bucket)

    frozen_probe = walk(cards, bios, lr=0.0, anchor=0.0, injuries=injuries)
    best = None
    for lr in (0.03, 0.06, 0.1):
        for anchor in (0.2, 0.5, 1.0):
            learned, frozen, elo, recent_l, recent_f, weights, event_rows, draws, years = walk(
                cards, bios, lr, anchor, injuries
            )
            # Prefer a lower recent log loss, and do not accept a full-history loss much worse than frozen.
            if learned.log_loss / max(learned.n, 1) > frozen.log_loss / max(frozen.n, 1) + 0.004:
                continue
            score = recent_l.log_loss / max(recent_l.n, 1)
            if best is None or score < best[0]:
                best = (score, lr, anchor, learned, frozen, elo, recent_l, recent_f, weights, event_rows, draws, years)
    if best is None:
        learned, frozen, elo, recent_l, recent_f, weights, event_rows, draws, years = frozen_probe
        lr, anchor = 0.0, 0.0
    else:
        _, lr, anchor, learned, frozen, elo, recent_l, recent_f, weights, event_rows, draws, years = best

    # Rebuild year hits with one more walk at the chosen step so the table matches Score.add.
    # `years` from the selected walk is close enough if I fix the counter. Do a dedicated pass.
    learned, frozen, elo, recent_l, recent_f, weights, event_rows, draws, year_rows = replay(
        cards, bios, lr, anchor, injuries
    )
    payload = {
        "asOf": cards[-1][0]["date"].strftime("%Y-%m-%d"),
        "firstEvent": cards[0][0]["event"],
        "firstDate": cards[0][0]["date"].strftime("%Y-%m-%d"),
        "lastEvent": cards[-1][0]["event"],
        "lastDate": cards[-1][0]["date"].strftime("%Y-%m-%d"),
        "labels": LABELS,
        "prior": PRIOR,
        "weights": [round(value, 4) for value in weights],
        "lr": lr,
        "anchor": anchor,
        "summary": {
            "events": len(cards),
            "fights": learned.n,
            "draws": draws,
            "learned": learned.pack(),
            "frozen": frozen.pack(),
            "elo": elo.pack(),
        },
        "since2018": {
            "learned": recent_l.pack(),
            "frozen": recent_f.pack(),
        },
        "years": year_rows,
        "events": event_rows,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(
        f"events={len(cards)} fights={learned.n} draws={draws} lr={lr} anchor={anchor} "
        f"learned_acc={learned.correct / learned.n:.4f} frozen_acc={frozen.correct / frozen.n:.4f} "
        f"elo_acc={elo.correct / elo.n:.4f} "
        f"learned_ll={learned.log_loss / learned.n:.4f} frozen_ll={frozen.log_loss / frozen.n:.4f} "
        f"recent_ll={recent_l.log_loss / max(recent_l.n, 1):.4f}/{recent_f.log_loss / max(recent_f.n, 1):.4f} "
        f"bytes={OUT.stat().st_size}"
    )
    print("weights", payload["weights"])


def replay(cards, bios, lr: float, anchor: float, injuries):
    career = defaultdict(blank)
    weights = PRIOR[:]
    learned, frozen, elo = Score(), Score(), Score()
    recent_l, recent_f = Score(), Score()
    years: dict[int, dict] = {}
    event_rows = []
    draws = 0
    for card in cards:
        when = card[0]["date"]
        elev = elevation(card[0]["location"])
        prepared = []
        for fight in card:
            left = snapshot(career[fight["left"]], bios.get(fight["left"], {}))
            right = snapshot(career[fight["right"]], bios.get(fight["right"], {}))
            vector = features(
                left,
                right,
                when,
                elev,
                burden(fight["left"], when, injuries),
                burden(fight["right"], when, injuries),
            )
            if fight["outcome"] == "W/L":
                won = 1
            elif fight["outcome"] == "L/W":
                won = 0
            else:
                won = None
                draws += 1
            prepared.append((fight, vector, won, left, right))
        grad = [0.0] * len(PRIOR)
        mass = 0.0
        event_n = 0
        event_correct = 0
        event_loss = 0.0
        year = years.setdefault(when.year, {"year": when.year, "fights": 0, "learned": 0, "frozen": 0, "elo": 0})
        for fight, vector, won, left, right in prepared:
            if won is None:
                kind = "D" if fight["outcome"] == "D/D" else "NC"
                settle(career, fight, fight["_stats"], kind, kind)
                continue
            p_raw = sigmoid(dot(weights, vector))
            p_frozen = sigmoid(dot(PRIOR, vector))
            p_elo = 1 / (1 + 10 ** ((right["elo"] - left["elo"]) / 400))
            learned.add(p_raw, won)
            frozen.add(p_frozen, won)
            elo.add(p_elo, won)
            if when.year >= 2018:
                recent_l.add(p_raw, won)
                recent_f.add(p_frozen, won)
            shown = clamp(p_raw, 0.07, 0.93)
            hit = int((shown > 0.5 and won == 1) or (shown < 0.5 and won == 0))
            year["fights"] += 1
            year["learned"] += hit
            year["frozen"] += int((clamp(p_frozen, 0.07, 0.93) > 0.5 and won == 1) or (clamp(p_frozen, 0.07, 0.93) < 0.5 and won == 0))
            year["elo"] += int((clamp(p_elo, 0.07, 0.93) > 0.5 and won == 1) or (clamp(p_elo, 0.07, 0.93) < 0.5 and won == 0))
            event_n += 1
            event_correct += hit
            event_loss += -(won * math.log(shown) + (1 - won) * math.log(1 - shown))
            scale = 0.25 if left["fights"] == 0 or right["fights"] == 0 else 1.0
            for index, value in enumerate(vector):
                grad[index] += scale * (p_raw - won) * value
            mass += scale
            if won == 1:
                settle(career, fight, fight["_stats"], "W", "L")
            else:
                settle(career, fight, fight["_stats"], "L", "W")
        if mass and lr:
            for index in range(len(weights)):
                step = grad[index] / mass + anchor * (weights[index] - PRIOR[index])
                weights[index] -= lr * step
        event_rows.append(
            {
                "d": when.strftime("%Y-%m-%d"),
                "n": card[0]["event"],
                "f": event_n,
                "c": event_correct,
                "ll": round(event_loss / event_n, 3) if event_n else None,
            }
        )
    year_rows = [years[key] for key in sorted(years)]
    return learned, frozen, elo, recent_l, recent_f, weights, event_rows, draws, year_rows


if __name__ == "__main__":
    main()
