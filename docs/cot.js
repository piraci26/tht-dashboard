// Positioning Monitor — CFTC COT
// Pulls TFF (Traders in Financial Futures) Futures+Options Combined data
// for major US equity index + VIX contracts, computes the Briese COT Index
// (3-yr min/max normalized) for Asset Managers and Leveraged Funds.
//
// Endpoint: https://publicreporting.cftc.gov/resource/yw9f-hn96.json
// CFTC Socrata API supports CORS — works straight from the browser.

const CFTC_URL = 'https://publicreporting.cftc.gov/resource/yw9f-hn96.json';
const LOOKBACK_WEEKS = 156;          // 3 years per Briese / CMT Level III
const FETCH_WEEKS = 170;             // small buffer for safety

// Contracts to track — order matters (render order)
// Use Consolidated codes for NQ/YM (big + e-mini combined; the e-mini-only
// codes stopped reporting separately in 2014-15 after CME consolidated).
// `proxy` = Yahoo ticker used for the TV-style price chart (ETFs or indices).
const CONTRACTS = [
  { sym: 'ES',  name: 'S&P 500 E-mini',            code: '13874A', proxy: 'SPY' },
  { sym: 'NQ',  name: 'Nasdaq-100 (Consolidated)', code: '20974+', proxy: 'QQQ' },
  { sym: 'RTY', name: 'Russell 2000 E-mini',       code: '239742', proxy: 'IWM' },
  { sym: 'YM',  name: 'DJIA (Consolidated)',       code: '12460+', proxy: 'DIA' },
  { sym: 'EMD', name: 'S&P MidCap 400 E-mini',     code: '33874A', proxy: 'MDY' },
  { sym: 'VX',  name: 'VIX Futures',               code: '1170E1', proxy: '^VIX' },
];

// ─── TV-style price chart colors (match existing dashboard) ──────────────
const TV_COLORS = {
  bg:     '#131722',
  text:   '#d1d4dc',
  grid:   '#1e222d',
  border: '#2A2E39',
  bull:   '#26a69a',
  bear:   '#ef5350',
};

// ─── Data fetching ───────────────────────────────────────────────────────

async function fetchContract(code) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - (FETCH_WEEKS * 7));
  const cutoffIso = cutoffDate.toISOString().slice(0, 10);

  const params = new URLSearchParams({
    cftc_contract_market_code: code,
    '$where': `report_date_as_yyyy_mm_dd > '${cutoffIso}'`,
    '$order': 'report_date_as_yyyy_mm_dd DESC',
    '$limit': '200',
  });

  const res = await fetch(`${CFTC_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`CFTC ${code}: HTTP ${res.status}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`CFTC ${code}: no data`);
  return rows;
}

// ─── COT Index (Briese) ──────────────────────────────────────────────────
// COT Index = 100 * (current - min) / (max - min) over N-week window.
// Returns 0..100. If max==min returns 50 (degenerate window).

function cotIndex(series, window = LOOKBACK_WEEKS) {
  const slice = series.slice(0, Math.min(window, series.length));
  if (!slice.length) return null;
  const current = slice[0];
  let min = current, max = current;
  for (const v of slice) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return 50;
  return 100 * (current - min) / (max - min);
}

// Rolling COT Index — returns an array of indices for each week in the series
function cotIndexRolling(series, window = LOOKBACK_WEEKS) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const sub = series.slice(i, i + window);
    if (sub.length < 8) { out.push(null); continue; }   // need at least 2 mo
    out.push(cotIndex(sub, sub.length));
  }
  return out;
}

// ─── Field parsing — handle TFF F+O field-name variants ──────────────────
// In TFF F+O combined, Asset Mgr / Lev Money fields have NO _all suffix
// (e.g. asset_mgr_positions_long, not asset_mgr_positions_long_all).
function pickNum(row, ...keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') {
      const n = Number(row[k]);
      if (!isNaN(n)) return n;
    }
  }
  return 0;
}

