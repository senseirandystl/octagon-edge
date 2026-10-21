#!/usr/bin/env python3
"""Walk-forward gradient boosting on the same pre-fight features as the logistic.

Trees are refit at the start of each year, using only fights already settled.
The reported score is that walk-forward, not a fit on the fights it is scoring.
"""

import importlib.util
import json
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "data" / "trees.json"
LEARNED = ROOT / "src" / "data" / "learned.json"


def load_backtest():
    path = Path(__file__).with_name("backtest-ufc.py")
    spec = importlib.util.spec_from_file_location("backtest_ufc", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clamp(value: float, low: float = 0.07, high: float = 0.93) -> float:
    return max(low, min(high, value))


def collect(bt):
    bt.P = bt.load_profiles()
    bios, stats, fights = bt.load_history(bt.P)
    injuries = bt.index_injuries(bt.collect_injuries(fights))
    learned = json.loads(LEARNED.read_text(encoding="utf-8"))
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

    from collections import defaultdict

    career = defaultdict(bt.blank)
    weights = bt.PRIOR[:]
    rows = []
    logistic_correct = 0
    logistic_loss = 0.0
    for card in cards:
        when = card[0]["date"]
        elev = bt.elevation(card[0]["location"])
        prepared = []
        for fight in card:
            left = bt.snapshot(career[fight["left"]], bios.get(fight["left"], {}))
            right = bt.snapshot(career[fight["right"]], bios.get(fight["right"], {}))
            vector = bt.features(
                left,
                right,
                when,
                elev,
                bt.burden(fight["left"], when, injuries),
                bt.burden(fight["right"], when, injuries),
            )
            if fight["outcome"] == "W/L":
                won = 1
            elif fight["outcome"] == "L/W":
                won = 0
            else:
                won = None
            prepared.append((fight, vector, won, left, right))
        grad = [0.0] * len(bt.PRIOR)
        mass = 0.0
        for fight, vector, won, left, right in prepared:
            if won is None:
                kind = "D" if fight["outcome"] == "D/D" else "NC"
                bt.settle(career, fight, fight["_stats"], kind, kind)
                continue
            raw = bt.sigmoid(bt.dot(weights, vector))
            shown = clamp(raw)
            logistic_correct += int((shown > 0.5 and won == 1) or (shown < 0.5 and won == 0))
            logistic_loss += -(won * np.log(shown) + (1 - won) * np.log(1 - shown))
            rows.append({"x": vector, "y": won, "year": when.year, "p": shown})
            scale = 0.25 if left["fights"] == 0 or right["fights"] == 0 else 1.0
            for index, value in enumerate(vector):
                grad[index] += scale * (raw - won) * value
            mass += scale
            if won == 1:
                bt.settle(career, fight, fight["_stats"], "W", "L")
            else:
                bt.settle(career, fight, fight["_stats"], "L", "W")
        if mass and learned["lr"]:
            for index in range(len(weights)):
                step = grad[index] / mass + learned["anchor"] * (weights[index] - bt.PRIOR[index])
                weights[index] -= learned["lr"] * step
    return rows, logistic_correct, float(logistic_loss)


def pack(correct: int, loss: float, n: int) -> dict:
    return {"fights": int(n), "correct": int(correct), "logLoss": float(round(loss / max(n, 1), 4))}


def prior_logit(model) -> float:
    init = model.init_
    constant = getattr(init, "constant_", None)
    if constant is None:
        constant = getattr(init, "constant", None)
    if constant is not None:
        return float(np.ravel(constant)[0])
    classes = [int(value) for value in init.classes_]
    prior = float(init.class_prior_[classes.index(1)])
    prior = min(max(prior, 1e-6), 1 - 1e-6)
    return float(np.log(prior / (1 - prior)))


def walk_dumped(payload: dict, rows: np.ndarray) -> np.ndarray:
    score = np.full(len(rows), payload["init"])
    for tree in payload["trees"]:
        node = np.zeros(len(rows), dtype=int)
        for _ in range(len(tree["f"])):
            feature = np.array([tree["f"][int(item)] for item in node])
            threshold = np.array([tree["t"][int(item)] for item in node])
            left = np.array([tree["l"][int(item)] for item in node])
            right = np.array([tree["r"][int(item)] for item in node])
            leaf = left < 0
            go_left = rows[np.arange(len(rows)), np.clip(feature, 0, rows.shape[1] - 1)] <= threshold
            node = np.where(leaf, node, np.where(go_left, left, right))
        score += payload["learningRate"] * np.array([tree["v"][int(item)] for item in node])
    return score


def score_rows(probs, row_years, labels, start_year: int = 0):
    correct = loss = n = 0
    recent_c = recent_l = recent_n = 0
    for prob, year, won in zip(probs, row_years, labels):
        if int(year) < start_year:
            continue
        shown = clamp(float(prob))
        won = int(won)
        hit = int((shown > 0.5 and won == 1) or (shown < 0.5 and won == 0))
        n += 1
        correct += hit
        loss += -(won * np.log(shown) + (1 - won) * np.log(1 - shown))
        if int(year) >= 2018:
            recent_n += 1
            recent_c += hit
            recent_l += -(won * np.log(shown) + (1 - won) * np.log(1 - shown))
    return pack(correct, loss, n), pack(recent_c, recent_l, recent_n)


def dump_model(model) -> dict:
    init = prior_logit(model)
    rng = np.random.default_rng(1)
    probe = rng.normal(size=(32, model.n_features_in_))
    manual = np.full(len(probe), init)
    for estimator in model.estimators_[:, 0]:
        manual += model.learning_rate * estimator.predict(probe)
    official = model.decision_function(probe)
    gap = float(np.max(np.abs(manual - official)))
    if gap > 1e-6:
        raise SystemExit(f"tree export does not match sklearn: {gap}")
    trees = []
    for estimator in model.estimators_[:, 0]:
        tree = estimator.tree_
        trees.append(
            {
                "f": [int(value) for value in tree.feature],
                "t": [round(float(value), 6) for value in tree.threshold],
                "l": [int(value) for value in tree.children_left],
                "r": [int(value) for value in tree.children_right],
                "v": [round(float(tree.value[index][0][0]), 6) for index in range(tree.node_count)],
            }
        )
    payload = {"init": round(init, 6), "learningRate": model.learning_rate, "trees": trees}
    rounded = walk_dumped(payload, probe)
    rounded_gap = float(np.max(np.abs(rounded - official)))
    if rounded_gap > 1e-4:
        raise SystemExit(f"rounded tree export drifted: {rounded_gap}")
    return payload


def walk_forward(x, y, years, config: dict, start_year: int):
    probs = np.zeros(len(y))
    scored = np.zeros(len(y), dtype=bool)
    for year in range(int(years.min()), int(years.max()) + 1):
        train = years < year
        test = years == year
        if train.sum() < 600 or not test.any():
            continue
        model = GradientBoostingClassifier(random_state=1, **config)
        # Every feature is a side-A minus side-B gap, so the flipped card is the same fight.
        # Early UFCStats bouts are winner-first, which is only one class. The flip lets the
        # trees see both corners without using a later result.
        x_train = x[train]
        y_train = y[train]
        model.fit(np.vstack([x_train, -x_train]), np.concatenate([y_train, 1 - y_train]))
        probs[test] = 1 / (1 + np.exp(-model.decision_function(x[test])))
        scored[test] = True
    return probs, scored


def main() -> None:
    bt = load_backtest()
    rows, logistic_correct, logistic_loss = collect(bt)
    x = np.asarray([row["x"] for row in rows], dtype=float)
    y = np.asarray([row["y"] for row in rows], dtype=int)
    years = np.asarray([row["year"] for row in rows], dtype=int)
    logistic = np.asarray([row["p"] for row in rows], dtype=float)
    print(
        f"rows={len(rows)} features={x.shape[1]} "
        f"logistic={logistic_correct}/{len(rows)} ll={logistic_loss / len(rows):.4f}",
        flush=True,
    )
    configs = [
        {"n_estimators": 60, "max_depth": 2, "learning_rate": 0.06, "min_samples_leaf": 40, "subsample": 0.8},
        {"n_estimators": 80, "max_depth": 3, "learning_rate": 0.05, "min_samples_leaf": 50, "subsample": 0.8},
        {"n_estimators": 40, "max_depth": 2, "learning_rate": 0.08, "min_samples_leaf": 60, "subsample": 0.9},
    ]
    best = None
    for config in configs:
        probs, scored = walk_forward(x, y, years, config, start_year=0)
        if not scored.any():
            continue
        tree_all, tree_recent = score_rows(probs[scored], years[scored], y[scored], 0)
        log_all, log_recent = score_rows(logistic[scored], years[scored], y[scored], 0)
        print(
            f"config trees={config['n_estimators']} depth={config['max_depth']} scored={int(scored.sum())}",
            flush=True,
        )
        print(" tree", tree_all, tree_recent)
        print(" logit", log_all, log_recent)
        if best is None or tree_recent["logLoss"] < best[0]:
            best = (tree_recent["logLoss"], config, probs, scored, tree_all, tree_recent, log_all, log_recent)
    if best is None:
        raise SystemExit("no model")
    _, config, probs, scored, tree_all, tree_recent, log_all, log_recent = best
    live = tree_all["logLoss"] + 0.002 < log_all["logLoss"] and tree_recent["logLoss"] <= log_recent["logLoss"] + 0.001
    final = GradientBoostingClassifier(random_state=1, **config)
    final.fit(np.vstack([x, -x]), np.concatenate([y, 1 - y]))
    payload = dump_model(final)
    payload.update(
        {
            "live": live,
            "cadence": "Refit at each new year on fights already settled, including the same card with the corners swapped. Scored only in the posted corner order.",
            "config": config,
            "fromYear": int(years[scored].min()) if scored.any() else None,
            "summary": tree_all,
            "since2018": tree_recent,
            "logistic": log_all,
            "logisticSince2018": log_recent,
            "residualLr": 0.01,
            "residualAnchor": 0.5,
        }
    )
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(
        f"live={live} tree_ll={tree_all['logLoss']} logit_ll={log_all['logLoss']} "
        f"recent={tree_recent['logLoss']}/{log_recent['logLoss']} bytes={OUT.stat().st_size}",
        flush=True,
    )


if __name__ == "__main__":
    main()
