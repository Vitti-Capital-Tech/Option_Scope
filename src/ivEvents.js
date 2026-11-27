// IV Analysis helpers (pure, no React): timeframe bars, moving average, IV spikes and stable
// periods. All work on the page's per-minute points ({ t, [seriesKey], spot, atmStrike, … }).

const MIN = 60_000;

// Per-minute points → bars of `minutes` (1 = unchanged). A bar is stamped at its start and
// carries the LAST minute's fields (spot, ATM strike, call / put IV) plus the series' open /
// high / low / close; `dIv` and `strikeMove` are vs the previous bar.
export function bucketize(points, seriesKey, minutes) {
  const pts = points.filter(p => p[seriesKey] != null);
  if (minutes <= 1) {
    return pts.map(p => ({ ...p, open: p[seriesKey], high: p[seriesKey], low: p[seriesKey], close: p[seriesKey], bars: 1 }));
  }
  const size = minutes * MIN;
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const prev = out[out.length - 1];
    const close = cur.last[seriesKey];
    out.push({
      ...cur.last,
      t: cur.start,
      open: cur.first[seriesKey], high: cur.high, low: cur.low, close,
      [seriesKey]: close,
      dIv: prev ? close - prev.close : null,
      dSpot: prev && cur.last.spot != null && prev.spot != null ? cur.last.spot - prev.spot : null,
      strikeMove: prev && cur.last.atmStrike !== prev.atmStrike ? cur.last.atmStrike - prev.atmStrike : 0,
      bars: cur.n,
    });
  };
  for (const p of pts) {
    const start = Math.floor(p.t / size) * size;
    const v = p[seriesKey];
    if (!cur || cur.start !== start) {
      flush();
      cur = { start, first: p, last: p, high: v, low: v, n: 1 };
    } else {
      cur.last = p;
      if (v > cur.high) cur.high = v;
      if (v < cur.low) cur.low = v;
      cur.n += 1;
    }
  }
  flush();
  return out;
}

// Simple moving average of `close` over `len` bars (null until `len` bars exist).
export function movingAverage(bars, len) {
  if (!(len > 1)) return bars.map(() => null);
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= len) sum -= bars[i - len].close;
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

// IV spikes on per-minute data. A minute is a spike-UP minute when its IV is at least
// `threshold` points above the LOWEST IV of the previous `windowMin` minutes (DOWN: below the
// highest). Consecutive flagged minutes of the same direction (≤ 2 min apart) form one spike:
// from the window low / high that started it to the peak / trough reached.
export function detectSpikes(points, seriesKey, { windowMin = 15, threshold = 1 } = {}) {
  const s = points.filter(p => p[seriesKey] != null);
  const flags = [];
  let lo = 0;
  for (let i = 0; i < s.length; i++) {
    while (lo < i && s[i].t - s[lo].t > windowMin * MIN) lo++;
    if (lo === i) continue;
    let minJ = lo, maxJ = lo;
    for (let j = lo; j < i; j++) {
      if (s[j][seriesKey] < s[minJ][seriesKey]) minJ = j;
      if (s[j][seriesKey] > s[maxJ][seriesKey]) maxJ = j;
    }
    const v = s[i][seriesKey];
    if (v - s[minJ][seriesKey] >= threshold) flags.push({ i, dir: 'up', from: minJ });
    else if (s[maxJ][seriesKey] - v >= threshold) flags.push({ i, dir: 'down', from: maxJ });
  }
  const spikes = [];
  for (const f of flags) {
    const last = spikes[spikes.length - 1];
    if (last && last.dir === f.dir && s[f.i].t - s[last.endIdx].t <= 2 * MIN) {
      last.endIdx = f.i;
      // The peak moves only on a real new high / low (≥ 10% of the threshold), so noise after the
      // move doesn't drag it to a later minute.
      const v = s[f.i][seriesKey];
      const eps = threshold * 0.1;
      if (f.dir === 'up' ? v > s[last.peakIdx][seriesKey] + eps : v < s[last.peakIdx][seriesKey] - eps) last.peakIdx = f.i;
    } else {
      spikes.push({ dir: f.dir, startIdx: f.from, endIdx: f.i, peakIdx: f.i });
    }
  }
  return spikes.map(sp => {
    const a = s[sp.startIdx], b = s[sp.peakIdx], e = s[sp.endIdx];
    return {
      kind: 'spike', dir: sp.dir,
      start: a.t, peak: b.t, end: e.t,
      minutes: Math.round((b.t - a.t) / MIN),
      from: a[seriesKey], to: b[seriesKey], change: b[seriesKey] - a[seriesKey],
      spotFrom: a.spot, spotTo: b.spot,
      strikeFrom: a.atmStrike, strikeTo: b.atmStrike,
    };
  });
}

// Stable periods: stretches of at least `minMinutes` in which the IV stayed inside a band of
// `band` points (max − min ≤ band), with no data gap longer than `gapMs`. Greedy, left to
// right: each period is extended as far as the band allows, then the next one starts after it.
export function detectStable(points, seriesKey, { band = 0.5, minMinutes = 30, gapMs = 3 * MIN } = {}) {
  const s = points.filter(p => p[seriesKey] != null);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let lo = s[i][seriesKey], hi = lo, sum = lo, j = i;
    while (j + 1 < s.length) {
      const nx = s[j + 1];
      if (nx.t - s[j].t > gapMs) break;
      const v = nx[seriesKey];
      const nlo = Math.min(lo, v), nhi = Math.max(hi, v);
      if (nhi - nlo > band) break;
      lo = nlo; hi = nhi; sum += v; j += 1;
    }
    const minutes = Math.round((s[j].t - s[i].t) / MIN);
    if (minutes >= minMinutes) {
      out.push({
        kind: 'stable', start: s[i].t, end: s[j].t, minutes,
        from: s[i][seriesKey], to: s[j][seriesKey], change: s[j][seriesKey] - s[i][seriesKey],
        low: lo, high: hi, avg: sum / (j - i + 1),
        spotFrom: s[i].spot, spotTo: s[j].spot,
        strikeFrom: s[i].atmStrike, strikeTo: s[j].atmStrike,
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out;
}