function parseRow(row) {
  return {
    date: row.report_date_as_yyyy_mm_dd?.slice(0, 10),
    oi: pickNum(row, 'open_interest_all'),
    am_long:  pickNum(row, 'asset_mgr_positions_long',  'asset_mgr_positions_long_all'),
    am_short: pickNum(row, 'asset_mgr_positions_short', 'asset_mgr_positions_short_all'),
    lf_long:  pickNum(row, 'lev_money_positions_long',  'lev_money_positions_long_all'),
    lf_short: pickNum(row, 'lev_money_positions_short', 'lev_money_positions_short_all'),
    d_long:   pickNum(row, 'dealer_positions_long_all'),
    d_short:  pickNum(row, 'dealer_positions_short_all'),
  };
}

// ─── Number formatting ───────────────────────────────────────────────────
function fmtNet(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1_000_000) return `${sign}${(abs/1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${sign}${(abs/1_000).toFixed(1)}k`;
  return `${sign}${abs}`;
}
function fmtDelta(n) {
  if (n == null || isNaN(n) || n === 0) return '·';
  const sign = n > 0 ? '+' : '−';
  const abs = Math.abs(n);
  if (abs >= 1_000) return `${sign}${(abs/1_000).toFixed(1)}k`;
  return `${sign}${abs}`;
}

// ─── Classification (read tag + visual state) ────────────────────────────
function classify(idx) {
  if (idx == null) return 'neutral';
  if (idx >= 90) return 'crowded-long';
  if (idx >= 75) return 'building-long';
  if (idx <= 10) return 'crowded-short';
  if (idx <= 25) return 'building-short';
  return 'neutral';
}
const READ_LABELS = {
  'crowded-long':   'Crowded Long',
  'building-long':  'Building Long',
  'neutral':        'Neutral',
  'building-short': 'Building Short',
  'crowded-short':  'Crowded Short',
};

