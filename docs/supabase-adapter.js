// Supabase adapter — translates Supabase tables into the legacy JSON shapes
// the dashboard's render layer already speaks. Lets us swap data sources
// (GH Pages JSON → Supabase REST + realtime) without touching the renderer.
//
// Loaded as an ES module from index.html; assigns window.suprAdapter and
// window.suprClient so the non-module main script can use them.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://uwtxrgrydaxtglerdfxt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1-VR3k-YyepvDSHS4XCe4A_sbIldGMm';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
});
window.suprClient = sb;

// ─── Helpers ───────────────────────────────────────────────────────────
const byMcapDesc = (a, b) => (b.mcap || 0) - (a.mcap || 0);

// PostgREST hard-caps a response at 1000 rows (max-rows), and .limit(n) can't
// raise it — asking for 10000 still silently returns the first 1000. Any table
// that can exceed that must be paged with .range(). setup_hits (~1.8k) and
// regime_state (~4.5k) both do.
const PAGE = 1000;
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

// ─── Sector / industry lookup ─────────────────────────────────────────
// The flip / setup / extrema tables carry no sector column, so the browser
// joins against `universe` (written nightly by build_universe_3_5b.py). Fetched
// once and cached for the page's lifetime — sectors don't change intraday.
let _universePromise = null;
function universeMap() {
  if (!_universePromise) {
    _universePromise = fetchAll(() => sb.from('universe').select('symbol,sector,industry'))
      .then((rows) => {
        const m = new Map();
        for (const r of rows) m.set(r.symbol, { sector: r.sector, industry: r.industry });
        return m;
      })
      .catch((e) => {
        // A failed sector fetch must not blank the dashboard — fall back to an
        // empty map, which leaves every row unclassified but still rendered.
        console.error('universe fetch failed; sector filters will be empty:', e);
        return new Map();
      });
  }
  return _universePromise;
}

// Stamp sector/industry onto a row shape the renderer already speaks.
const withSector = (uni, sym, row) => {
  const u = uni.get(sym);
  row.sector   = u?.sector   || null;
  row.industry = u?.industry || null;
  return row;
};

const flipToRow = (r) => ({
  sym:   r.symbol,
  name:  r.name,
  mcap:  r.mcap,
  price: r.price,
  basis: r.basis,
  bxt_today: r.bxt_today,
  // Legacy renderer reads "<product>_streak" depending on which table the
  // row appeared in; we set both so either lookup works.
  fvb_streak: r.product === 'fvb' ? r.streak : null,
  bxt_streak: r.product === 'bxt' ? r.streak : null,
});

const setupHitToEntry = (h) => ({
  sym: h.symbol,
  name: h.name || '',
  mcap: h.mcap || 0,
  D: { regime: h.d_regime, age: h.d_age, ts: null, fired_g: !!h.d_fired_g, fired_r: !!h.d_fired_r, fired_g_plus: false, fired_r_plus: false },
  W: { regime: h.w_regime, age: h.w_age, ts: null, fired_g: !!h.w_fired_g, fired_r: !!h.w_fired_r, fired_g_plus: false, fired_r_plus: false },
  M: { regime: h.m_regime, age: h.m_age, ts: h.m_ts, fired_g: !!h.m_fired_g, fired_r: !!h.m_fired_r, fired_g_plus: false, fired_r_plus: false },
});

// The full sector -> industries tree the filter UI renders its checkboxes from.
// Built from `universe`, so it only ever offers sectors that real rows can have.
async function fetchSectorTree() {
  const uni = await universeMap();
  const tree = {};
  for (const { sector, industry } of uni.values()) {
    if (!sector) continue;
    (tree[sector] ||= new Set()).add(industry || 'Unclassified');
  }
  return Object.fromEntries(
    Object.keys(tree).sort().map((s) => [s, [...tree[s]].sort()])
  );
}

