# THT Dual Scan Dashboard

Live dashboard showing S&P 500 stocks where **both** the THT Fair Value Bands indicator AND the B-Xtrender oscillator flipped on the same trading day.

- **Data:** Yahoo Finance daily OHLCV
- **Math:** Open-source Pine ports (FVB = SMA20 cross; BXT = RSI of EMA5−EMA20)
- **Refresh:** Every 5 minutes via local cron (Mac launchd)
- **Hosting:** GitHub Pages (free)

## Live URL

https://piraci26.github.io/tht-dashboard/

## How it works

`scan.py` runs locally on a 5-minute schedule, computes the indicators against fresh Yahoo data, and writes `docs/results.json`. The dashboard at `docs/index.html` fetches that JSON and renders two tables. Every commit auto-deploys via GitHub Pages.