// ─── TV-style COT Index oscillator chart ─────────────────────────────────
// Plots the rolling COT Index (Briese, 3y window) for Asset Managers and
// Leveraged Funds. NOT the underlying price — that's the wrong thing to
// look at in a positioning monitor.
function renderCotIndexChart(container, parsedRows, contract) {
  if (typeof LightweightCharts === 'undefined') {
    container.innerHTML = `<div class="chart-error" style="padding:18px;font-size:11px;">Chart lib failed to load.</div>`;
    return;
  }
  container.innerHTML = '';

  // Build chronological (oldest→newest) series of weekly net positions
  // parsedRows is DESC by date, so reverse for plotting.
  const chrono = [...parsedRows].reverse();
  const dates  = chrono.map(r => r.date);
  const am_net = chrono.map(r => r.am_long - r.am_short);
  const lf_net = chrono.map(r => r.lf_long - r.lf_short);

  // Rolling 156-week COT Index. For each week i, compute over [i-155 .. i].
  function rollingIdx(series, window = LOOKBACK_WEEKS) {
    const out = [];
    for (let i = 0; i < series.length; i++) {
      const start = Math.max(0, i - window + 1);
      const win = series.slice(start, i + 1);
      if (win.length < 8) { out.push(null); continue; }
      const cur = win[win.length - 1];
      let mn = cur, mx = cur;
      for (const v of win) { if (v < mn) mn = v; if (v > mx) mx = v; }
      out.push(mx === mn ? 50 : 100 * (cur - mn) / (mx - mn));
    }
    return out;
  }
  const am_idx_series = rollingIdx(am_net);
  const lf_idx_series = rollingIdx(lf_net);

  // Convert YYYY-MM-DD string → unix-seconds time for lightweight-charts
  const toTime = d => Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000);
  const buildSeries = (vals) => {
    const out = [];
    for (let i = 0; i < dates.length; i++) {
      if (vals[i] == null) continue;
      out.push({ time: toTime(dates[i]), value: vals[i] });
    }
    return out;
  };
  const am_data = buildSeries(am_idx_series);
  const lf_data = buildSeries(lf_idx_series);

  // Threshold lines at 20 / 80 across full date range
  const dateMin = dates.length ? toTime(dates[0])               : 0;
  const dateMax = dates.length ? toTime(dates[dates.length-1])  : 0;
  const flatLine = (val) => [
    { time: dateMin, value: val },
    { time: dateMax, value: val },
  ];

  // TV-style header — show CURRENT COT Index values + 4w delta
  const am_now = am_data.length ? am_data[am_data.length-1].value : null;
  const lf_now = lf_data.length ? lf_data[lf_data.length-1].value : null;
  const am_4w  = am_data.length > 4 ? am_data[am_data.length-5].value : null;
  const lf_4w  = lf_data.length > 4 ? lf_data[lf_data.length-5].value : null;
  const fmtIdx = v => v == null ? '—' : v.toFixed(0);
  const fmtDelta4w = v => v == null ? '·' : (v > 0 ? '+' : '') + v.toFixed(0);
  const am_d4 = (am_now != null && am_4w != null) ? am_now - am_4w : null;
  const lf_d4 = (lf_now != null && lf_4w != null) ? lf_now - lf_4w : null;
  const colorFor = idx => idx == null ? '#787B86' : idx >= 80 ? '#26a69a' : idx <= 20 ? '#ef5350' : '#d1d4dc';

  const head = document.createElement('div');
  head.className = 'tv-header tv-header-mini';
  head.innerHTML = `
    <span class="tv-sym">COT Index</span>
    <span class="tv-tf">· W · 3y</span>
    <span class="tv-ohlc">
      <b style="color:#FFB74D">AM</b> <b style="color:${colorFor(am_now)}">${fmtIdx(am_now)}</b>
      <span class="tv-delta" style="color:${am_d4 == null ? '#787B86' : am_d4 > 0 ? '#26a69a' : '#ef5350'}">${fmtDelta4w(am_d4)}</span>
      &nbsp;&nbsp;
      <b style="color:#4DD0E1">LF</b> <b style="color:${colorFor(lf_now)}">${fmtIdx(lf_now)}</b>
      <span class="tv-delta" style="color:${lf_d4 == null ? '#787B86' : lf_d4 > 0 ? '#26a69a' : '#ef5350'}">${fmtDelta4w(lf_d4)}</span>
    </span>
  `;
  container.appendChild(head);

  // Chart canvas
  const chartWrap = document.createElement('div');
  chartWrap.style.cssText = 'width:100%; height:200px;';
  container.appendChild(chartWrap);

  const chart = LightweightCharts.createChart(chartWrap, {
    layout: {
      background: { color: TV_COLORS.bg },
      textColor: TV_COLORS.text,
      fontSize: 10,
      fontFamily: '-apple-system, "Trebuchet MS", sans-serif',
    },
    grid: {
      vertLines: { color: TV_COLORS.grid },
      horzLines: { color: TV_COLORS.grid },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: {
      borderColor: TV_COLORS.border,
      scaleMargins: { top: 0.08, bottom: 0.08 },
      autoScale: false,
      // Explicit 0..100 range for the COT Index oscillator
      mode: 0,
    },
    timeScale: { borderColor: TV_COLORS.border, timeVisible: false, secondsVisible: false, rightOffset: 2 },
    handleScroll: false,
    handleScale: false,
    watermark: {
      visible: true,
      color: 'rgba(120,123,134,0.18)',
      text: contract.sym + '  ·  COT INDEX',
      fontSize: 13,
      horzAlign: 'right', vertAlign: 'top',
    },
  });

  // Reference shading — extreme zones (>80 long, <20 short)
  const extremeLong = chart.addAreaSeries({
    topColor: 'rgba(38,166,154,0.10)', bottomColor: 'rgba(38,166,154,0.00)',
    lineColor: 'rgba(0,0,0,0)', lineWidth: 0,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    baseValue: { type: 'price', price: 80 },
  });
  extremeLong.setData(flatLine(100));

  const extremeShort = chart.addAreaSeries({
    topColor: 'rgba(239,83,80,0.10)', bottomColor: 'rgba(239,83,80,0.00)',
    lineColor: 'rgba(0,0,0,0)', lineWidth: 0,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    baseValue: { type: 'price', price: 20 },
  });
  extremeShort.setData(flatLine(0));

  // Reference lines at 20 / 50 / 80
  const refLine = (val, color, style) => {
    const s = chart.addLineSeries({
      color, lineWidth: 1, lineStyle: style,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    s.setData(flatLine(val));
  };
  refLine(80, 'rgba(38,166,154,0.45)',  LightweightCharts.LineStyle.Dashed);
  refLine(50, 'rgba(120,123,134,0.30)', LightweightCharts.LineStyle.Dotted);
  refLine(20, 'rgba(239,83,80,0.45)',   LightweightCharts.LineStyle.Dashed);

  // Asset Managers (slow money) — amber
  const amLine = chart.addLineSeries({
    color: '#FFB74D', lineWidth: 2,
    priceLineVisible: true, priceLineColor: '#FFB74D', priceLineStyle: LightweightCharts.LineStyle.Dotted,
    lastValueVisible: true, crosshairMarkerRadius: 3,
    title: 'Asset Mgrs',
  });
  amLine.setData(am_data);

  // Leveraged Funds (hedge funds) — cyan
  const lfLine = chart.addLineSeries({
    color: '#4DD0E1', lineWidth: 2,
    priceLineVisible: true, priceLineColor: '#4DD0E1', priceLineStyle: LightweightCharts.LineStyle.Dotted,
    lastValueVisible: true, crosshairMarkerRadius: 3,
    title: 'Lev Funds',
  });
  lfLine.setData(lf_data);

  // Pin the price scale to 0..100 by setting fixed visible range via the
  // synthetic ref lines we already drew (refLine 0->100 emits no series at
  // those values, so we add invisible anchors).
  const anchorTop = chart.addLineSeries({ color: 'rgba(0,0,0,0)', lineWidth: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  anchorTop.setData([{ time: dateMin, value: 0 }, { time: dateMax, value: 100 }]);

  chart.timeScale().fitContent();

  const ro = new ResizeObserver(entries => {
    for (const e of entries) {
      chart.resize(e.contentRect.width, 200);
      chart.timeScale().fitContent();
    }
  });
  ro.observe(chartWrap);
}

// ─── Sparkline (SVG) ─────────────────────────────────────────────────────
function sparkline(values, color) {
  const w = 100, h = 28;
  const valid = values.filter(v => v != null);
  if (valid.length < 2) return '';
  const min = Math.min(...valid), max = Math.max(...valid);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  let path = '';
  values.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  });
  return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.85"/>
  </svg>`;
}

// ─── Card render ─────────────────────────────────────────────────────────
function renderCard(contract, rows, container) {
  const parsed = rows.map(parseRow);
  // sorted DESC by date — index 0 is most recent
  const am_net = parsed.map(r => r.am_long - r.am_short);
  const lf_net = parsed.map(r => r.lf_long - r.lf_short);
  const d_net  = parsed.map(r => r.d_long  - r.d_short);

  const am_idx = cotIndex(am_net);
  const lf_idx = cotIndex(lf_net);
  const am_idx_4w_ago = cotIndex(am_net.slice(4), LOOKBACK_WEEKS);
  const lf_idx_4w_ago = cotIndex(lf_net.slice(4), LOOKBACK_WEEKS);

  const am_d_idx = am_idx != null && am_idx_4w_ago != null ? am_idx - am_idx_4w_ago : null;
  const lf_d_idx = lf_idx != null && lf_idx_4w_ago != null ? lf_idx - lf_idx_4w_ago : null;

  const am_d_pos = am_net.length > 4 ? am_net[0] - am_net[4] : null;
  const lf_d_pos = lf_net.length > 4 ? lf_net[0] - lf_net[4] : null;

  const am_class = classify(am_idx);
  const lf_class = classify(lf_idx);

  // Card-level state: extreme if either AM or LF is extreme
  let cardState = '';
  if (lf_class === 'crowded-long' || am_class === 'crowded-long') cardState = 'extreme-long';
  else if (lf_class === 'crowded-short' || am_class === 'crowded-short') cardState = 'extreme-short';

  // Net position label — LF is the headline since it's the speculator number
  const lf_net_now = lf_net[0];
  const lf_net_class = lf_net_now > 0 ? 'pos' : lf_net_now < 0 ? 'neg' : '';

  // Sparkline: rolling 52-week COT Index for LF
  const lf_rolling = cotIndexRolling(lf_net).slice(0, 52).reverse();

  const gaugeBar = (idx, label, dIdx, dPos, klass) => {
    if (idx == null) return `<div class="gauge"><div class="gauge-head"><span class="gauge-name">${label}</span><span class="gauge-val">—</span></div></div>`;
    const valClass = klass.includes('crowded-long')   ? 'extreme-long'
                    : klass === 'building-long'       ? 'warm-long'
                    : klass === 'crowded-short'      ? 'extreme-short'
                    : klass === 'building-short'     ? 'warm-short' : '';
    const markerClass = klass === 'crowded-long' ? 'extreme-long' : klass === 'crowded-short' ? 'extreme-short' : '';
    const dIdxClass = dIdx == null ? '' : dIdx > 0 ? 'pos' : dIdx < 0 ? 'neg' : '';
    const dIdxStr = dIdx == null ? '·' : `${dIdx > 0 ? '+' : ''}${dIdx.toFixed(0)}`;
    return `
      <div class="gauge">
        <div class="gauge-head">
          <span class="gauge-name">${label}</span>
          <span class="gauge-val ${valClass}">${idx.toFixed(0)}</span>
        </div>
        <div class="gauge-track">
          <div class="gauge-thresholds">
            <span class="gauge-tick" style="left:20%"></span>
            <span class="gauge-tick" style="left:80%"></span>
          </div>
          <div class="gauge-marker ${markerClass}" style="left:${idx.toFixed(1)}%"></div>
        </div>
        <div class="gauge-foot">
          <span>Net ${fmtNet(label === 'Asset Mgrs' ? (am_net[0]) : (lf_net[0]))}</span>
          <span class="gauge-delta ${dIdxClass}">Δ4w idx ${dIdxStr} · pos ${fmtDelta(label === 'Asset Mgrs' ? am_d_pos : lf_d_pos)}</span>
        </div>
      </div>`;
  };

  // The headline read tag is the more extreme of AM and LF
  const headTag = (am_idx != null && lf_idx != null)
    ? ([am_class, lf_class].includes('crowded-long')   ? 'crowded-long'
       : [am_class, lf_class].includes('crowded-short') ? 'crowded-short'
       : [am_class, lf_class].includes('building-long') ? 'building-long'
       : [am_class, lf_class].includes('building-short')? 'building-short'
       : 'neutral')
    : 'neutral';

  container.innerHTML = `
    <div class="contract-card ${cardState}">
      <div class="card-head">
        <div class="card-sym">${contract.sym}</div>
        <div class="card-name">${contract.name}</div>
      </div>
      <div class="card-netpos-row">
        <span class="card-netpos-label">Lev Funds Net</span>
        <span class="card-netpos-val ${lf_net_class}">${fmtNet(lf_net_now)}</span>
      </div>
      ${gaugeBar(am_idx, 'Asset Mgrs', am_d_idx, am_d_pos, am_class)}
      ${gaugeBar(lf_idx, 'Lev Funds',  lf_d_idx, lf_d_pos, lf_class)}
      <div class="read-tag ${headTag}">${READ_LABELS[headTag]}</div>
      <div class="card-chart-wrap"></div>
    </div>`;

  // Render the COT Index oscillator chart inside this card (sync — data is
  // already in hand, no extra fetch needed).
  const chartWrap = container.querySelector('.card-chart-wrap');
  if (chartWrap) renderCotIndexChart(chartWrap, parsed, contract);
}

// ─── Composite read ──────────────────────────────────────────────────────
function renderComposite(allResults) {
  const target = document.getElementById('composite-card');
  // Aggregate: average LF COT Index across all contracts (VIX flipped because
  // a low VX LF index = short vol = same risk-on stance as long equity).
  const scores = [];
  for (const r of allResults) {
    if (!r.ok) continue;
    const parsed = r.rows.map(parseRow);
    const lf_net = parsed.map(p => p.lf_long - p.lf_short);
    let idx = cotIndex(lf_net);
    if (idx == null) continue;
    // For VIX: invert so 0 (max short vol) reads as 100 (max risk-on)
    if (r.contract.sym === 'VX') idx = 100 - idx;
    scores.push(idx);
  }
  if (!scores.length) {
    target.innerHTML = `<div class="composite-loading">No data available.</div>`;
    return;
  }
  const composite = scores.reduce((a,b) => a+b, 0) / scores.length;

  let cls = '', scoreCls = '', headline = '', stance = '';
  if (composite >= 80) {
    cls = 'crowded-long';
    scoreCls = 'high';
    headline = `Hedge funds are <strong>crowded long</strong> across the US equity complex.`;
    stance = `<span class="accent">Defensive stance warranted.</span> The trade has fuel but the marginal buyer is running out. Tighten stops, be selective about adding fresh longs, consider buying cheap protection. Watch for the COT Index to flatten or roll over — that's the unwind signal.`;
  } else if (composite >= 65) {
    cls = '';
    scoreCls = 'high';
    headline = `Positioning is <strong>building long</strong> but not yet maxed.`;
    stance = `Trend has room. Ride with the flow, don't fade prematurely. Watch for acceleration into &gt;90 territory — that's when the asymmetry flips.`;
  } else if (composite <= 20) {
    cls = 'crowded-short';
    scoreCls = 'low';
    headline = `Hedge funds are <strong>crowded short</strong> across the US equity complex.`;
    stance = `<span class="accent-red">Squeeze fuel is loaded.</span> Don't chase shorts at these extremes. Wait for a trigger (positive surprise, key technical break, vol spike) — when forced covers begin, moves can be violent.`;
  } else if (composite <= 35) {
    cls = '';
    scoreCls = 'low';
    headline = `Positioning is <strong>building short</strong> but not maxed.`;
    stance = `Trend can persist. Don't fight the flow. Watch for capitulation prints — when the last marginal seller gives up, that's the bottom.`;
  } else {
    cls = '';
    scoreCls = '';
    headline = `Positioning is <strong>neutral</strong> across the equity complex.`;
    stance = `No positioning extreme to lean on. Trade off other signals — price action, vol, GEX, catalysts. Re-check the gauge weekly.`;
  }

  target.className = `composite-card ${cls}`;
  target.innerHTML = `
    <div class="composite-score-wrap">
      <div class="composite-score-label">Composite COT Index</div>
      <div class="composite-score ${scoreCls}">${composite.toFixed(0)}</div>
      <div class="composite-score-sub">avg of ${scores.length} contracts (VX inverted)</div>
    </div>
    <div class="composite-text">
      <div class="composite-headline ${composite <= 20 ? 'warning' : ''}">${headline}</div>
      <div class="composite-stance">${stance}</div>
    </div>`;
}

// ─── Render error card ───────────────────────────────────────────────────
function renderError(contract, err, container) {
  container.innerHTML = `
    <div class="contract-card">
      <div class="card-head">
        <div class="card-sym">${contract.sym}</div>
        <div class="card-name">${contract.name}</div>
      </div>
      <div class="card-error">Failed to load: ${err.message}</div>
    </div>`;
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  const grid = document.getElementById('contracts-grid');
  grid.innerHTML = '';

  // One placeholder per contract so they render in order even with parallel fetches
  const cardEls = CONTRACTS.map(c => {
    const div = document.createElement('div');
    div.innerHTML = `<div class="card-skeleton">Loading ${c.sym}…</div>`;
    grid.appendChild(div);
    return div;
  });

  // Fetch all in parallel
  const results = await Promise.all(CONTRACTS.map(async (c, i) => {
    try {
      const rows = await fetchContract(c.code);
      return { contract: c, rows, ok: true, index: i };
    } catch (err) {
      return { contract: c, err, ok: false, index: i };
    }
  }));

  // Render each card
  results.forEach(r => {
    if (r.ok) renderCard(r.contract, r.rows, cardEls[r.index]);
    else      renderError(r.contract, r.err, cardEls[r.index]);
  });

  // Last-update label = the most recent report_date across successful fetches
  const dates = results.filter(r => r.ok && r.rows.length).map(r => r.rows[0].report_date_as_yyyy_mm_dd);
  if (dates.length) {
    dates.sort();
    const lastDate = dates[dates.length - 1].slice(0, 10);
    document.getElementById('last-update').textContent = `Latest report: ${lastDate} (Tuesday close)`;
  } else {
    document.getElementById('last-update').textContent = 'CFTC data unavailable';
  }

  // Composite read
  renderComposite(results);
}

main().catch(err => {
  console.error('COT init failed:', err);
  document.getElementById('last-update').textContent = `Error: ${err.message}`;
});