// ─── Flip results (Bands / BX greens & reds per timeframe) ────────────
async function fetchResults(timeframe) {
  const [data, uni] = await Promise.all([
    fetchAll(() => sb.from('flip_results').select('*').eq('timeframe', timeframe)),
    universeMap(),
  ]);

  const buckets = { fvb_green: [], fvb_red: [], bxt_green: [], bxt_red: [] };
  let latest = null;
  for (const r of data || []) {
    const key = `${r.product}_${r.side}`;
    if (buckets[key]) buckets[key].push(withSector(uni, r.symbol, flipToRow(r)));
    if (!latest || r.scanned_at > latest) latest = r.scanned_at;
  }
  for (const k of Object.keys(buckets)) buckets[k].sort(byMcapDesc);

  // Renderer also expects a `changes` object. We don't store per-snapshot
  // diffs in Supabase, so we return empty buckets. The "Changes since last
  // 5-min refresh" section renders empty until we add a client-side diff.
  return {
    updated_at: latest || new Date().toISOString(),
    timeframe,
    scan_seconds: null,
    scanned_count: data?.length ?? 0,
    ...buckets,
    changes: {
      compared_to: null,
      fvb_green_added: [], fvb_green_removed: [],
      fvb_red_added:   [], fvb_red_removed:   [],
      bxt_green_added: [], bxt_green_removed: [],
      bxt_red_added:   [], bxt_red_removed:   [],
    },
  };
}

// ─── LuxAlgo greens/reds per TF — derived from regime_state ───────────
async function fetchLux() {
  const [data, uni] = await Promise.all([
    fetchAll(() => sb
      .from('regime_state')
      .select('symbol,tf,name,mcap,ts,dsg,dsr,fired_g,fired_g_plus,fired_r,fired_r_plus,scanned_at')
      .or('fired_g.eq.true,fired_r.eq.true')),
    universeMap(),
  ]);

  const tfs = { D: { greens: [], reds: [] }, W: { greens: [], reds: [] }, M: { greens: [], reds: [] } };
  let latest = null;
  for (const r of data || []) {
    if (!tfs[r.tf]) continue;
    const row = withSector(uni, r.symbol, {
      sym: r.symbol, name: r.name || '', mcap: r.mcap || 0,
      trend_strength: r.ts != null ? r.ts.toFixed(2) : '',
      is_plus: !!(r.fired_g_plus || r.fired_r_plus),
      days_since_green: r.dsg, days_since_red: r.dsr,
    });
    if (r.fired_g) tfs[r.tf].greens.push(row);
    else if (r.fired_r) tfs[r.tf].reds.push(row);
    if (!latest || r.scanned_at > latest) latest = r.scanned_at;
  }
  for (const tf of Object.keys(tfs)) {
    tfs[tf].greens.sort(byMcapDesc);
    tfs[tf].reds.sort(byMcapDesc);
  }
  return {
    updated_at: latest || new Date().toISOString(),
    threshold_b: 3.5,
    tickers_in_scope: 0,
    timeframes: tfs,
  };
}

// ─── ATH / ATL events ──────────────────────────────────────────────────
async function fetchExtrema(kind) {
  const [data, uni] = await Promise.all([
    fetchAll(() => sb.from('extrema_events').select('*').eq('kind', kind)),
    universeMap(),
  ]);
  const list = [], accumulator = [];
  let latest = null;
  for (const r of data || []) {
    const row = withSector(uni, r.symbol, {
      sym: r.symbol, name: r.name || '', mcap: r.mcap || 0,
      price: r.price, [kind]: r.ath_or_atl,
      occurred_at: r.occurred_at,
    });
    if (r.is_today) list.push(row);
    else accumulator.push(row);
    if (!latest || r.scanned_at > latest) latest = r.scanned_at;
  }
  list.sort(byMcapDesc);
  accumulator.sort(byMcapDesc);
  return {
    updated_at: latest || new Date().toISOString(),
    count: list.length,
    list, accumulator,
  };
}

