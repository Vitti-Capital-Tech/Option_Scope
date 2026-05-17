import os

code = """
export default function ATMExitTrading({ onNavigate, theme, toggleTheme }) {
  const [config, setConfig] = useState(() => ({
    underlying: 'BTC',
    expiry: '',
    minStrikeDiff: 800,
    minIvDiff: 5,
    maxRatioDeviation: 0.25,
    minSellPremium: 10,
    maxNetPremium: 20,
    minLongDist: 500,
    maxSellQty: 10,
  }));

  const underlying = config.underlying;
  const selExpiry = config.expiry;

  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [spotPrice, setSpotPrice] = useState(null);
  const [trading, setTrading] = useState(false);

  const [includeFees, setIncludeFees] = useState(true);
  const [positions, setPositions] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  
  // Analytics State
  const [analyticsData, setAnalyticsData] = useState({}); // { '0_2_5': [], ... }
  const [showTotalMode, setShowTotalMode] = useState(false); // Toggle for avg vs total

  // Core entry tracking
  const lastEntrySpotRef = useRef({ call: null, put: null });

  const [historyFilterDate, setHistoryFilterDate] = useState(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    return d.toISOString().split('T')[0];
  });

  const adjustFilterDay = (offset) => {
    if (!historyFilterDate) return;
    const [y, m, d] = historyFilterDate.split('-').map(Number);
    const current = new Date(Date.UTC(y, m - 1, d));
    current.setUTCDate(current.getUTCDate() + offset);
    setHistoryFilterDate(current.toISOString().split('T')[0]);
  };

  const resetToToday = () => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    setHistoryFilterDate(d.toISOString().split('T')[0]);
  };

  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});

  const wsRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const lastEvaluatedRef = useRef(0);
  const lastDbWriteRef = useRef(0);
  const [lastEvaluated, setLastEvaluated] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(null);
  
  const positionsRef = useRef([]);
  const isEvaluatingRef = useRef(false);
  const lastWsSymbolsRef = useRef('');
  useEffect(() => { positionsRef.current = positions; }, [positions]);

  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    latestTickerDataRef.current = { ...latestTickerDataRef.current, ...buffered };
    setTickerData({ ...latestTickerDataRef.current });
  }, []);

  const refreshProducts = useCallback(async () => {
    try {
      const prods = await loadProducts(underlying);
      setProducts(prods);
      const exps = getExpiries(prods);
      setExpiries(exps);
      if (exps.length && (!selExpiry || !exps.includes(selExpiry))) {
        updateConfig('expiry', exps[0]);
      }
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying, selExpiry]);

  useEffect(() => {
    setExpiries([]);
    setTickerData({});
    refreshProducts();
  }, [underlying]);

  const saveSupabaseConfig = useCallback(async (newCfg) => {
    try {
      await supabase.from('atm_exit_config').upsert({
        id: 'global',
        underlying: newCfg.underlying,
        expiry: newCfg.expiry,
        min_strike_diff: newCfg.minStrikeDiff,
        min_iv_diff: newCfg.minIvDiff,
        max_ratio_deviation: newCfg.maxRatioDeviation,
        min_sell_premium: newCfg.minSellPremium,
        max_net_premium: newCfg.maxNetPremium,
        min_long_dist: newCfg.minLongDist,
        max_sell_qty: newCfg.maxSellQty,
        updated_at: new Date().toISOString()
      });
    } catch (e) { }
  }, []);

  const updateConfig = (keyOrObj, value) => {
    setConfig(c => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      const newConfig = { ...c, ...updates };
      tabBroadcast('ATM_EXIT_CONFIG_SYNC', { config: newConfig });
      saveSupabaseConfig(newConfig);
      return newConfig;
    });
  };

  const fetchSupabaseActivePositions = useCallback(async () => {
    try {
      if (Date.now() - lastDbWriteRef.current < 10000) return;
      const { data, error } = await supabase
        .from('atm_exit_active_positions')
        .select('*')
        .order('entry_time', { ascending: true });

      if (error) { console.error('Error fetching active positions:', error); return; }

      if (data && data.length > 0) {
        setPositions(prev => {
          const prevMap = new Map(prev.map(p => [p.id, p]));
          const mapped = data.map(p => {
            const existing = prevMap.get(p.id);
            const buyLeg = safeParseLeg(p.buy_leg);
            const sellLeg = safeParseLeg(p.sell_leg);
            return {
              id: p.id, underlying: p.underlying, expiry: p.expiry, type: p.type,
              buyLeg, sellLeg,
              sellQty: p.sell_qty, strikeDiff: p.strike_diff, entryTime: new Date(p.entry_time),
              entryBuyPrice: p.entry_buy_price, entrySellPrice: p.entry_sell_price,
              entrySpotPrice: p.entry_spot_price,
              margin: p.margin || 0, entryFee: p.entry_fee || 0, accumulatedSellPnl: p.accumulated_sell_pnl || 0,
              currentBuyPrice: existing?.currentBuyPrice ?? null,
              currentSellPrice: existing?.currentSellPrice ?? null,
              unrealizedGrossPnl: existing?.unrealizedGrossPnl ?? 0,
              unrealizedNetPnl: existing?.unrealizedNetPnl ?? -(p.entry_fee || 0),
              currentExitFee: existing?.currentExitFee ?? 0,
              currentTotalFees: existing?.currentTotalFees ?? (p.entry_fee || 0),
            };
          });

          return mapped.filter(p => p.buyLeg && p.sellLeg).sort((a, b) => {
            if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
            if (a.type === 'call') return a.buyLeg.strike - b.buyLeg.strike;
            return b.buyLeg.strike - a.buyLeg.strike;
          });
        });
      } else if (data) {
        setPositions([]);
      }
    } catch (e) { console.error('Fetch Active Error:', e); }
  }, [underlying, selExpiry]);

  const fetchSupabaseConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase.from('atm_exit_config').select('*').eq('id', 'global').maybeSingle();
      if (data && !error) {
        setConfig({
          underlying: data.underlying || 'BTC',
          expiry: data.expiry || '',
          minStrikeDiff: data.min_strike_diff,
          minIvDiff: data.min_iv_diff,
          maxRatioDeviation: data.max_ratio_deviation,
          minSellPremium: data.min_sell_premium,
          maxNetPremium: data.max_net_premium,
          minLongDist: data.min_long_dist || 500,
          maxSellQty: data.max_sell_qty || 10
        });
      }
    } catch (e) { }
  }, []);

  const fetchSupabaseTradeHistory = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('atm_exit_trade_history')
        .select('*')
        .eq('underlying', underlying)
        .order('exit_time', { ascending: false });

      if (error) return;
      if (data) {
        const mapped = data.map(t => ({
          id: t.trade_id || t.id,
          underlying: t.underlying, expiry: t.expiry, type: t.type,
          buyLeg: safeParseLeg(t.buy_leg), sellLeg: safeParseLeg(t.sell_leg),
          sellQty: t.sell_qty, strikeDiff: t.strike_diff,
          entryTime: new Date(t.entry_time), exitTime: new Date(t.exit_time),
          entryBuyPrice: t.entry_buy_price, entrySellPrice: t.entry_sell_price,
          exitBuyPrice: t.exit_buy_price, exitSellPrice: t.exit_sell_price,
          entrySpotPrice: t.entry_spot_price, exitSpotPrice: t.exit_spot_price,
          margin: t.margin, realizedGrossPnl: t.realized_gross_pnl, realizedNetPnl: t.realized_net_pnl,
          exitFee: t.exit_fee, totalFees: t.total_fees, entryFee: (t.total_fees || 0) - (t.exit_fee || 0),
          exitReason: t.exit_reason,
        }));
        setTradeHistory(mapped);
      }
    } catch (e) { }
  }, [underlying]);

  const fetchAnalytics = useCallback(async () => {
    const buckets = ['atm_exit_qty_0_2_5', 'atm_exit_qty_2_5_5', 'atm_exit_qty_5_7_5', 'atm_exit_qty_7_5_10'];
    const results = {};
    for (const b of buckets) {
      const { data } = await supabase.from(b).select('*').eq('underlying', underlying).order('strike_diff');
      results[b] = data || [];
    }
    setAnalyticsData(results);
  }, [underlying]);

  useEffect(() => {
    if (!trading) return;
    fetchSupabaseActivePositions();
    fetchSupabaseTradeHistory();
    fetchSupabaseConfig();
    fetchAnalytics();
    const interval = setInterval(() => {
      fetchSupabaseActivePositions();
      fetchSupabaseTradeHistory();
      fetchAnalytics();
    }, 10000);
    return () => clearInterval(interval);
  }, [trading, fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchSupabaseConfig, fetchAnalytics]);

  useEffect(() => {
    const fetchSpot = () => {
      getSpotPrice(underlying)
        .then(sp => { if (sp) setSpotPrice(sp); })
        .catch(() => { });
    };
    fetchSpot();
    spotIntervalRef.current = setInterval(fetchSpot, 10000);
    return () => clearInterval(spotIntervalRef.current);
  }, [underlying]);
"""

with open('src/ATMExitTrading.jsx', 'a', encoding='utf-8') as f:
    f.write(code)

print("Part 2 written successfully.")
