# Octagon Edge

UFC fight-card model. Pick an upcoming event, score every bout, and read the stat gaps that moved the number.

History covers 2,775 fighters through the October 17, 2026 Edmonton card. Records are **UFC bouts only**, not regional or pro totals. The schedule snapshot is October 21, 2026. Refresh checks UFC.com and reports new event slugs; it does not invent a full card the file does not have.

## What you get for each fight

- Win probability for each fighter
- Most likely method (KO/TKO, submission, decision)
- Round the fight is most likely to end
- Side-by-side differentials: record, Elo, strike differential, accuracy, defense, takedowns, takedown defense, reach, age, last five, days since last fight
- Flags for losing streaks, long layoffs, age, limited UFC sample, chin history, stance mismatch, and high altitude

The model is an interpretable weighted logistic on those signals. It runs in the browser. It is **not** a trained gradient-boosted model.

## Odds and bets

Analyze also pulls moneylines for DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock, and Bovada, plus method and distance props when a book has posted them.

A side is marked **mispriced** when the best price has at least 4% expected value versus the model (8% for a prop). The card opens with those spots, and the price cell is highlighted. If the model likes a fighter but the number is too short, the fight says pass.

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

That rewrites `src/data/fighters.json`. Upcoming cards live in `src/data/schedule.json`.
