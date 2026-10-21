# Octagon Edge

UFC fight-card model. Pick an upcoming event, score every bout, and read the stat gaps that moved the number.

History covers 2,775 fighters through the October 17, 2026 Edmonton card. Records are **UFC bouts only**, not regional or pro totals. The schedule snapshot is October 21, 2026. Refresh checks UFC.com and reports new event slugs; it does not invent a full card the file does not have.

## What you get for each fight

- Win probability for each fighter
- Most likely method (KO/TKO, submission, decision)
- Round the fight is most likely to end
- Side-by-side differentials: record, Elo, striking, last three fights, takedowns, reach, age, form, knockdowns, control, head strikes, injury burden, opponent-adjusted rates, and where the strikes land
- Flags for losing streaks, long layoffs, age, limited UFC sample, chin history, stance mismatch, high altitude, and reported injuries that still carry weight

The win probability is a gradient-boosted tree on the same 21 pre-fight gaps the logistic uses. Odds are not a feature. The trees are refit at the start of each year on fights already settled, and each training card is also shown with the corners swapped, because early UFCStats bouts list the winner first. The reported score uses only the posted corner order. On the 8,125 fights with a prior year of history the tree went 4,814 correct, log loss 0.667, against 4,765 and 0.673 for the walk-forward logistic on those same fights. Since 2018 it was 2,626 of 4,401, log loss 0.670, against 2,612 and 0.670 for the logistic. The full-history gain cleared the bar and the recent result is a tie, so the tree is the betting number. A residual on top of the tree starts at zero. Refresh can move that residual. It does not refit the trees.

The logistic walk, kept as the comparison, scores every event from UFC 2 on March 11, 1994 through October 17, 2026 before it updates. UFC 1 is not in the extract. On the full file it went 5,129 of 8,792 (58.3%, log loss 0.673) against 58.2% and 0.727 for the frozen hand weights, and 52.2% for Elo alone. Since 2018 it went 2,612 of 4,401 (59.3%, log loss 0.670). Method and round splits stay heuristic.

Refresh checks the public results file for fights after that date. It updates the record, Elo, strike rates, the last three fights, control, knockdowns, and new fight-ending injury lines saved in this browser. It does not invent a surgery, a weigh-in, or a regional record.

Opponent-adjusted striking and wrestling, plus distance, clinch, ground, body, leg, and reversals, are on the card. Adding them to the win percentage did not lower log loss, so they do not move it. Weigh-ins and short notice are not in the public file.

Injury burden fades over about seven months. It is built from fight-ending injuries in the UFC results (a doctor's stoppage, or a detail line that names an injury) plus surgeries that were checked against a public report. Petr Yan's nine-hour lumbar disc surgery in January 2026 is the sourced note. The injury coefficient stayed at its prior (−0.85) because those reports are rare, so that prior is what moves a live fight. Nothing on file is not a clean bill of health. There is no public surgery registry. Camp quality and scale weight are not in the file.

It is a gradient-boosted tree with a small residual, not a hand-weighted logistic. The logistic remains the comparison and is what the tree had to beat.

## Odds and bets

Analyze pulls public moneylines, then grades the card against the sportsbook you select: DraftKings, FanDuel, BetMGM, Caesars, Fanatics, BetRivers, Hard Rock, or Bovada. Method and distance props show only when that same book posted them.

A side is marked **mispriced** when that book's price has at least 4% expected value versus the model (8% for a prop). Fanatics is listed, but a number appears only when a public board has actually posted one. Nothing is copied from another book.

Lines are read from public odds boards when you analyze or refresh. If that request fails, the app uses the saved board in `src/data/odds.json`. Fight nights with no posted line stay blank. Confirm the number in your account before you bet. It can move.

Division names on the card are not scale weights. Weigh-ins are not ingested.

## Scout notes (optional)

After Analyze, each scored fight has **Scout notes**. That call happens only when you press the button.

| Provider | How it authenticates |
|---|---|
| Grok | Server `XAI_API_KEY`. No key field in the page. |
| ChatGPT | Paste an OpenAI key. Used for that request and not stored. |
| Anthropic | Paste an Anthropic key. Used for that request and not stored. |

Notes are capped and instructed not to invent injuries, camps, or outside projects.

## Run it

```bash
npm install
npm run dev
```

The dev server listens on port 8080. `XAI_API_KEY` is optional and only needed for Grok scout notes.

## Rebuild the fighter file

Download the public CSVs from [Greco1899/scrape_ufc_stats](https://github.com/Greco1899/scrape_ufc_stats) (`ufc_fight_results.csv`, `ufc_fighter_tott.csv`, `ufc_event_details.csv`, `ufc_fight_stats.csv`) into one folder, then:

```bash
UFC_RAW=/path/to/csvs python3 scripts/build-ufc-profiles.py
```

That rewrites `src/data/fighters.json`. Then rebuild the walk-forward weights:

```bash
UFC_RAW=/path/to/csvs python3 scripts/backtest-ufc.py
```

Upcoming cards live in `src/data/schedule.json`. The backtest writes `src/data/learned.json` and `src/data/injuries.json`. The tree file is separate:

```bash
python3 scripts/train-trees.py
```

That needs the public CSVs in `UFC_RAW` (default `/tmp/ufcraw`) and writes `src/data/trees.json`. The betting number switches to the tree only when its walk-forward log loss beats the logistic.
