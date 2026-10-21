#!/usr/bin/env python3
"""Build compact fighter profiles from the public UFCStats CSVs."""

import csv
import json
import os
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = Path(os.environ.get("UFC_RAW", "/tmp/ufcraw"))
OUT = Path(os.environ.get("UFC_OUT", ROOT / "src/data/fighters.json"))


def parse_of(value: str) -> tuple[int, int]:
    match = re.search(r"(\d+)\s+of\s+(\d+)", value or "")
    if not match:
        return 0, 0
    return int(match.group(1)), int(match.group(2))


def parse_clock(value: str) -> int:
    text = (value or "").strip()
    if not text or text in {"--", "---"}:
        return 0
    parts = text.split(":")
    if len(parts) != 2:
        return 0
    try:
        return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return 0


def parse_int(value: str) -> int:
    text = (value or "").strip()
    if not text or text in {"--", "---"}:
        return 0
    try:
        return int(text)
    except ValueError:
        return 0


def parse_height(value: str) -> float | None:
    match = re.search(r"(\d+)'\s*(\d+)", value or "")
    if not match:
        return None
    return int(match.group(1)) * 12 + int(match.group(2))


def parse_reach(value: str) -> float | None:
    text = value or ""
    if "--" in text:
        return None
    match = re.search(r"(\d+)", text)
    return float(match.group(1)) if match else None


def parse_weight(value: str) -> float | None:
    match = re.search(r"(\d+)", value or "")
    if not match or "--" in (value or ""):
        return None
    return float(match.group(1))


