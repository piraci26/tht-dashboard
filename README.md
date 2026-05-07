# THT Dual Scan

Live dashboard scanning **1,500+ US equities** (mcap ≥ $3.5B) for technical-indicator regime flips on **THT Fair Value Bands** and **B-Xtrender**, across **Daily / Weekly / Monthly** timeframes. Updates every 5 minutes.

**Live**: <https://piraci26.github.io/tht-dashboard/>
**Dev (redesign sandbox)**: <https://piraci26.github.io/tht-dashboard-dev/>
**Dev2 (trend-iq design port)**: <https://piraci26.github.io/tht-dashboard-dev2/>

## What it does

- Pulls daily / weekly / monthly OHLCV bars from Yahoo Finance for ~1,500 US tickers
- Computes two technical indicators per ticker per bar:
  - **THT Fair Value Bands (FVB)** — `basis = SMA(close, 20)`, `upper/lower = basis ± 2·stdev`. Bull regime = `close > basis`.
  - **B-Xtrender (BXT)** — `RSI(EMA(close, 5) − EMA(close, 20), 15) − 50`. Long-term: `RSI(close, 15) − 50`.
- Detects **flips** (regime changes between yesterday and today)
- Emits 4 categories per timeframe: FVB-green / FVB-red / BXT-green / BXT-red
- Computes **streak** (days held in prior regime before flipping) per flipped ticker
- Caches 1y daily / 5y weekly / max-history monthly OHLCV per flipped ticker (for inline charts)
- Diffs current vs previous run for the "Changes since last 5-min refresh" panel
- Writes everything to `docs/*.json` for the static frontend

## Architecture

```
┌───────────────────┐
│  macOS launchd    │ every 5 min
│  com.kuba.thtscan │
└────────┬──────────┘
         │ runs
         ▼
┌─────────────────────┐         ┌───────────────────┐
│  run_and_push.sh    │  HTTP   │  Yahoo Finance    │
│   ↳ scan.py         │ ──────► │  v8/finance/chart │
└────────┬────────────┘         └───────────────────┘
         │ writes
         ▼
┌─────────────────────────────────────────────┐
│ docs/                                       │
│   results.json          ← daily flips       │
│   results_weekly.json   ← weekly flips      │
│   results_monthly.json  ← monthly flips     │
│   bars/{SYM}.json       ← 1y daily OHLCV    │
│   bars_weekly/{SYM}.json   5y weekly OHLCV  │
│   bars_monthly/{SYM}.json  max monthly      │
│   articles.json         ← market analysis   │
│   index.html + style.css                    │
└─────────────────┬───────────────────────────┘
                  │ git push
                  ▼
         ┌────────────────────────┐
         │  GitHub Pages          │
         │  (free, global, HTTPS) │
         └────────────────────────┘
                  │
                  ▼ browser polls every 30s
         ┌────────────────────────┐
         │  Vanilla HTML/CSS/JS   │
         │  + lightweight-charts  │
         │    (TradingView CDN)   │
         └────────────────────────┘
```

**Zero servers. $0/month.** Domain optional.

## Repo layout

```
.
├── scan.py                  ← main scanner, runs all 3 timeframes per cycle
├── fetch_universe.py        ← builds universe.json from NASDAQ screener API
├── fetch_shares.py          ← builds shares_outstanding.json from stockanalysis.com
├── run_and_push.sh          ← launchd entry point — runs scan + commits + pushes
├── universe.json            ← 1,511 US tickers, mcap > $3.5B
├── universe_names.json      ← ticker → company name lookup
├── shares_outstanding.json  ← ticker → shares + reference mcap
├── sp500_tickers.json       ← legacy S&P 500 list (kept for reference)
└── docs/                    ← what GitHub Pages deploys
    ├── index.html           ← the dashboard UI
    ├── style.css
    ├── articles.json        ← market-inference articles (educational only)
    ├── results.json         ← latest daily scan output
    ├── results_weekly.json
    ├── results_monthly.json
    ├── bars/{SYM}.json      ← per-ticker daily OHLCV cache
    ├── bars_weekly/{SYM}.json
    └── bars_monthly/{SYM}.json
```

## Running locally

```bash
# 1. Refresh the universe + shares (weekly, or when the universe changes)
python3 fetch_universe.py
python3 fetch_shares.py

# 2. Run a scan manually
python3 scan.py

# 3. Or trigger the full pipeline (scan + commit + push)
./run_and_push.sh
```

`scan.py` requires only Python stdlib (`urllib`, `json`, `concurrent.futures`). No `pip install` needed.

## Frontend

Vanilla HTML + CSS + JS. No build step. No framework.

The dashboard reads `docs/results*.json`, renders 5 sortable tables (Changes / FVB green / FVB red / BXT green / BXT red), and on row-click expands a TradingView-style chart inline (via [lightweight-charts](https://github.com/tradingview/lightweight-charts) loaded from unpkg CDN).

JS handles: indicator math (mirror of `scan.py`), table rendering + sort + filter, chart rendering with FVB cloud + B-Xtrender oscillator pane, theme persistence, articles loader, 30-second polling, 12-min watchdog reload.

Three preview environments share the same data layer (`docs/results*.json`), differing only in frontend design:
- **prod** (this repo) — production look
- **dev1** ([repo](https://github.com/piraci26/tht-dashboard-dev)) — redesign sandbox
- **dev2** ([repo](https://github.com/piraci26/tht-dashboard-dev2)) — trend-iq Lovable export ported to vanilla

## Indicators (math reference)

```python
# THT Fair Value Bands
basis = sma(close, 20)
upper = basis + 2 * stdev(close, 20)
lower = basis - 2 * stdev(close, 20)
is_bull = close > basis

# B-Xtrender (short-term)
short_term = rsi(ema(close, 5) - ema(close, 20), 15) - 50

# B-Xtrender (long-term, smoothed)
long_term = wma(rsi(close, 15) - 50, 5)

# Flip detection
fvb_flip = is_bull[t] != is_bull[t-1]
bxt_flip = sign(short_term[t]) != sign(short_term[t-1])

# Streak: how long the prior regime held before today's flip
fvb_streak = consecutive bars before t where is_bull == is_bull[t-1]
```

## Operations

- **Schedule**: `~/Library/LaunchAgents/com.kuba.thtscan.plist` (every 5 min, runs `run_and_push.sh`)
- **Logs**: `/tmp/tht-scan.log` (stdout) + `/tmp/tht-scan.err` (stderr)
- **Rate-limit guard**: `scan.py` aborts the write if Yahoo returns < 100 valid tickers (preserves last-known-good state)
- **Analytics**: privacy-friendly [GoatCounter](https://goatcounter.com), cookieless

## Disclaimer

Educational tool only — **not investment advice**. The author is not a registered investment adviser. Patterns surfaced by the scanner or described in articles may or may not predict future market behaviour.

## License

MIT.