// ─── Setups + breadth ─────────────────────────────────────────────────
async function fetchSetups() {
  // setup_hits runs ~1.8k rows — it MUST be paged. The old .limit(10000) was
  // silently capped at 1000 by PostgREST, dropping ~45% of every setup group.
  const [meta, hits, breadth, uni] = await Promise.all([
    fetchAll(() => sb.from('setup_groups').select('*')),
    fetchAll(() => sb.from('setup_hits').select('*')),
    sb.from('breadth_snapshots').select('*').order('scanned_at', { ascending: false }).limit(1),
    universeMap(),
  ]);
  if (breadth.error) throw breadth.error;

  // Reshape into the legacy setups.json schema the renderer already speaks.
  const group_meta = {};
  for (const g of meta || []) {
    group_meta[g.group_key] = {
      name: g.name, kind: g.kind, rule: g.rule, summary: g.summary,
    };
  }

  const groups = {};
  for (const k of Object.keys(group_meta)) groups[k] = [];
  let latest = null;
  for (const h of hits || []) {
    if (!groups[h.group_key]) groups[h.group_key] = [];
    groups[h.group_key].push(withSector(uni, h.symbol, setupHitToEntry(h)));
    if (!latest || h.scanned_at > latest) latest = h.scanned_at;
  }
  // Sort by M trend strength desc, fall back to mcap.
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => {
      const ats = a.M?.ts, bts = b.M?.ts;
      if (ats != null && bts != null) return bts - ats;
      if (ats == null && bts != null) return 1;
      if (bts == null && ats != null) return -1;
      return (b.mcap || 0) - (a.mcap || 0);
    });
  }

  const b = (breadth.data && breadth.data[0]) || {};
  return {
    updated_at: latest || b.scanned_at || new Date().toISOString(),
    source_updated_at: b.scanned_at || null,
    threshold_b: b.threshold_b ?? 3.5,
    universe_size: b.universe_size ?? 0,
    breadth: {
      universe_size:     b.universe_size,
      pct_M_green:       b.pct_m_green,
      pct_M_red:         b.pct_m_red,
      pct_MW_green:      b.pct_mw_green,
      pct_MW_red:        b.pct_mw_red,
      pct_full_bull:     b.pct_full_bull,
      pct_full_bear:     b.pct_full_bear,
      D_fires_g_today:   b.d_fires_g_today,
      D_fires_r_today:   b.d_fires_r_today,
      W_fires_g_today:   b.w_fires_g_today,
      W_fires_r_today:   b.w_fires_r_today,
      M_fires_g_today:   b.m_fires_g_today,
      M_fires_r_today:   b.m_fires_r_today,
    },
    group_meta,
    groups,
  };
}

// ─── Realtime — re-trigger the page's load() on relevant table writes ─
// The main script's load() is exposed on window during init; we just call
// it. Channels filter so we only re-fetch when data the user is looking at
// actually changed. Reconnects automatically on websocket drop.
function subscribeAll(onReload) {
  const channels = [
    sb.channel('flip_results-all')      .on('postgres_changes', { event: '*', schema: 'public', table: 'flip_results'      }, onReload).subscribe(),
    sb.channel('regime_state-all')      .on('postgres_changes', { event: '*', schema: 'public', table: 'regime_state'      }, onReload).subscribe(),
    sb.channel('setup_hits-all')        .on('postgres_changes', { event: '*', schema: 'public', table: 'setup_hits'        }, onReload).subscribe(),
    sb.channel('breadth_snapshots-all') .on('postgres_changes', { event: '*', schema: 'public', table: 'breadth_snapshots' }, onReload).subscribe(),
    sb.channel('extrema_events-all')    .on('postgres_changes', { event: '*', schema: 'public', table: 'extrema_events'    }, onReload).subscribe(),
  ];
  return () => channels.forEach((c) => sb.removeChannel(c));
}

window.suprAdapter = {
  fetchResults, fetchLux, fetchExtrema, fetchSetups, fetchSectorTree, subscribeAll,
};