def parse_date(value: str) -> datetime | None:
    text = (value or "").strip().strip('"')
    for fmt in ("%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def method_bucket(method: str) -> str:
    text = (method or "").lower()
    if "ko" in text or "tko" in text:
        return "ko"
    if "sub" in text:
        return "sub"
    if "decision" in text:
        return "dec"
    return "other"


def scheduled_rounds(time_format: str) -> int:
    match = re.search(r"(\d+)\s*Rnd", time_format or "")
    return int(match.group(1)) if match else 3


def fight_seconds(rnd: str, clock: str, time_format: str) -> int:
    try:
        finish_round = int(re.search(r"(\d+)", rnd or "1").group(1))
    except (AttributeError, ValueError):
        finish_round = 1
    cap = scheduled_rounds(time_format)
    finish_round = max(1, min(finish_round, cap))
    return (finish_round - 1) * 300 + min(parse_clock(clock), 300)


FALLBACK_SAPM = 3.8
FALLBACK_TD = 1.6


def empty_round_stats() -> dict:
    return {
        "sig_l": 0,
        "sig_a": 0,
        "td_l": 0,
        "td_a": 0,
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
    }


def add_round(bucket: dict, row: dict) -> None:
    sig_l, sig_a = parse_of(row.get("SIG.STR.", ""))
    td_l, td_a = parse_of(row.get("TD", ""))
    head_l, _head_a = parse_of(row.get("HEAD", ""))
    body_l, _body_a = parse_of(row.get("BODY", ""))
    leg_l, _leg_a = parse_of(row.get("LEG", ""))
    dist_l, _dist_a = parse_of(row.get("DISTANCE", ""))
    clinch_l, _clinch_a = parse_of(row.get("CLINCH", ""))
    ground_l, _ground_a = parse_of(row.get("GROUND", ""))
    bucket["sig_l"] += sig_l
    bucket["sig_a"] += sig_a
    bucket["td_l"] += td_l
    bucket["td_a"] += td_a
    bucket["sub"] += parse_int(row.get("SUB.ATT", ""))
    bucket["kd"] += parse_int(row.get("KD", ""))
    bucket["ctrl"] += parse_clock(row.get("CTRL", ""))
    bucket["head_l"] += head_l
    bucket["body_l"] += body_l
    bucket["leg_l"] += leg_l
    bucket["dist_l"] += dist_l
    bucket["clinch_l"] += clinch_l
    bucket["ground_l"] += ground_l
    bucket["rev"] += parse_int(row.get("REV.", ""))


def pre_level(row: dict) -> dict | None:
    if row["fights"] <= 0 or row["minutes"] <= 0:
        return None
    return {
        "sapm": row["absorbed"] / row["minutes"],
        "td_allowed": (row["td_def_a"] - row["td_def_l"]) / row["minutes"] * 15,
    }


def apply_fight_stats(row: dict, own: dict, opp: dict, seconds: int, opp_level: dict | None) -> None:
    minutes = max(seconds, 1) / 60
    sapm = FALLBACK_SAPM if opp_level is None else opp_level["sapm"]
    allowed = FALLBACK_TD if opp_level is None else opp_level["td_allowed"]
    sig_l = own.get("sig_l", 0)
    td_l = own.get("td_l", 0)
    row["adj_s_num"] += sig_l - sapm * minutes
    row["adj_s_den"] += minutes
    row["adj_t_num"] += td_l * 15 - allowed * minutes
    row["adj_t_den"] += minutes
    row["window"].append(
        {
            "min": minutes,
            "sig_l": sig_l,
            "sig_a": own.get("sig_a", 0),
            "abs": opp.get("sig_l", 0),
            "opp_a": opp.get("sig_a", 0),
            "td_l": td_l,
            "td_against": opp.get("td_a", 0),
            "td_conceded": opp.get("td_l", 0),
        }
    )
    if len(row["window"]) > 3:
        row["window"] = row["window"][-3:]
    row["fights"] += 1
    row["minutes"] += minutes
    row["sig_l"] += sig_l
    row["sig_a"] += own.get("sig_a", 0)
    row["absorbed"] += opp.get("sig_l", 0)
    row["opp_att"] += opp.get("sig_a", 0)
    row["td_l"] += td_l
    row["td_a"] += own.get("td_a", 0)
    row["td_def_a"] += opp.get("td_a", 0)
    row["td_def_l"] += opp.get("td_a", 0) - opp.get("td_l", 0)
    row["sub"] += own.get("sub", 0)
    row["kd"] += own.get("kd", 0)
    row["ctrl"] += own.get("ctrl", 0)
    row["head_l"] += own.get("head_l", 0)
    row["body_l"] += own.get("body_l", 0)
    row["leg_l"] += own.get("leg_l", 0)
    row["dist_l"] += own.get("dist_l", 0)
    row["clinch_l"] += own.get("clinch_l", 0)
    row["ground_l"] += own.get("ground_l", 0)
    row["rev"] += own.get("rev", 0)


def recent_block(window: list[dict]) -> dict | None:
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


def share(part: float, whole: float) -> float | None:
    if whole <= 0:
        return None
    return part / whole


def main() -> None:
    events: dict[str, dict] = {}
    with (RAW / "ufc_event_details.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            events[row["EVENT"].strip()] = {
                "date": parse_date(row["DATE"]),
                "location": row["LOCATION"].strip(),
            }

    bios: dict[str, dict] = {}
    with (RAW / "ufc_fighter_tott.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            name = row["FIGHTER"].strip()
            bios[name] = {
                "height": parse_height(row["HEIGHT"]),
                "reach": parse_reach(row["REACH"]),
                "stance": None if row["STANCE"].strip() in {"", "--"} else row["STANCE"].strip(),
                "dob": parse_date(row["DOB"]),
                "weight": parse_weight(row["WEIGHT"]),
            }

    stats: dict[tuple[str, str, str], dict] = defaultdict(empty_round_stats)
    with (RAW / "ufc_fight_stats.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            key = (row["EVENT"].strip(), row["BOUT"].strip(), row["FIGHTER"].strip())
            add_round(stats[key], row)

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
            meta = events.get(event, {})
            when = meta.get("date")
            if when is None:
                continue
            seconds = fight_seconds(row["ROUND"], row["TIME"], row["TIME FORMAT"])
            try:
                finish_round = int(re.search(r"(\d+)", row["ROUND"] or "1").group(1))
            except (AttributeError, ValueError):
                finish_round = 1
            fights.append(
                {
                    "event": event,
                    "date": when,
                    "left": left,
                    "right": right,
                    "outcome": outcome,
                    "method": method_bucket(row["METHOD"]),
                    "round": finish_round,
                    "scheduled": scheduled_rounds(row["TIME FORMAT"]),
                    "seconds": max(seconds, 1),
                    "weight": row["WEIGHTCLASS"].strip(),
                }
            )

    fights.sort(key=lambda item: (item["date"], item["event"]))

    career: dict[str, dict] = defaultdict(
        lambda: {
            "wins": 0,
            "losses": 0,
            "draws": 0,
            "ko_w": 0,
            "sub_w": 0,
            "dec_w": 0,
            "ko_l": 0,
            "sub_l": 0,
            "dec_l": 0,
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
            "r1_finish_wins": 0,
            "late_finish_wins": 0,
            "finish_wins": 0,
            "results": [],
            "elo": 1500.0,
        }
    )

    for fight in fights:
        left, right = fight["left"], fight["right"]
        own_l = stats.get((fight["event"], f"{left} vs. {right}", left), empty_round_stats())
        own_r = stats.get((fight["event"], f"{left} vs. {right}", right), empty_round_stats())
        level_l = pre_level(career[left])
        level_r = pre_level(career[right])
        apply_fight_stats(career[left], own_l, own_r, fight["seconds"], level_r)
        apply_fight_stats(career[right], own_r, own_l, fight["seconds"], level_l)

        expected_l = 1 / (1 + 10 ** ((career[right]["elo"] - career[left]["elo"]) / 400))
        if fight["outcome"] == "W/L":
            score_l = 1.0
        elif fight["outcome"] == "L/W":
            score_l = 0.0
        else:
            score_l = 0.5
        career[left]["elo"] += 28 * (score_l - expected_l)
        career[right]["elo"] += 28 * ((1 - score_l) - (1 - expected_l))

        def record(name: str, result: str, method: str, rnd: int) -> None:
            row = career[name]
            row["results"].append({"d": fight["date"].strftime("%Y-%m-%d"), "r": result, "m": method, "rd": rnd})
            if result == "W":
                row["wins"] += 1
                if method == "ko":
                    row["ko_w"] += 1
                elif method == "sub":
                    row["sub_w"] += 1
                elif method == "dec":
                    row["dec_w"] += 1
                if method in {"ko", "sub"}:
                    row["finish_wins"] += 1
                    if rnd <= 1:
                        row["r1_finish_wins"] += 1
                    if rnd >= 3:
                        row["late_finish_wins"] += 1
            elif result == "L":
                row["losses"] += 1
                if method == "ko":
                    row["ko_l"] += 1
                elif method == "sub":
                    row["sub_l"] += 1
                elif method == "dec":
                    row["dec_l"] += 1
            else:
                row["draws"] += 1

        if fight["outcome"] == "W/L":
            record(left, "W", fight["method"], fight["round"])
            record(right, "L", fight["method"], fight["round"])
        elif fight["outcome"] == "L/W":
            record(left, "L", fight["method"], fight["round"])
            record(right, "W", fight["method"], fight["round"])
        else:
            kind = "D" if fight["outcome"] == "D/D" else "NC"
            record(left, kind, fight["method"], fight["round"])
            record(right, kind, fight["method"], fight["round"])

    profiles = []
    for name, row in career.items():
        if row["fights"] == 0:
            continue
        bio = bios.get(name, {})
        minutes = max(row["minutes"], 0.1)
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
        recent_rates = recent_block(row["window"])
        profiles.append(
            {
                "name": name,
                "height": bio.get("height"),
                "reach": bio.get("reach"),
                "stance": bio.get("stance"),
                "dob": bio["dob"].strftime("%Y-%m-%d") if bio.get("dob") else None,
                "weight": bio.get("weight"),
                "w": wins,
                "l": row["losses"],
                "d": row["draws"],
                "koW": row["ko_w"],
                "subW": row["sub_w"],
                "decW": row["dec_w"],
                "koL": row["ko_l"],
                "subL": row["sub_l"],
                "fights": row["fights"],
                "minutes": round(row["minutes"], 1),
                "slpm": round(row["sig_l"] / minutes, 2),
                "sapm": round(row["absorbed"] / minutes, 2),
                "acc": round(row["sig_l"] / row["sig_a"], 3) if row["sig_a"] else None,
                "defn": round(1 - row["absorbed"] / row["opp_att"], 3) if row["opp_att"] else None,
                "td15": round(row["td_l"] / minutes * 15, 2),
                "tdAcc": round(row["td_l"] / row["td_a"], 3) if row["td_a"] else None,
                "tdDef": round(row["td_def_l"] / row["td_def_a"], 3) if row["td_def_a"] else None,
                "sub15": round(row["sub"] / minutes * 15, 2),
                "kd15": round(row["kd"] / minutes * 15, 2),
                "ctrl15": round(row["ctrl"] / minutes * 15 / 60, 2),
                "head15": round(row["head_l"] / minutes * 15, 2),
                "r3Strike": round(recent_rates["strike"], 2) if recent_rates else None,
                "r3Acc": round(recent_rates["acc"], 3) if recent_rates and recent_rates["acc"] is not None else None,
                "r3Def": round(recent_rates["defn"], 3) if recent_rates and recent_rates["defn"] is not None else None,
                "r3Td": round(recent_rates["td15"], 2) if recent_rates else None,
                "adjStrike": round(row["adj_s_num"] / row["adj_s_den"], 2) if row["adj_s_den"] else 0.0,
                "adjTd": round(row["adj_t_num"] / row["adj_t_den"], 2) if row["adj_t_den"] else 0.0,
                "distShare": round(share(row["dist_l"], row["sig_l"]), 3) if share(row["dist_l"], row["sig_l"]) is not None else None,
                "clinchShare": round(share(row["clinch_l"], row["sig_l"]), 3) if share(row["clinch_l"], row["sig_l"]) is not None else None,
                "groundShare": round(share(row["ground_l"], row["sig_l"]), 3) if share(row["ground_l"], row["sig_l"]) is not None else None,
                "bodyShare": round(share(row["body_l"], row["sig_l"]), 3) if share(row["body_l"], row["sig_l"]) is not None else None,
                "legShare": round(share(row["leg_l"], row["sig_l"]), 3) if share(row["leg_l"], row["sig_l"]) is not None else None,
                "rev15": round(row["rev"] / minutes * 15, 2),
                "r1Fin": round(row["r1_finish_wins"] / wins, 3) if wins else 0,
                "lateFin": round(row["late_finish_wins"] / wins, 3) if wins else 0,
                "finRate": round(row["finish_wins"] / wins, 3) if wins else 0,
                "koRate": round(row["ko_w"] / wins, 3) if wins else 0,
                "subRate": round(row["sub_w"] / wins, 3) if wins else 0,
                "koVuln": round(row["ko_l"] / row["losses"], 3) if row["losses"] else 0,
                "subVuln": round(row["sub_l"] / row["losses"], 3) if row["losses"] else 0,
                "elo": round(row["elo"], 1),
                "streak": streak,
                "recent": recent,
                "last": row["results"][-1]["d"] if row["results"] else None,
            }
        )

    profiles.sort(key=lambda item: item["name"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "asOf": "2026-10-17",
        "source": "UFCStats via Greco1899/scrape_ufc_stats (public historical extract)",
        "fighters": profiles,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"fighters={len(profiles)} bytes={OUT.stat().st_size}")


if __name__ == "__main__":
    main()
