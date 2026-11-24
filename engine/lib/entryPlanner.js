// Entry planner — which short (and hedge) each candidate long strike gets, and the call/put
// entry order.
//
// A strike hosts ONE main leg per account (long or short, cross-role). Each long strike has a
// list of valid shorts (best first: ATM ROI, or net credit in Max Net Credit mode). Picking the
// best short per long independently made several longs want the SAME short (e.g. 62400, 62800,
// 63000 all best with 64600): the first took it and the others were skipped in that minute, so
// the engine entered farther longs instead (JD Algo, 2026-11-24). The planner instead looks at
// all longs together and chooses the shorts so that, in order of priority:
//   1. as many spreads as possible fit in the free slots (k),
//   2. the longs used are the nearest ones (entry order: nearest ATM, or highest credit),
//   3. the total score (ATM ROI, or credit in credit mode) of the chosen options is the highest.
//
// Hedges (live, Hedge Leg on): a hedge strike may not be any spread's long or short, but several
// hedges may share a strike. With `hedgesOf`, every pick also chooses one hedge from its list,
// so the plan never puts a hedge on a strike another planned spread needs as long/short (the
// hedge used to be chosen at entry, after the shorts, and could take a nearer long's short).
// Pure functions, no engine state. Kill switch: ENTRY_PLANNER_OFF=1 (paperTradingEngine.js).

const strikeOf = (leg) => Number(leg?.strike);

// groups: [{ long: number, opts: [spread] }] in entry order (index 0 = most preferred long);
//   opts best first. A spread is { buyLeg: { strike }, sellLeg: { strike }, ... }.
// k: free slots for this type. preTaken: strikes no main leg may use this minute (open hedges,
//   shared-long picks).
// hedgesOf(spread): null/undefined = no hedge; else the spread's hedge options, preferred first,
//   each { strike, ... } — an empty list makes the spread unusable (hedge required).
// metric(spread, hedge): the tiebreak score.
// Returns { picks: [{ gi, spread, hedge }] (by gi), nodes, exhausted } — exhausted = search
// budget hit (the best plan found so far is returned; the first plan explored is the greedy one).
export function planMaxSpreads(groups, k, {
  preTaken = [],
  hedgesOf = null,
  metric = (s) => Number(s.roi) || 0,
  nodeLimit = 5000,
} = {}) {
  const used = new Set((preTaken || []).map(Number)); // strikes taken by a main leg (or reserved)
  const hedgeUse = new Map();                          // hedge strike → number of picks using it
  const pick = [];
  let best = null;
  let nodes = 0;
  let exhausted = false;
  if (!(k > 0) || !groups.length) return { picks: [], nodes, exhausted };

  // a is better than b? count ↑, then index vector lexicographically ↓, then score ↑.
  const better = (a, b) => {
    if (!b) return true;
    if (a.count !== b.count) return a.count > b.count;
    for (let i = 0; i < a.count; i++) if (a.idx[i] !== b.idx[i]) return a.idx[i] < b.idx[i];
    return a.score > b.score + 1e-9;
  };
  // The current partial pick can no longer beat `best` on the index vector (same count).
  // Same longs as `best` so far and the branch can only pick from longs AFTER the next one
  // `best` used → every completion has a worse index vector.
  const prefixWorse = (gi) => {
    if (!best || best.count !== k) return false;
    for (let i = 0; i < pick.length; i++) {
      if (pick[i].gi !== best.idx[i]) return pick[i].gi > best.idx[i];
    }
    return pick.length < best.count && gi > best.idx[pick.length];
  };
  const mainFree = (s) => !used.has(s) && !hedgeUse.get(s);

  const dfs = (gi) => {
    if (exhausted) return;
    if (++nodes > nodeLimit) { exhausted = true; return; }
    if (pick.length === k || gi === groups.length) {
      const cand = {
        count: pick.length,
        idx: pick.map(p => p.gi),
        score: pick.reduce((s, p) => s + metric(p.spread, p.hedge), 0),
        picks: pick.slice(),
      };
      if (better(cand, best)) best = cand;
      return;
    }
    if (best && pick.length + (groups.length - gi) < best.count) return; // can't reach best count
    if (prefixWorse(gi)) return;
    const g = groups[gi];
    const b = Number(g.long);
    if (mainFree(b)) {
      for (const s of g.opts) {
        const x = strikeOf(s.sellLeg);
        if (x === b || !mainFree(x)) continue;
        const hedges = hedgesOf ? hedgesOf(s) : null;
        const choices = hedges == null ? [null] : hedges;
        used.add(b); used.add(x);
        for (const h of choices) {
          const hs = h == null ? null : Number(h.strike);
          if (hs != null && (used.has(hs) || hs === b || hs === x)) continue;
          if (hs != null) hedgeUse.set(hs, (hedgeUse.get(hs) || 0) + 1);
          pick.push({ gi, spread: s, hedge: h });
          dfs(gi + 1);
          pick.pop();
          if (hs != null) { const c = hedgeUse.get(hs) - 1; if (c > 0) hedgeUse.set(hs, c); else hedgeUse.delete(hs); }
          if (exhausted) break;
        }
        used.delete(b); used.delete(x);
        if (exhausted) return;
      }
    }
    dfs(gi + 1); // leave this long out
  };
  dfs(0);
  return { picks: best ? best.picks : [], nodes, exhausted };
}

// Call/put take turns: C, P, C, P … (each unit = one long strike's spread(s), kept together).
// `first` = 'call' | 'put' — which type goes first. A type that runs out leaves the rest to the other.
export function interleaveUnits(callUnits, putUnits, first = 'call') {
  const a = first === 'put' ? putUnits : callUnits;
  const b = first === 'put' ? callUnits : putUnits;
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}
