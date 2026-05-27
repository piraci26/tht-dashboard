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

// ─── Flip results (Bands / BX greens & reds per timeframe) ────────────
async function fetchResults(timeframe) {
  const { data, error } = await sb
    .from('flip_results')
    .select('*')
    .eq('timeframe', timeframe);
  if (error) throw error;

  const buckets = { fvb_green: [], fvb_red: [], bxt_green: [], bxt_red: [] };
  let latest = null;
  for (const r of data || []) {
    const key = `${r.product}_${r.side}`;
    if (buckets[key]) buckets[key].push(flipToRow(r));
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
  const { data, error } = await sb
    .from('regime_state')
    .select('symbol,tf,name,mcap,ts,dsg,dsr,fired_g,fired_g_plus,fired_r,fired_r_plus,scanned_at')
    .or('fired_g.eq.true,fired_r.eq.true');
  if (error) throw error;

  const tfs = { D: { greens: [], reds: [] }, W: { greens: [], reds: [] }, M: { greens: [], reds: [] } };
  let latest = null;
  for (const r of data || []) {
    if (!tfs[r.tf]) continue;
    const row = {
      sym: r.symbol, name: r.name || '', mcap: r.mcap || 0,
      trend_strength: r.ts != null ? r.ts.toFixed(2) : '',
      is_plus: !!(r.fired_g_plus || r.fired_r_plus),
      days_since_green: r.dsg, days_since_red: r.dsr,
    };
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
  const { data, error } = await sb
    .from('extrema_events')
    .select('*')
    .eq('kind', kind);
  if (error) throw error;
  const list = [], accumulator = [];
  let latest = null;
  for (const r of data || []) {
    const row = {
      sym: r.symbol, name: r.name || '', mcap: r.mcap || 0,
      price: r.price, [kind]: r.ath_or_atl,
      occurred_at: r.occurred_at,
    };
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
  const [meta, hits, breadth] = await Promise.all([
    sb.from('setup_groups').select('*'),
    sb.from('setup_hits').select('*').limit(10000),
    sb.from('breadth_snapshots').select('*').order('scanned_at', { ascending: false }).limit(1),
  ]);
  if (meta.error)    throw meta.error;
  if (hits.error)    throw hits.error;
  if (breadth.error) throw breadth.error;

  // Reshape into the legacy setups.json schema the renderer already speaks.
  const group_meta = {};
  for (const g of meta.data || []) {
    group_meta[g.group_key] = {
      name: g.name, kind: g.kind, rule: g.rule, summary: g.summary,
    };
  }

  const groups = {};
  for (const k of Object.keys(group_meta)) groups[k] = [];
  let latest = null;
  for (const h of hits.data || []) {
    if (!groups[h.group_key]) groups[h.group_key] = [];
    groups[h.group_key].push(setupHitToEntry(h));
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
  fetchResults, fetchLux, fetchExtrema, fetchSetups, subscribeAll,
};
