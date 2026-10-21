# Octagon Edge

UFC fight-card model. Pick an upcoming event, score every bout, and read the stat gaps that moved the number.

History covers 2,775 fighters through the October 17, 2026 Edmonton card. Records are **UFC bouts only**, not regional or pro totals. The schedule snapshot is October 21, 2026. Refresh checks UFC.com and reports new event slugs; it does not invent a full card the file does not have.

## What you get for each fight

- Win probability for each fighter
- Most likely method (KO/TKO, submission, decision)
- Round the fight is most likely to end
- Side-by-side differentials: record, Elo, strike differential, accuracy, defense, takedowns, takedown defense, reach, age, last five, days since last fight, knockdowns, control time, head strikes, and injury burden
- Flags for losing streaks, long layoffs, age, limited UFC sample, chin history, stance mismatch, high altitude, and reported injuries that still carry weight

The win probability is a weighted logistic. The weights are not the original hand settings. A walk-forward pass scores every event in the public file, from UFC 2 on March 11, 1994 through October 17, 2026, using only information known before that card, then updates the weights from that card's results. UFC 1 is not in the extract. Method and round splits stay heuristic.

On the history file the learned weights went 5,119 of 8,792 (58.2%, log loss 0.673) against 58.2% and 0.727 for the frozen hand weights, and 52.2% for Elo alone. Since 2018 the learned weights went 2,611 of 4,401 (59.3%, log loss 0.670) against 59.0% and 0.716 for the hand weights. Adding knockdowns, control, head strikes, and injury burden did not beat the previous 14-feature log loss of 0.670. The pick rate is the same. Refresh checks the public results file for fights after that date and keeps updating the saved weights in this browser.

Injury burden fades over about seven months. It is built from fight-ending injuries in the UFC results (a doctor's stoppage, or a detail line that names an injury) plus surgeries that were checked against a public report. Petr Yan's nine-hour lumbar disc surgery in January 2026 is the sourced note. The injury coefficient stayed at its prior (−0.85) because those reports are rare, so that prior is what moves a live fight. Nothing on file is not a clean bill of health. There is no public surgery registry. Camp quality and scale weight are not in the file.

It is **not** a trained gradient-boosted model.

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

Upcoming cards live in `src/data/schedule.json`. The backtest writes `src/data/learned.json` and `src/data/injuries.json`.
