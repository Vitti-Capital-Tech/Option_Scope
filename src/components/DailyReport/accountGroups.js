// Accounts whose names differ only by a trailing number (Shubham / Shubham2, Pk / PK 2) form a
// name group; case, spaces and punctuation are ignored (JD Algo / JD algo2 / JDAlgo-3). Groups of
// 2+ get their own entry in the account picker: selected, it combines its members like "All live
// accounts", and each member can still be opened on its own. Shared by the Daily Report and the
// Slippage tab.
export function buildNameGroups(accounts) {
  const by = new Map();
  accounts.forEach(a => {
    const base = String(a.name ?? '').trim().replace(/[\s_-]*\d+$/, '').trim();
    const key = base.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key) return;
    if (!by.has(key)) by.set(key, { key: `group:${key}`, label: base, ids: [], names: [] });
    const g = by.get(key);
    g.ids.push(a.id);
    g.names.push(a.name);
  });
  return [...by.values()].filter(g => g.ids.length > 1);
}
