import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useForm } from 'react-hook-form';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, apiGet, getTickers
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime, formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';

const UNDERLYINGS = ['BTC', 'ETH'];
const HEARTBEAT_ONLINE_THRESHOLD = 60000;
const HEARTBEAT_STALE_THRESHOLD = 120000;

const calculateFee = (price, spot, qty, lotSize) => {
  if (!price || !spot) return 0;
  const feePerUnit = Math.min(0.035 * price, 0.0001 * spot);
  return feePerUnit * qty * lotSize;
};

const safeParseLeg = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (e) { return null; }
  }
  return null;
};

export default function PaperTrading({ onNavigate, theme, toggleTheme }) {
  const [accounts, setAccounts] = useState([]);
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [configDbId, setConfigDbId] = useState(null);

  // Authentication & RBAC States
  const [session, setSession] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [profiles, setProfiles] = useState([]); // Loaded only for admin users
  const [isAccountsLoaded, setIsAccountsLoaded] = useState(false);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isSavingAccount, setIsSavingAccount] = useState(false);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [accountToDeleteId, setAccountToDeleteId] = useState(null);

  const {
    register: registerCreate,
    handleSubmit: handleSubmitCreate,
    formState: { errors: errorsCreate },
    reset: resetCreate,
    watch: watchCreate
  } = useForm({
    defaultValues: {
      name: '',
      balance: 10000,
      ownerId: '',
      underlying: 'BTC',
      minStrikeDiff: 800,
      minIvDiff: 5,
      maxRatioDeviation: 0.25,
      minSellPremium: 10,
      maxNetPremium: 20,
      minLongDist: 500,
      maxSellQty: 10,
      atmRatioScaling: false,
      atmRatioPctCall: 50,
      atmRatioPctPut: 50,
      daysToExpiry: 0,
    }
  });

  const watchCreateAtmRatioScaling = watchCreate('atmRatioScaling');

  const {
    register: registerEdit,
    handleSubmit: handleSubmitEdit,
    formState: { errors: errorsEdit },
    reset: resetEdit
  } = useForm();

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
    atmRatioScaling: false,
    atmRatioPctCall: 50,
    atmRatioPctPut: 50,
    daysToExpiry: 0,
  }));
  const [draftConfig, setDraftConfig] = useState(() => ({ ...config }));
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => window.innerWidth <= 900);

  const underlying = config.underlying;
  const selExpiry = config.expiry;

  const [products, setProducts] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [spotPrice, setSpotPrice] = useState(null);

  const filteredExpiries = React.useMemo(() => {
    if (!expiries || expiries.length === 0) return [];
    const minDays = config?.daysToExpiry || 0;
    const filtered = expiries.filter(exp => {
      const daysRemaining = (new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      return daysRemaining >= minDays;
    });
    return filtered.length > 0 ? filtered : expiries;
  }, [expiries, config?.daysToExpiry]);

  const [engineStatus, setEngineStatus] = useState({ status: 'offline', lastHeartbeat: null, data: null });

  const [includeFees, setIncludeFees] = useState(true);
  const [positions, setPositions] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);

  const [historyFilterDate, setHistoryFilterDate] = useState(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    return d.toISOString().split('T')[0];
  });

  const [lastEvaluated, setLastEvaluated] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // ── Authentication & Profiles Hooks ─────────────────────────────────
  useEffect(() => {
    // Check initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (!session) {
        setIsAuthLoading(false);
      }
    });

    // Listen to changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (!session) {
        setIsAuthLoading(false);
        setUserProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;

    const fetchProfile = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .single();
        
        if (data) {
          setUserProfile(data);
        } else if (error && error.code === 'PGRST116') {
          // Fallback: profile not created yet, let's create it on the fly
          const { data: newProfile, error: createError } = await supabase
            .from('profiles')
            .insert([{ id: session.user.id, email: session.user.email, role: 'client' }])
            .select('*')
            .single();
          if (newProfile && !createError) {
            setUserProfile(newProfile);
          } else {
            console.error('Failed to auto-create profile:', createError);
          }
        }
      } catch (err) {
        console.error('Error fetching profile:', err);
      } finally {
        setIsAuthLoading(false);
      }
    };

    fetchProfile();
  }, [session]);

  useEffect(() => {
    if (userProfile?.role === 'admin') {
      const fetchAllProfiles = async () => {
        const { data } = await supabase
          .from('profiles')
          .select('id, email')
          .order('email', { ascending: true });
        if (data) {
          setProfiles(data);
        }
      };
      fetchAllProfiles();
    } else {
      setProfiles([]);
    }
  }, [userProfile]);

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      setIsAccountsLoaded(false);
      setAccounts([]);
    } catch (e) {
      console.error('Logout error:', e);
    }
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthenticating(true);

    const email = authEmail.trim().toLowerCase();
    if (!email) {
      setAuthError('Please enter a valid email address.');
      setIsAuthenticating(false);
      return;
    }

    // Deterministically derive a secure password based on the email
    const cleanEmail = email.replace(/[^a-z0-9]/g, '');
    const derivedPassword = `OptionScope_${cleanEmail}_Secure123!`;

    try {
      // 1. Try to sign up first
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password: derivedPassword,
      });

      if (signUpError) {
        // If user already exists, try to log in
        if (signUpError.message.includes('already exists') || signUpError.code === 'user_already_exists') {
          const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
            email,
            password: derivedPassword,
          });

          if (signInError) {
            if (signInError.message.includes('confirm') || signInError.code === 'email_not_confirmed') {
              setAuthError('Email needs to be confirmed or email confirmation should be disabled in Supabase settings.');
            } else {
              setAuthError(signInError.message);
            }
          }
        } else if (signUpError.message.includes('confirm') || signUpError.code === 'email_not_confirmed') {
          setAuthError('Email needs to be confirmed or email confirmation should be disabled in Supabase settings.');
        } else {
          setAuthError(signUpError.message);
        }
      } else if (signUpData?.user) {
        // Auto-create local profile
        try {
          await supabase
            .from('profiles')
            .insert([{ id: signUpData.user.id, email: signUpData.user.email, role: 'client' }]);
        } catch (pe) {
          console.error('Local profile insert error:', pe);
        }

        // If a session was not started automatically, log in
        if (!signUpData.session) {
          const { error: retryError } = await supabase.auth.signInWithPassword({
            email,
            password: derivedPassword,
          });
          if (retryError) {
            if (retryError.message.includes('confirm') || retryError.code === 'email_not_confirmed') {
              setAuthError('Email needs to be confirmed or email confirmation should be disabled in Supabase settings.');
            } else {
              setAuthError(retryError.message);
            }
          }
        }
      }
    } catch (err) {
      setAuthError('An unexpected authentication error occurred.');
      console.error(err);
    } finally {
      setIsAuthenticating(false);
    }
  };

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


  // ── Ticker data (read-only, for live PnL display) ─────────────────────
  const [tickerData, setTickerData] = useState({});
  const latestTickerDataRef = useRef({});
  const wsRef = useRef(null);
  const spotIntervalRef = useRef(null);
  const tickerBufferRef = useRef({});
  const flushTimerRef = useRef(null);
  const lastDbWriteRef = useRef(0);
  const latestSpotPriceRef = useRef(null);

  const flushTickerBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buffered = tickerBufferRef.current;
    if (!Object.keys(buffered).length) return;
    tickerBufferRef.current = {};
    latestTickerDataRef.current = { ...latestTickerDataRef.current, ...buffered };
    setTickerData({ ...latestTickerDataRef.current });
  }, []);

  // ── Product + expiry (UI display only, server manages its own copy) ───
  const refreshProducts = useCallback(async () => {
    try {
      const prods = await loadProducts(underlying);
      setProducts(prods);
      const exps = getExpiries(prods);
      setExpiries(exps);
      if (isConfigLoaded && exps.length) {
        let isExpiryInvalid = !selExpiry || !exps.includes(selExpiry);
        if (!isExpiryInvalid && selExpiry) {
          const daysRemaining = (new Date(selExpiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining < (config.daysToExpiry || 0)) {
            isExpiryInvalid = true;
          }
        }
        if (isExpiryInvalid) {
          let selectedExpiry = null;
          for (const exp of exps) {
            const daysRemaining = (new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
            if (daysRemaining >= (config.daysToExpiry || 0)) {
              selectedExpiry = exp;
              break;
            }
          }
          if (!selectedExpiry) {
            selectedExpiry = exps[0];
          }
          updateConfig('expiry', selectedExpiry);
        }
      }
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying, selExpiry, isConfigLoaded, config.daysToExpiry]);

  // Validate expiry when config and products are loaded
  useEffect(() => {
    if (isConfigLoaded && products.length > 0) {
      const exps = getExpiries(products);
      if (exps.length) {
        let isExpiryInvalid = !selExpiry || !exps.includes(selExpiry);
        if (!isExpiryInvalid && selExpiry) {
          const daysRemaining = (new Date(selExpiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining < (config.daysToExpiry || 0)) {
            isExpiryInvalid = true;
          }
        }
        if (isExpiryInvalid) {
          let selectedExpiry = null;
          for (const exp of exps) {
            const daysRemaining = (new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
            if (daysRemaining >= (config.daysToExpiry || 0)) {
              selectedExpiry = exp;
              break;
            }
          }
          if (!selectedExpiry) {
            selectedExpiry = exps[0];
          }
          updateConfig('expiry', selectedExpiry);
        }
      }
    }
  }, [isConfigLoaded, products, selExpiry, config.daysToExpiry]);

  useEffect(() => {
    setExpiries([]);
    setTickerData({});
    refreshProducts();
  }, [underlying]);

  useEffect(() => {
    const interval = setInterval(refreshProducts, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refreshProducts]);

  // ── Load accounts ──────────────────────────────────────────────────────
  const fetchAccounts = useCallback(async () => {
    if (!userProfile) return;
    try {
      let query = supabase.from('paper_trading_accounts').select('*');
      if (userProfile.role === 'client') {
        query = query.eq('user_id', session?.user?.id);
      }
      const { data, error } = await query.order('created_at', { ascending: true });
      if (data && !error) {
        setAccounts(data);
        if (data.length > 0) {
          setActiveAccountId(prev => {
            if (prev && data.some(a => a.id === prev)) return prev;
            return data[0].id;
          });
        } else {
          setActiveAccountId(null);
        }
        try {
          const ch = new BroadcastChannel('option-scope-sync');
          ch.postMessage({ type: 'ACCOUNTS_SYNC', payload: { accounts: data }, senderId: 'paper-trading-dashboard', timestamp: Date.now() });
          ch.close();
        } catch (e) { }
      }
    } catch (e) { console.error('Failed to fetch accounts:', e); }
    finally {
      setIsAccountsLoaded(true);
    }
  }, [userProfile, session]);

  useEffect(() => {
    fetchAccounts();

    const accountsChannel = supabase
      .channel('accounts_changes_ui')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trading_accounts' },
        () => { fetchAccounts(); }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(accountsChannel);
    };
  }, [fetchAccounts]);

  const handleModalSubmit = async (data) => {
    const trimmedName = data.name.trim();
    const balance = data.balance ?? 10000;

    // Determine the owner: admin can pick any profile, client defaults to self
    const ownerUserId = userProfile?.role === 'admin' && data.ownerId
      ? data.ownerId
      : (session?.user?.id ?? null);

    setIsCreatingAccount(true);
    try {
      const { data: accList, error: accErr } = await supabase
        .from('paper_trading_accounts')
        .insert([{ name: trimmedName, balance, is_active: true, user_id: ownerUserId }])
        .select('*');
      
      if (accErr) {
        console.error('Failed to create account:', accErr);
        alert(`Failed to create account: ${accErr.message}`);
        setIsCreatingAccount(false);
        return;
      }
      
      const accData = accList?.[0];
      if (accData) {
        await supabase.from('paper_trading_config').insert([{
          id: accData.id,
          account_id: accData.id,
          underlying: data.underlying,
          min_strike_diff: data.minStrikeDiff,
          min_iv_diff: data.minIvDiff,
          max_ratio_deviation: data.maxRatioDeviation,
          min_sell_premium: data.minSellPremium,
          max_net_premium: data.maxNetPremium,
          min_long_dist: data.minLongDist,
          max_sell_qty: data.maxSellQty,
          atm_ratio_scaling: data.atmRatioScaling,
          atm_ratio_distance_call: data.atmRatioPctCall,
          atm_ratio_distance_put: data.atmRatioPctPut,
          days_to_expiry: data.daysToExpiry,
        }]);

        // Manually fetch accounts first to update state instantly!
        await fetchAccounts();

        setActiveAccountId(accData.id);
        setIsCreateModalOpen(false);
        resetCreate();
      } else {
        alert("Account was created, but details could not be retrieved. Please check if Row Level Security (RLS) is blocking the query.");
      }
    } catch (e) {
      console.error('Create account exception:', e);
    } finally {
      setIsCreatingAccount(false);
    }
  };

  const triggerCreateAccount = () => {
    resetCreate({
      name: `Account ${accounts.length + 1}`,
      balance: 10000,
      underlying: config.underlying,
      minStrikeDiff: config.minStrikeDiff,
      minIvDiff: config.minIvDiff,
      maxRatioDeviation: config.maxRatioDeviation,
      minSellPremium: config.minSellPremium,
      maxNetPremium: config.maxNetPremium,
      minLongDist: config.minLongDist,
      maxSellQty: config.maxSellQty,
      atmRatioScaling: config.atmRatioScaling,
      atmRatioPctCall: config.atmRatioPctCall,
      atmRatioPctPut: config.atmRatioPctPut,
      daysToExpiry: config.daysToExpiry,
    });
    setIsCreateModalOpen(true);
  };

  const triggerEditAccount = () => {
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    if (!activeAccount) return;
    resetEdit({
      name: activeAccount.name,
      balance: activeAccount.balance
    });
    setIsEditModalOpen(true);
  };

  const handleEditSubmit = async (data) => {
    const trimmedName = data.name.trim();
    const balance = data.balance;

    setIsSavingAccount(true);
    try {
      setAccounts(prev => prev.map(a => a.id === activeAccountId ? { ...a, name: trimmedName, balance } : a));
      const { error } = await supabase
        .from('paper_trading_accounts')
        .update({ name: trimmedName, balance })
        .eq('id', activeAccountId);

      if (error) {
        console.error('Failed to update account:', error);
        alert(`Failed to update account: ${error.message}`);
        return;
      }

      await fetchAccounts();
      setIsEditModalOpen(false);
    } catch (e) {
      console.error('Edit account exception:', e);
    } finally {
      setIsSavingAccount(false);
    }
  };

  const triggerDeleteAccount = (accountId) => {
    setAccountToDeleteId(accountId);
    setIsDeleteModalOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!accountToDeleteId) return;
    setIsDeletingAccount(true);
    try {
      // Clean up associated heartbeat row first to avoid leftovers
      await supabase
        .from('engine_heartbeat')
        .delete()
        .eq('id', `paper_trading_${accountToDeleteId}`);

      const { error } = await supabase
        .from('paper_trading_accounts')
        .delete()
        .eq('id', accountToDeleteId);

      if (error) {
        console.error('Failed to delete account:', error);
        alert(`Failed to delete account: ${error.message}`);
        return;
      }

      await fetchAccounts();
      setIsDeleteModalOpen(false);
      setAccountToDeleteId(null);
    } catch (e) {
      console.error('Delete account error:', e);
    } finally {
      setIsDeletingAccount(false);
    }
  };

  // ── Config ────────────────────────────────────────────────────────────
  const saveSupabaseConfig = useCallback(async (newCfg) => {
    console.log('[saveSupabaseConfig] triggered with newCfg:', newCfg, 'activeAccountId:', activeAccountId, 'configDbId:', configDbId);
    if (!activeAccountId || !configDbId) {
      console.warn('[saveSupabaseConfig] missing activeAccountId or configDbId', { activeAccountId, configDbId });
      return;
    }
    try {
      const { data, error } = await supabase.from('paper_trading_config').upsert({
        id: configDbId,
        account_id: activeAccountId,
        underlying: newCfg.underlying,
        expiry: newCfg.expiry,
        min_strike_diff: newCfg.minStrikeDiff,
        min_iv_diff: newCfg.minIvDiff,
        max_ratio_deviation: newCfg.maxRatioDeviation,
        min_sell_premium: newCfg.minSellPremium,
        max_net_premium: newCfg.maxNetPremium,
        min_long_dist: newCfg.minLongDist,
        max_sell_qty: newCfg.maxSellQty,
        atm_ratio_scaling: newCfg.atmRatioScaling,
        atm_ratio_distance_call: newCfg.atmRatioPctCall,
        atm_ratio_distance_put: newCfg.atmRatioPctPut,
        days_to_expiry: newCfg.daysToExpiry,
        updated_at: new Date().toISOString()
      }).select();
      if (error) {
        console.error('[saveSupabaseConfig] supabase error:', error);
      } else {
        console.log('[saveSupabaseConfig] success:', data);
      }
    } catch (e) {
      console.error('[saveSupabaseConfig] exception:', e);
    }
  }, [activeAccountId, configDbId]);

  const FILTER_KEYS = [
    'minStrikeDiff',
    'minIvDiff',
    'maxRatioDeviation',
    'minSellPremium',
    'maxNetPremium',
    'minLongDist',
    'maxSellQty',
    'atmRatioScaling',
    'atmRatioPctCall',
    'atmRatioPctPut',
    'daysToExpiry'
  ];

  const updateConfig = (keyOrObj, value) => {
    const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
    setConfig(c => {
      const newConfig = { ...c, ...updates };
      setTimeout(() => {
        tabBroadcast('CONFIG_SYNC', { config: newConfig });
        saveSupabaseConfig(newConfig);
      }, 0);
      return newConfig;
    });
    setDraftConfig(dc => {
      if (dc) return { ...dc, ...updates };
      return { ...config, ...updates };
    });
  };

  const updateDraftConfig = (keyOrObj, value) => {
    setDraftConfig(dc => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      return { ...dc, ...updates };
    });
  };

  const DEFAULT_FILTERS = {
    minStrikeDiff: 800,
    minIvDiff: 5,
    maxRatioDeviation: 0.25,
    minSellPremium: 10,
    maxNetPremium: 20,
    minLongDist: 500,
    maxSellQty: 10,
    atmRatioScaling: false,
    atmRatioPctCall: 50,
    atmRatioPctPut: 50,
    daysToExpiry: 0,
  };

  const isDefaultConfig = React.useMemo(() => {
    if (!config) return true;
    return Object.keys(DEFAULT_FILTERS).every(k => config[k] === DEFAULT_FILTERS[k]);
  }, [config]);

  const isFiltersDirty = React.useMemo(() => {
    if (!draftConfig || !config) return false;
    return FILTER_KEYS.some(k => draftConfig[k] !== config[k]);
  }, [draftConfig, config]);

  const handleApplyFilters = () => {
    if (draftConfig) {
      updateConfig(draftConfig);
    }
  };

  const handleResetFilters = () => {
    setConfig(c => {
      const resetConfig = { ...c, ...DEFAULT_FILTERS };
      setTimeout(() => {
        saveSupabaseConfig(resetConfig);
        tabBroadcast('CONFIG_SYNC', { config: resetConfig });
      }, 0);
      return resetConfig;
    });
    setDraftConfig(prev => prev ? { ...prev, ...DEFAULT_FILTERS } : { ...config, ...DEFAULT_FILTERS });
  };

  const fetchSupabaseConfig = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      let { data, error } = await supabase
        .from('paper_trading_config').select('*').eq('account_id', activeAccountId).single();
      
      if (error && error.code === 'PGRST116') {
        const defaultRow = {
          account_id: activeAccountId,
          underlying: 'BTC',
          min_strike_diff: 800,
          min_iv_diff: 5,
          max_ratio_deviation: 0.25,
          min_sell_premium: 10,
          max_net_premium: 20,
          min_long_dist: 500,
          max_sell_qty: 10,
          atm_ratio_scaling: false,
          atm_ratio_distance_call: 50,
          atm_ratio_distance_put: 50,
          days_to_expiry: 0,
          updated_at: new Date().toISOString()
        };
        const { data: inserted, error: insertErr } = await supabase
          .from('paper_trading_config')
          .insert([defaultRow])
          .select('*')
          .single();
        if (inserted && !insertErr) {
          data = inserted;
          error = null;
        }
      }

      if (data && !error) {
        const loadedConfig = {
          underlying: data.underlying || 'BTC',
          expiry: data.expiry || '',
          minStrikeDiff: data.min_strike_diff,
          minIvDiff: data.min_iv_diff,
          maxRatioDeviation: data.max_ratio_deviation,
          minSellPremium: data.min_sell_premium,
          maxNetPremium: data.max_net_premium,
          minLongDist: data.min_long_dist || 500,
          maxSellQty: data.max_sell_qty || 10,
          atmRatioScaling: data.atm_ratio_scaling ?? false,
          atmRatioPctCall: data.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: data.atm_ratio_distance_put ?? 50,
          daysToExpiry: data.days_to_expiry ?? 0,
        };
        setConfig(loadedConfig);
        setDraftConfig(loadedConfig);
        setConfigDbId(data.id);
        setIsConfigLoaded(true);
      }
    } catch (e) { }
  }, [activeAccountId]);

  // ── Supabase reads ────────────────────────────────────────────────────
  const fetchSupabaseActivePositions = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      if (Date.now() - lastDbWriteRef.current < 3000) return;
      const { data, error } = await supabase
        .from('active_positions')
        .select('*')
        .eq('account_id', activeAccountId)
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
              sellQty: p.sell_qty, strikeDiff: p.strike_diff,
              entryTime: new Date(p.entry_time),
              entryBuyPrice: p.entry_buy_price, entrySellPrice: p.entry_sell_price,
              entrySpotPrice: p.entry_spot_price,
              stagesExited: p.stages_exited || 0,
              margin: p.margin || 0, entryFee: p.entry_fee || 0,
              accumulatedSellPnl: p.accumulated_sell_pnl || 0,
              // Preserve live display data from current state
              currentBuyPrice: existing?.currentBuyPrice ?? null,
              currentSellPrice: existing?.currentSellPrice ?? null,
              currentBuyIv: existing?.currentBuyIv ?? null,
              currentSellIv: existing?.currentSellIv ?? null,
              entryBuyIv: buyLeg?.entryIv || null,
              entrySellIv: sellLeg?.entryIv || null,
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
  }, [activeAccountId]);

  const fetchSupabaseTradeHistory = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const { data, error } = await supabase
        .from('trade_history')
        .select('*')
        .eq('account_id', activeAccountId)
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
          margin: t.margin,
          realizedGrossPnl: t.realized_gross_pnl, realizedNetPnl: t.realized_net_pnl,
          exitFee: t.exit_fee, totalFees: t.total_fees,
          entryFee: (t.total_fees || 0) - (t.exit_fee || 0),
          exitReason: t.exit_reason,
          entryBuyIv: safeParseLeg(t.buy_leg)?.entryIv || null,
          entrySellIv: safeParseLeg(t.sell_leg)?.entryIv || null,
          exitBuyIv: safeParseLeg(t.buy_leg)?.exitIv || null,
          exitSellIv: safeParseLeg(t.sell_leg)?.exitIv || null,
          _isPartial: t.is_partial || false,
          _exitedBuyQty: t.lot_size ?? safeParseLeg(t.buy_leg)?.lotSize ?? 1,
        }));
        setTradeHistory(mapped);
      }
    } catch (e) { }
  }, [activeAccountId, underlying]);

  // ── Initial data load + Realtime subscription ─────────────────────────
  useEffect(() => {
    if (!activeAccountId) return;

    fetchSupabaseActivePositions();
    fetchSupabaseTradeHistory();
    fetchSupabaseConfig();

    const realtimeChannel = supabase
      .channel(`active_positions_changes_${activeAccountId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'active_positions', filter: `account_id=eq.${activeAccountId}` },
        () => { fetchSupabaseActivePositions(); }
      )
      .subscribe();

    const historyChannel = supabase
      .channel(`trade_history_changes_${activeAccountId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trade_history', filter: `account_id=eq.${activeAccountId}` },
        () => { fetchSupabaseTradeHistory(); }
      )
      .subscribe();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchSupabaseActivePositions();
        fetchSupabaseTradeHistory();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      supabase.removeChannel(realtimeChannel);
      supabase.removeChannel(historyChannel);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchSupabaseConfig, activeAccountId]);

  // ── Engine heartbeat ──────────────────────────────────────────────────
  const fetchHeartbeat = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const { data, error } = await supabase
        .from('engine_heartbeat')
        .select('*')
        .eq('id', `paper_trading_${activeAccountId}`);

      if (error || !data || data.length === 0) {
        setEngineStatus({ status: 'offline', lastHeartbeat: null, data: null });
        return;
      }

      const row = data[0];
      const age = Date.now() - new Date(row.last_heartbeat).getTime();
      const status = age < HEARTBEAT_ONLINE_THRESHOLD ? 'online'
        : age < HEARTBEAT_STALE_THRESHOLD ? 'stale' : 'offline';

      setEngineStatus({ status, lastHeartbeat: new Date(row.last_heartbeat), data: row.payload });

      // Use server's last evaluation time for the UI timestamp
      if (row.last_heartbeat) {
        setLastEvaluated(new Date(row.last_heartbeat).getTime());
      }
    } catch (e) { }
  }, [activeAccountId]);

  useEffect(() => {
    let interval = null;
    const start = () => {
      fetchHeartbeat();
      interval = setInterval(fetchHeartbeat, 30000);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
    };

    if (document.visibilityState === 'visible') {
      start();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchHeartbeat]);

  // ── Spot price (for PnL display math) ────────────────────────────────
  useEffect(() => {
    let interval = null;
    const fetchSpot = () => {
      getSpotPrice(underlying)
        .then(sp => {
          if (sp) {
            latestSpotPriceRef.current = sp;
            setSpotPrice(sp);
          }
        })
        .catch(() => { });
    };

    const start = () => {
      fetchSpot();
      interval = setInterval(fetchSpot, 10000);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
    };

    if (document.visibilityState === 'visible') {
      start();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [underlying]);

  // Throttle spot price state updates to UI to exactly once per second
  useEffect(() => {
    const interval = setInterval(() => {
      if (latestSpotPriceRef.current !== null) {
        setSpotPrice(latestSpotPriceRef.current);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── WebSocket (read-only: feeds Phase 1 PnL display only) ────────────
  const positionsSymbolsKey = React.useMemo(() => {
    return positions
      .filter(p => p.underlying === underlying)
      .map(p => `${p.buyLeg?.symbol}_${p.sellLeg?.symbol}`)
      .sort()
      .join(',');
  }, [positions, underlying]);

  const getSymbolMeta = useCallback(() => {
    if (!selExpiry || !products.length) return {};
    const strikes = getStrikes(products, selExpiry);
    const meta = {};
    for (const strike of strikes) {
      const callProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(strike) &&
        matchesOptionType(p, 'call')
      );
      if (callProd) {
        const lotSize = parseFloat(callProd.contract_size ?? callProd.quoting_precision ?? 1);
        meta[callProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'call', symbol: callProd.symbol };
      }
      const putProd = products.find(p =>
        p.settlement_time === selExpiry &&
        parseFloat(p.strike_price) === parseFloat(strike) &&
        matchesOptionType(p, 'put')
      );
      if (putProd) {
        const lotSize = parseFloat(putProd.contract_size ?? putProd.quoting_precision ?? 1);
        meta[putProd.symbol] = { strike: parseFloat(strike), lotSize, type: 'put', symbol: putProd.symbol };
      }
    }
    // Also subscribe to symbols from open positions (tracks P&L across expiries)
    positions.forEach(pos => {
      if (pos.underlying === underlying) {
        if (pos.buyLeg && !meta[pos.buyLeg.symbol]) {
          meta[pos.buyLeg.symbol] = { strike: pos.buyLeg.strike, lotSize: pos.buyLeg.lotSize, type: pos.type, symbol: pos.buyLeg.symbol };
        }
        if (pos.sellLeg && !meta[pos.sellLeg.symbol]) {
          meta[pos.sellLeg.symbol] = { strike: pos.sellLeg.strike, lotSize: pos.sellLeg.lotSize, type: pos.type, symbol: pos.sellLeg.symbol };
        }
      }
    });
    return meta;
  }, [selExpiry, products, underlying, positionsSymbolsKey]);

  useEffect(() => {
    if (!selExpiry || !products.length) return;

    const symbolMeta = getSymbolMeta();
    const perpSymbol = `${underlying}USD`;
    const allSymbols = Object.keys(symbolMeta);
    if (!allSymbols.includes(perpSymbol)) {
      allSymbols.push(perpSymbol);
    }
    if (allSymbols.length < 2) return;

    if (wsRef.current) {
      try { wsRef.current.close(); } catch (e) { }
      wsRef.current = null;
    }
    tickerBufferRef.current = {};
    latestTickerDataRef.current = {};
    setTickerData({});

    wsRef.current = createTickerStream(
      allSymbols,
      (msg) => {
        const sym = msg.symbol;
        if (sym === perpSymbol) {
          const sp = toFiniteNumber(msg.spot_price ?? msg.mark_price ?? msg.close ?? msg.last_price);
          if (sp && !isNaN(sp)) {
            latestSpotPriceRef.current = sp;
          }
          return;
        }
        const meta = symbolMeta[sym];
        if (!meta) return;

        const markPrice = toFiniteNumber(msg.mark_price);
        const lastPrice = toFiniteNumber(msg.last_price ?? msg.close);
        const bid = toFiniteNumber(msg.quotes?.best_bid);
        const ask = toFiniteNumber(msg.quotes?.best_ask);
        const bidIv = normalizeIv(toFiniteNumber(msg.quotes?.bid_iv));
        const askIv = normalizeIv(toFiniteNumber(msg.quotes?.ask_iv));
        const iv = normalizeIv(toFiniteNumber(msg.mark_vol ?? msg.quotes?.mark_iv ?? msg.greeks?.iv));
        const delta = msg.greeks ? toFiniteNumber(msg.greeks.delta) : null;

        const prev = tickerBufferRef.current[sym] ?? latestTickerDataRef.current[sym];
        tickerBufferRef.current[sym] = {
          symbol: sym, strike: meta.strike, lotSize: meta.lotSize, type: meta.type,
          markPrice: markPrice ?? prev?.markPrice ?? null,
          lastPrice: lastPrice ?? prev?.lastPrice ?? null,
          bid: bid ?? prev?.bid ?? null,
          ask: ask ?? prev?.ask ?? null,
          bidIv: bidIv ?? prev?.bidIv ?? null,
          askIv: askIv ?? prev?.askIv ?? null,
          iv: iv ?? prev?.iv ?? null,
          delta: delta !== null ? delta : prev?.delta,
          deltaNotional: delta !== null ? Math.abs(delta) * meta.lotSize : prev?.deltaNotional,
        };

        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flushTickerBuffer, 50);
        }
      },
      () => { }
    );

    return () => {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    };
  }, [selExpiry, products, underlying, getSymbolMeta, flushTickerBuffer]);

  // ── Phase 1: Real-time PnL display (read-only, no writes) ────────────
  useEffect(() => {
    const interval = setInterval(() => {
      if (!spotPrice || positions.length === 0) return;
      const live = latestTickerDataRef.current;

      setPositions(prev => {
        if (prev.length === 0) return prev;
        return prev.map(pos => {
          const tickerBuy = live[pos.buyLeg?.symbol];
          const tickerSell = live[pos.sellLeg?.symbol];
          const latestBuy = tickerBuy?.bid ?? tickerBuy?.lastPrice ?? tickerBuy?.markPrice ?? pos.currentBuyPrice;
          const latestSell = tickerSell?.ask ?? tickerSell?.lastPrice ?? tickerSell?.markPrice ?? pos.currentSellPrice;

          // If we don't have any price at all for both legs, skip this position's updates
          if (latestBuy == null && latestSell == null) return pos;

          const hasBothPrices = latestBuy != null && latestSell != null;
          const buyPnl = hasBothPrices ? ((latestBuy - pos.entryBuyPrice) || 0) : 0; // Sell - Buy
          const sellPnl = hasBothPrices ? (((pos.entrySellPrice - latestSell) * pos.sellQty) || 0) : 0; // Sell - Buy
          const grossPnl = hasBothPrices
            ? (buyPnl * pos.buyLeg.lotSize) + (sellPnl * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0)
            : pos.unrealizedGrossPnl;
          const exitFee = hasBothPrices
            ? calculateFee(latestBuy, spotPrice, 1, pos.buyLeg.lotSize) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize)
            : pos.currentExitFee;
          const totalFees = hasBothPrices ? ((pos.entryFee || 0) + exitFee) : pos.currentTotalFees;

          return {
            ...pos,
            currentBuyPrice: latestBuy,
            currentSellPrice: latestSell,
            currentBuyIv: tickerBuy?.bidIv ?? tickerBuy?.iv ?? pos.currentBuyIv ?? null,
            currentSellIv: tickerSell?.askIv ?? tickerSell?.iv ?? pos.currentSellIv ?? null,
            unrealizedGrossPnl: grossPnl,
            unrealizedNetPnl: grossPnl - totalFees,
            currentExitFee: exitFee,
            currentTotalFees: totalFees,
          };
        });
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [spotPrice, positions.length, underlying, positionsSymbolsKey]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (wsRef.current) wsRef.current.close();
    if (spotIntervalRef.current) clearInterval(spotIntervalRef.current);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  // ── Cross-tab sync (config only) ──────────────────────────────────────
  const { broadcast: tabBroadcast } = useTabListener({
    CONFIG_SYNC: (payload) => {
      if (payload.config) {
        setConfig(payload.config);
        setDraftConfig(payload.config);
      }
    },
    ACCOUNTS_SYNC: (payload) => {
      if (payload.accounts) {
        setAccounts(payload.accounts);
        if (payload.accounts.length > 0) {
          setActiveAccountId(prev => {
            if (prev && payload.accounts.some(a => a.id === prev)) return prev;
            return payload.accounts[0].id;
          });
        }
      }
    }
  });

  // ── Export CSV ────────────────────────────────────────────────────────
  const exportCSV = () => {
    if (!filteredTradeHistory.length) {
      alert('No closed trades found for the selected filter.');
      return;
    }
    const headers = [
      'Entry Time', 'Exit Time', 'Expiry', 'Type', 'Ratio', 'Original Ratio',
      'Buy Strike', 'Sell Strike', 'Entry Buy Price', 'Entry Sell Price',
      'Exit Buy Price', 'Exit Sell Price', 'Entry Spot', 'Exit Spot',
      'Entry ATM Ratio', 'Entry ATM Buy Price', 'Entry ATM Sell Price',
      'Exit ATM Ratio', 'Exit ATM Buy Price', 'Exit ATM Sell Price',
      'Gross PnL', 'Total Fees', 'Net PnL', 'Margin', 'Exit Reason'
    ];
    const rows = filteredTradeHistory.map(t => {
      const sellQty = t.sellQty;
      const grossPnl = t.realizedGrossPnl || 0;
      const netPnl = t.realizedNetPnl || 0;
      const buyLot = t.buyLeg?.lotSize || 1;
      const margin = t.margin || 0;
      return [
        formatDateTime(t.entryTime), formatDateTime(t.exitTime), fmtExpiry(t.expiry),
        t.type.toUpperCase(), `${buyLot.toFixed(2)}:${sellQty.toFixed(2)}`,
        `${(t.buyLeg?.originalLotSize || t.buyLeg.lotSize).toFixed(2)}:${(t.buyLeg?.originalSellQty || t.sellQty).toFixed(2)}`,
        t.buyLeg.strike, t.sellLeg.strike,
        t.entryBuyPrice || '', t.entrySellPrice || '',
        t.exitBuyPrice || '', t.exitSellPrice || '',
        t.entrySpotPrice || '', t.exitSpotPrice || '',
        t.buyLeg?.entryAtmRatio != null ? t.buyLeg.entryAtmRatio.toFixed(2) : '',
        t.buyLeg?.entryBuyAtmPrice != null ? t.buyLeg.entryBuyAtmPrice.toFixed(2) : '',
        t.buyLeg?.entrySellAtmPrice != null ? t.buyLeg.entrySellAtmPrice.toFixed(2) : '',
        t.buyLeg?.exitAtmRatio != null ? t.buyLeg.exitAtmRatio.toFixed(2) : '',
        t.buyLeg?.exitBuyAtmPrice != null ? t.buyLeg.exitBuyAtmPrice.toFixed(2) : '',
        t.buyLeg?.exitSellAtmPrice != null ? t.buyLeg.exitSellAtmPrice.toFixed(2) : '',
        grossPnl.toFixed(2), (t.totalFees || 0).toFixed(2), netPnl.toFixed(2),
        margin.toFixed(2), t.exitReason || ''
      ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');
    });
    const csv = [headers.map(h => `"${h}"`).join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `paper_trades_${historyFilterDate || 'all_time'}_${Date.now()}.csv`;
    a.click();
  };

  // ── KPI / display helpers ─────────────────────────────────────────────
  const filteredTradeHistory = React.useMemo(() => {
    if (!historyFilterDate) return tradeHistory;
    return tradeHistory.filter(t => {
      if (!t.exitTime) return false;
      const d = new Date(t.exitTime);
      if (isNaN(d.getTime())) return false;
      d.setUTCHours(d.getUTCHours() + 12);
      return d.toISOString().split('T')[0] === historyFilterDate;
    });
  }, [tradeHistory, historyFilterDate]);

  const totalUnrealizedPnl = positions
    .filter(p => p.underlying === underlying)
    .reduce((s, p) => s + (includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0)), 0);

  const totalRealizedPnl = tradeHistory.reduce((s, t) => s + (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)), 0);

  const totalPnl = totalRealizedPnl + totalUnrealizedPnl;

  const todayRealizedPnl = React.useMemo(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    const todayUtc = d.toISOString().split('T')[0];
    return tradeHistory.reduce((s, t) => {
      if (!t.exitTime) return s;
      const dTrade = new Date(t.exitTime);
      if (isNaN(dTrade.getTime())) return s;
      dTrade.setUTCHours(dTrade.getUTCHours() + 12);
      if (dTrade.toISOString().split('T')[0] !== todayUtc) return s;
      return s + (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0));
    }, 0);
  }, [tradeHistory, includeFees]);

  const todayPnl = todayRealizedPnl + totalUnrealizedPnl;
  const wins = tradeHistory.filter(t =>
    (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)) > 0
  ).length;
  const winRate = tradeHistory.length > 0
    ? ((wins / tradeHistory.length) * 100).toFixed(1) : '—';
  const calculatePositionMargin = useCallback((p) => {
    const buyPrice = p.currentBuyPrice != null ? p.currentBuyPrice : (p.entryBuyPrice || 0);
    const buyLot = p.buyLeg?.lotSize || 1;
    const sellLot = p.sellLeg?.lotSize || 1;
    const spot = spotPrice || p.entrySpotPrice || 0;
    const sellQty = p.sellQty;
    const longMargin = buyPrice * buyLot;
    const shortValue = Math.min(200000, spot * sellQty * sellLot);
    const leverage = 200;
    return longMargin + (shortValue / leverage);
  }, [spotPrice]);

  const totalMargin = React.useMemo(() => {
    return positions
      .filter(p => p.underlying === underlying)
      .reduce((s, p) => s + calculatePositionMargin(p), 0);
  }, [positions, underlying, calculatePositionMargin]);
  const filteredRealizedPnl = filteredTradeHistory.reduce((s, t) =>
    s + (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)), 0);
  const filteredWins = filteredTradeHistory.filter(t =>
    (includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0)) > 0
  ).length;

  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  const exitBadgeClass = (reason) => {
    if (reason?.includes('Manual')) return 'manual';
    if (reason?.includes('Top 3')) return 'position';
    if (reason?.includes('ITM')) return 'itm';
    if (reason?.includes('ATM')) return 'atm';
    if (reason?.includes('Expiry')) return 'expiry';
    return 'position';
  };

  const renderRatio = (t) => {
    const r = t.exitReason || '';
    let mult = 1;
    if (r.includes('50%')) mult = 2;
    else if (r.includes('33%') || r.includes('34%')) mult = 3;

    const sellQty = t.sellQty || 0;
    const origLot = t.buyLeg?.originalLotSize || t.buyLeg?.lotSize || 1;

    const uncappedSellQty = t.buyLeg?.originalSellQty !== undefined
      ? t.buyLeg.originalSellQty
      : sellQty / origLot;

    const originalSell = Math.round((uncappedSellQty * mult) * 4) / 4;
    return `1:${originalSell.toFixed(2)}`;
  };

  // ── Engine status badge helper ────────────────────────────────────────
  const engineStatusLabel = engineStatus.status === 'online' ? 'Engine Live'
    : engineStatus.status === 'stale' ? 'Engine Stale'
      : 'Engine Offline';
  const engineStatusColor = engineStatus.status === 'online' ? '#0ecb81'
    : engineStatus.status === 'stale' ? '#f0b90b'
      : '#f85149';

  // ── Render ────────────────────────────────────────────────────────────

  // Show loading spinner while auth state is resolving
  if (isAuthLoading) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" style={{ animation: 'spin 0.9s linear infinite' }}>
            <circle cx="12" cy="12" r="10" stroke="rgba(240,185,11,0.15)" />
            <path d="M12 2a10 10 0 0 1 10 10" />
          </svg>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="navbar">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <rect width="32" height="32" rx="7" fill="#0d1117" />
            <rect x="5" y="14" width="4" height="8" rx="1" fill="#3fb950" />
            <line x1="7" y1="10" x2="7" y2="14" stroke="#3fb950" strokeWidth="1.5" />
            <line x1="7" y1="22" x2="7" y2="26" stroke="#3fb950" strokeWidth="1.5" />
            <rect x="13" y="10" width="4" height="10" rx="1" fill="#f85149" />
            <line x1="15" y1="6" x2="15" y2="10" stroke="#f85149" strokeWidth="1.5" />
            <line x1="15" y1="20" x2="15" y2="25" stroke="#f85149" strokeWidth="1.5" />
            <rect x="21" y="12" width="4" height="9" rx="1" fill="#e3b341" />
            <line x1="23" y1="8" x2="23" y2="12" stroke="#e3b341" strokeWidth="1.5" />
            <line x1="23" y1="21" x2="23" y2="26" stroke="#e3b341" strokeWidth="1.5" />
            <rect x="5" y="29" width="22" height="1.5" rx="0.75" fill="#00d9a3" opacity="0.8" />
          </svg>
          VITTI OPTION<span>SCOPE</span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="nav-tab" onClick={() => onNavigate('charts')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 20V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M4 20H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="7" y="12" width="3" height="6" rx="0.6" fill="currentColor" />
                <rect x="12" y="9" width="3" height="9" rx="0.6" fill="currentColor" />
                <rect x="17" y="6" width="3" height="12" rx="0.6" fill="currentColor" />
              </svg>
            </span> <span className="nav-tab-text">Charts</span>
          </button>
          <button className="nav-tab" onClick={() => onNavigate('scanner')}>
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </span> <span className="nav-tab-text">Ratio Spread</span>
          </button>
          <button className="nav-tab active">
            <span className="nav-tab-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
                <line x1="9" y1="21" x2="9" y2="9"></line>
              </svg>
            </span> <span className="nav-tab-text">Paper Trading</span>
          </button>
        </div>

        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <button className="nav-tab" onClick={toggleTheme} title="Toggle Theme" style={{ padding: '6px' }}>
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
              </svg>
            )}
          </button>
          {/* Engine status — replaces the old Start/Stop trading button */}
          <div className="ws-badge">
            <div className="ws-dot" style={{ background: engineStatusColor }} />
            <span>{engineStatusLabel}</span>
          </div>
        </div>
      </nav>

      <div className="body" style={{ flexDirection: 'column', overflowY: 'auto' }}>
        {!session ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 120px)', width: '100%', background: 'var(--bg)' }}>
            <div style={{
              width: '100%',
              maxWidth: 420,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
              borderRadius: 16,
              padding: '40px 36px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              gap: 28
            }}>
              {/* Logo */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <svg width="48" height="48" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect width="32" height="32" rx="8" fill="#0d1117" />
                  <rect x="5" y="14" width="4" height="8" rx="1" fill="#3fb950" />
                  <line x1="7" y1="10" x2="7" y2="14" stroke="#3fb950" strokeWidth="1.5" />
                  <line x1="7" y1="22" x2="7" y2="26" stroke="#3fb950" strokeWidth="1.5" />
                  <rect x="13" y="10" width="4" height="10" rx="1" fill="#f85149" />
                  <line x1="15" y1="6" x2="15" y2="10" stroke="#f85149" strokeWidth="1.5" />
                  <line x1="15" y1="20" x2="15" y2="25" stroke="#f85149" strokeWidth="1.5" />
                  <rect x="21" y="12" width="4" height="9" rx="1" fill="#e3b341" />
                  <line x1="23" y1="8" x2="23" y2="12" stroke="#e3b341" strokeWidth="1.5" />
                  <line x1="23" y1="21" x2="23" y2="26" stroke="#e3b341" strokeWidth="1.5" />
                  <rect x="5" y="29" width="22" height="1.5" rx="0.75" fill="#00d9a3" opacity="0.8" />
                </svg>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: '0.04em', color: 'var(--text)' }}>
                    VITTI OPTION<span style={{ color: 'var(--accent)' }}>SCOPE</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Paper Trading Workstation</div>
                </div>
              </div>

              {/* Form */}
              <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>EMAIL ADDRESS</label>
                  <input
                    id="auth-email"
                    type="email"
                    value={authEmail}
                    onChange={e => setAuthEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 14,
                      outline: 'none',
                      transition: 'border-color 0.2s'
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>

                {authError && (
                  <div style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: 'rgba(248, 81, 73, 0.1)',
                    border: '1px solid rgba(248, 81, 73, 0.3)',
                    color: '#f85149',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    {authError}
                  </div>
                )}

                <button
                  id="auth-submit-btn"
                  type="submit"
                  disabled={isAuthenticating}
                  style={{
                    padding: '12px 0',
                    borderRadius: 8,
                    border: 'none',
                    background: 'var(--accent)',
                    color: '#000',
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: isAuthenticating ? 'not-allowed' : 'pointer',
                    opacity: isAuthenticating ? 0.75 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    transition: 'opacity 0.2s'
                  }}
                >
                  {isAuthenticating ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                        <circle cx="12" cy="12" r="10" stroke="rgba(0,0,0,0.2)" />
                        <path d="M12 2a10 10 0 0 1 10 10" />
                      </svg>
                      Logging In...
                    </>
                  ) : (
                    'Log In'
                  )}
                </button>
              </form>
            </div>
        </div>
      ) : (isAccountsLoaded && accounts.length === 0) ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 120px)', width: '100%', background: 'var(--bg)', padding: '24px 0' }}>
          <div style={{
            width: '100%',
            maxWidth: 760,
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            padding: '40px 36px',
            boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 24
          }}>
            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'rgba(240, 185, 11, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent)'
              }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="12" y1="8" x2="12" y2="16"></line>
                  <line x1="8" y1="12" x2="16" y2="12"></line>
                </svg>
              </div>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Create Your First Account</h3>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)', lineHeight: '1.5', maxWidth: 520 }}>
                To start paper trading, you must create a trading account first. Set up your account name and default strategy filters below.
              </p>
            </div>

            <form onSubmit={handleSubmitCreate(handleModalSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ display: 'flex', gap: '24px' }}>
                {/* Left Column: Account Info */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Account Info</h4>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>ACCOUNT NAME</label>
                    <input
                      type="text"
                      {...registerCreate('name', {
                        required: 'Account name is required',
                        validate: value => value.trim() !== '' || 'Account name cannot be empty'
                      })}
                      placeholder="e.g. My First Account"
                      style={{
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: errorsCreate.name ? '1px solid #f85149' : '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: 13,
                        outline: 'none'
                      }}
                    />
                    {errorsCreate.name && (
                      <span style={{ fontSize: 11, color: '#f85149', marginTop: 2 }}>
                        {errorsCreate.name.message}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '16px' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Underlying</label>
                      <select
                        {...registerCreate('underlying')}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none',
                          width: '100%'
                        }}
                      >
                        <option value="BTC">BTC</option>
                        <option value="ETH">ETH</option>
                      </select>
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Days to Expiry</label>
                      <input
                        type="number"
                        {...registerCreate('daysToExpiry', { valueAsNumber: true })}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none'
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '8px' }}>
                    <input
                      type="checkbox"
                      id="firstAtmRatioScaling"
                      {...registerCreate('atmRatioScaling')}
                      style={{ cursor: 'pointer' }}
                    />
                    <label htmlFor="firstAtmRatioScaling" style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)', cursor: 'pointer', marginBottom: 0 }}>
                      ATM Ratio Entry
                    </label>
                  </div>

                  {watchCreateAtmRatioScaling && (
                    <div style={{ display: 'flex', gap: '16px' }}>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Call ATM Pct (%)</label>
                        <input
                          type="number"
                          {...registerCreate('atmRatioPctCall', { valueAsNumber: true })}
                          style={{
                            padding: '10px 14px',
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                            background: 'var(--bg3)',
                            color: 'var(--text)',
                            fontSize: 13,
                            outline: 'none'
                          }}
                        />
                      </div>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Put ATM Pct (%)</label>
                        <input
                          type="number"
                          {...registerCreate('atmRatioPctPut', { valueAsNumber: true })}
                          style={{
                            padding: '10px 14px',
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                            background: 'var(--bg3)',
                            color: 'var(--text)',
                            fontSize: 13,
                            outline: 'none'
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Right Column: Default Strategy Filters */}
                <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: '16px', borderLeft: '1px solid var(--border)', paddingLeft: '24px' }}>
                  <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Default Strategy Filters</h4>
                  
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Strike Diff ($)</label>
                      <input
                        type="number"
                        {...registerCreate('minStrikeDiff', { valueAsNumber: true })}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none'
                        }}
                      />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min IV Diff (%)</label>
                      <input
                        type="number"
                        {...registerCreate('minIvDiff', { valueAsNumber: true })}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none'
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '16px' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Ratio Dev</label>
                      <input
                        type="number"
                        step="0.01"
                        {...registerCreate('maxRatioDeviation', { valueAsNumber: true })}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none'
                        }}
                      />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Sell Premium ($)</label>
                      <input
                        type="number"
                        {...registerCreate('minSellPremium', { valueAsNumber: true })}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none'
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '16px' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Debit ($)</label>
                      <input
                        type="number"
                        {...registerCreate('maxNetPremium', { valueAsNumber: true })}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none'
                        }}
                      />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Min Long Dist</label>
                      <input
                        type="number"
                        {...registerCreate('minLongDist', { valueAsNumber: true })}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: 13,
                          outline: 'none'
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)' }}>Max Ratio (1:X)</label>
                    <input
                      type="number"
                      step="0.25"
                      {...registerCreate('maxSellQty', { valueAsNumber: true })}
                      style={{
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: 13,
                        outline: 'none',
                        width: '100%'
                      }}
                    />
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={isCreatingAccount}
                style={{
                  padding: '12px 0',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--accent)',
                  color: '#000',
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: isCreatingAccount ? 'not-allowed' : 'pointer',
                  opacity: isCreatingAccount ? 0.75 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  marginTop: 8
                }}
              >
                {isCreatingAccount ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                      <circle cx="12" cy="12" r="10" stroke="rgba(0,0,0,0.2)" />
                      <path d="M12 2a10 10 0 0 1 10 10" />
                    </svg>
                    Creating Account...
                  </>
                ) : (
                  'Create Trading Account'
                )}
              </button>
            </form>
          </div>
        </div>
      ) : (
        <>
          {/* Account Selector Dropdown strip */}
        <div className="account-selector-strip" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 20px',
          background: 'var(--bg2)',
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto',
          whiteSpace: 'nowrap'
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Account:</span>
          
          <select
            value={activeAccountId || ''}
            onChange={e => setActiveAccountId(e.target.value)}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              outline: 'none',
              width: '180px'
            }}
          >
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id} style={{ background: 'var(--bg3)', color: 'var(--text)' }}>
                {acc.name} (${acc.balance})
              </option>
            ))}
          </select>

          <button
            onClick={triggerCreateAccount}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-dim)',
              border: '1px dashed var(--border)',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4
            }}
          >
            + New Account
          </button>

          {accounts.length > 1 && (
            <button
              onClick={() => triggerDeleteAccount(activeAccountId)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                background: 'transparent',
                color: '#f85149',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 500,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4
              }}
              title="Delete Active Account"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              Delete
            </button>
          )}

          {/* User profile & Logout Button (Aligned to the Right) */}
          {userProfile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)', opacity: 0.8, display: 'inline-flex', alignItems: 'center' }}>
                {session?.user?.email} 
                {userProfile.role === 'admin' && (
                  <span style={{ 
                    padding: '2px 6px', 
                    borderRadius: '4px', 
                    fontSize: '10px', 
                    fontWeight: 600, 
                    background: 'rgba(9, 105, 218, 0.15)', 
                    color: '#0969da', 
                    border: '1px solid rgba(9, 105, 218, 0.25)',
                    marginLeft: 8 
                  }}>
                    ADMIN
                  </span>
                )}
              </span>
              <button
                onClick={handleLogout}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--text-dim)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                  <polyline points="16 17 21 12 16 7"></polyline>
                  <line x1="21" y1="12" x2="9" y2="12"></line>
                </svg>
                Logout
              </button>
            </div>
          )}
        </div>

        {/* ── Control Panel ───────────────────────────── */}
        <div className="pt-control-panel">
          <div className="pt-control-section">
            <span className="pt-control-label">Algo</span>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Underlying:</label>
              <select value={underlying} onChange={e => updateConfig('underlying', e.target.value)}
                style={{ padding: '6px 12px', width: '100px', fontSize: '13px' }}>
                {UNDERLYINGS.map(u => <option key={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ marginBottom: 0 }}>Expiry:</label>
              <select value={selExpiry} onChange={e => updateConfig('expiry', e.target.value)}
                disabled={!filteredExpiries.length}
                style={{ padding: '6px 12px', width: '160px', fontSize: '13px' }}>
                {!filteredExpiries.length
                  ? <option>Loading...</option>
                  : filteredExpiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
              </select>
            </div>
            {activeAccountId && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg)', padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Active:</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    {accounts.find(a => a.id === activeAccountId)?.name ?? ''}
                  </span>
                </div>
                <div style={{ width: 1, height: 14, backgroundColor: 'var(--border)' }}></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Balance:</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
                    ${(accounts.find(a => a.id === activeAccountId)?.balance ?? 0).toLocaleString()}
                  </span>
                </div>
                <button
                  onClick={triggerEditAccount}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    padding: '2px',
                    borderRadius: '4px',
                    marginLeft: '4px',
                    outline: 'none',
                    transition: 'color 0.2s'
                  }}
                  onMouseOver={e => e.currentTarget.style.color = 'var(--accent)'}
                  onMouseOut={e => e.currentTarget.style.color = 'var(--text-dim)'}
                  title="Edit Account Details"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
              </div>
            )}
            <button
              className="pt-filters-toggle-btn"
              onClick={() => setIsFiltersCollapsed(!isFiltersCollapsed)}
            >
              {isFiltersCollapsed ? 'SHOW FILTERS' : 'HIDE FILTERS'}
            </button>
          </div>

          <div className="hide-mobile" style={{ width: 1, height: 24, backgroundColor: 'var(--border)' }}></div>

          <div className={`pt-filters-container ${isFiltersCollapsed ? 'collapsed' : 'expanded'}`}>
            <span className="pt-control-label">Filters</span>
            {[
              { label: 'Min Strike Diff ($):', key: 'minStrikeDiff', width: 60 },
              { label: 'Min IV Diff (%):', key: 'minIvDiff', width: 50 },
              { label: 'Max Ratio Dev:', key: 'maxRatioDeviation', width: 60, step: '0.01' },
              { label: 'Min Sell Prem ($):', key: 'minSellPremium', width: 60 },
              { label: 'Max Debit ($):', key: 'maxNetPremium', width: 60 },
              { label: 'Min Long Dist:', key: 'minLongDist', width: 60 },
              { label: 'Max Ratio (1:X):', key: 'maxSellQty', width: 65, step: '0.25' },
              { label: 'Days to Expiry:', key: 'daysToExpiry', width: 50 },
            ].map(({ label, key, width, step }) => (
              <div key={key} className="form-group">
                <label style={{ marginBottom: 0 }}>{label}</label>
                <input type="number" step={step} value={draftConfig?.[key] ?? ''}
                  onChange={e => updateDraftConfig(key, Number(e.target.value))}
                  style={{ width, padding: '4px 8px', fontSize: '13px' }} />
              </div>
            ))}
            <div key="atmRatioScaling" className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" id="atmRatioScaling" checked={draftConfig?.atmRatioScaling ?? false}
                onChange={e => updateDraftConfig('atmRatioScaling', e.target.checked)} />
              <label htmlFor="atmRatioScaling" style={{ marginBottom: 0, cursor: 'pointer' }}>ATM Ratio Entry</label>
            </div>
            {draftConfig?.atmRatioScaling && (
              <>
                <div key="atmRatioPctCall" className="form-group">
                  <label style={{ marginBottom: 0 }}>Call ATM Pct (%):</label>
                  <input type="number" step="1" value={draftConfig.atmRatioPctCall ?? 50}
                    onChange={e => updateDraftConfig('atmRatioPctCall', Number(e.target.value))}
                    style={{ width: 50, padding: '4px 8px', fontSize: '13px' }} />
                </div>
                <div key="atmRatioPctPut" className="form-group">
                  <label style={{ marginBottom: 0 }}>Put ATM Pct (%):</label>
                  <input type="number" step="1" value={draftConfig.atmRatioPctPut ?? 50}
                    onChange={e => updateDraftConfig('atmRatioPctPut', Number(e.target.value))}
                    style={{ width: 50, padding: '4px 8px', fontSize: '13px' }} />
                </div>
              </>
            )}
            
            {/* Apply & Reset Buttons */}
            <div className="pt-filter-actions">
              <button 
                type="button"
                className={`pt-btn-filter pt-btn-apply ${isFiltersDirty ? 'active' : ''}`}
                onClick={handleApplyFilters} 
                disabled={!isFiltersDirty}
              >
                Apply
              </button>
              <button 
                type="button"
                className="pt-btn-filter pt-btn-reset"
                onClick={handleResetFilters} 
                disabled={isDefaultConfig}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
        <div className='flex justify-between mt-3! px-10!'>
          {spotPrice && (
            <div className="pt-spot-display">
              <span className="pt-spot-label">SPOT</span>
              <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
            </div>
          )}

          <div className="pt-status-badge live ml-10">
            <span className="pt-pulse"></span>
            LIVE ALGO
          </div>
        </div>

        {/* ── KPI Dashboard ───────────────────────────── */}
        <div className="pt-kpi-strip">
          <div className={`pt-kpi-card ${todayPnl >= 0 ? 'accent-green' : 'accent-red'}`}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
              Today's P&L
            </span>
            <span className={`pt-kpi-value ${todayPnl > 0 ? 'positive' : todayPnl < 0 ? 'negative' : 'neutral'}`}>
              {todayPnl > 0 ? '+' : ''}{todayPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Realized: {todayRealizedPnl.toFixed(2)} | Unrl: {totalUnrealizedPnl.toFixed(2)}</span>
          </div>

          <div className={`pt-kpi-card ${totalPnl >= 0 ? 'accent-blue' : 'accent-red'}`} style={{ borderLeft: '4px solid var(--accent)' }}>
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 7l-5-5-5 5" /></svg>
              All-Time P&L
            </span>
            <span className={`pt-kpi-value ${totalPnl > 0 ? 'positive' : totalPnl < 0 ? 'negative' : 'neutral'}`}>
              {totalPnl > 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
            <span className="pt-kpi-sub">Total Realized: {totalRealizedPnl.toFixed(2)}</span>
          </div>

          <div className="pt-kpi-card accent-gold">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M8 12l3 3 5-5" /></svg>
              Win Rate
            </span>
            <span className="pt-kpi-value neutral">{winRate}{winRate !== '—' ? '%' : ''}</span>
            <span className="pt-kpi-sub">{wins}W / {tradeHistory.length - wins}L of {tradeHistory.length}</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></svg>
              Active
            </span>
            <span className="pt-kpi-value neutral">{positions.filter(p => p.underlying === underlying).length}</span>
            <span className="pt-kpi-sub">
              {positions.filter(p => p.type === 'call' && p.underlying === underlying).length} calls /&nbsp;
              {positions.filter(p => p.type === 'put' && p.underlying === underlying).length} puts
            </span>
          </div>

          <div className="pt-kpi-card accent-purple">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
              Trades
            </span>
            <span className="pt-kpi-value neutral">{tradeHistory.length}</span>
            <span className="pt-kpi-sub">Closed positions</span>
          </div>

          <div className="pt-kpi-card accent-blue">
            <span className="pt-kpi-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
              Margin Used
            </span>
            <span className="pt-kpi-value neutral">${totalMargin.toFixed(0)}</span>
            <span className="pt-kpi-sub">
              Across {positions.filter(p => p.underlying === underlying).length} position
              {positions.filter(p => p.underlying === underlying).length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Active Positions ─────────────────────── */}
          <div className="pt-section live">
            <div className="pt-section-header">
              <div className="pt-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
                Active Positions ({underlying})
                <span className="pt-section-count">{positions.filter(p => p.underlying === underlying).length}</span>
              </div>

              <div className="pt-section-controls">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {lastEvaluated > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text)', borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
                      Updated: {new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(lastEvaluated))}
                    </div>
                  )}
                  <button
                    onClick={async () => {
                      fetchSupabaseActivePositions();
                      fetchSupabaseTradeHistory();
                      fetchHeartbeat();
                    }}
                    title="Refresh now"
                    style={{
                      padding: '4px 8px', fontSize: 12, background: 'var(--bg-card)',
                      border: '1px solid var(--border)', color: 'var(--text)',
                      borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                      minWidth: '50px', justifyContent: 'center'
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C15.5398 3 18.5997 5.04419 20.0886 8M20.0886 8H16.0886M20.0886 8V4" />
                    </svg>
                    {lastEvaluated > 0 ? `${Math.max(0, 30 - Math.round((now - lastEvaluated) / 1000))}s` : ''}
                  </button>
                </div>



                <div className="pt-fee-toggle-container">
                  <span className={`pt-fee-toggle-label ${!includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(false)}>Gross</span>
                  <label className="pt-switch">
                    <input type="checkbox" checked={includeFees} onChange={e => setIncludeFees(e.target.checked)} />
                    <span className="pt-slider"></span>
                  </label>
                  <span className={`pt-fee-toggle-label ${includeFees ? 'active' : ''}`} onClick={() => setIncludeFees(true)}>Net</span>
                </div>

                <div style={{ fontSize: 14, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
                  Spot: {spotPrice ? spotPrice.toLocaleString() : '---'}
                </div>

                <div className="pt-live-badge">
                  <div className="pt-live-dot" style={{ background: engineStatusColor }} />
                  {engineStatusLabel}
                </div>
              </div>
            </div>

            {positions.filter(p => p.underlying === underlying).length === 0 ? (
              <div className="pt-empty">
                <div className="pt-empty-icon scanning">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={engineStatusColor} strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 2a10 10 0 0 1 0 20" strokeDasharray="4 4">
                      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="3s" repeatCount="indefinite" />
                    </path>
                  </svg>
                </div>
                <span className="pt-empty-title">No Active Positions</span>
                <span className="pt-empty-desc">The server engine is scanning for entries. Positions appear here automatically when entered.</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th>Type / Ratio</th>
                    <th>Expiry</th>
                    <th>Buy / Sell Strike</th>
                    <th className="hide-mobile">Entry Spot</th>
                    <th>In (Buy / Sell)</th>
                    <th className="hide-mobile">IV In (B/S)</th>
                    <th>Cur (Buy / Sell)</th>
                    <th className="hide-mobile">IV Cur (B/S)</th>
                    <th>Unrl P&L</th>
                    <th className="hide-xs">Margin</th>
                    <th className="hide-mobile">Duration</th>
                  </tr></thead>
                  <tbody>
                    {positions.filter(p => p.underlying === underlying).map(p => {
                      const pnlValue = includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0);
                      const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';

                      const displayBuyQty = p.buyLeg.lotSize;
                      const displaySellQty = p.sellQty;

                      const origLot = p.buyLeg?.originalLotSize || p.buyLeg?.lotSize || 1;
                      const rawOrigSellQty = p.buyLeg?.originalSellQty !== undefined ? p.buyLeg.originalSellQty : p.sellQty;
                      const displayOrigSellQty = Math.round((rawOrigSellQty / origLot) * 4) / 4;

                      return (
                        <tr key={p.id} className={`pt-row-${p.type}`}>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${p.type}`}>{p.type.toUpperCase()}</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {displayBuyQty.toFixed(2)}:{displaySellQty.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                                (Orig 1:{displayOrigSellQty.toFixed(2)})
                              </span>
                            </div>
                          </td>
                          <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(p.expiry)}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="pt-strike-buy">{p.buyLeg.strike.toLocaleString()}</span>
                              <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{p.sellLeg.strike.toLocaleString()}</span>
                            </div>
                          </td>
                          <td className="hide-mobile"><span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-dim)' }}>{p.entrySpotPrice ? p.entrySpotPrice.toLocaleString() : '—'}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{p.entryBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{p.entrySellPrice?.toFixed(2)}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-dim)' }}>
                              <span>{p.entryBuyIv != null ? p.entryBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{p.entrySellIv != null ? p.entrySellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{p.currentBuyPrice != null ? p.currentBuyPrice.toFixed(2) : '—'}</span>
                              <span style={{ color: '#f85149' }}>{p.currentSellPrice != null ? p.currentSellPrice.toFixed(2) : '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--accent)' }}>
                              <span>{p.currentBuyIv != null ? p.currentBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{p.currentSellIv != null ? p.currentSellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td><span className={`pt-pnl ${pnlClass}`}>{pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}</span></td>
                          <td className="hide-xs">
                            <div className="pt-margin-cell">
                              <span>${calculatePositionMargin(p).toFixed(0)}</span>
                              <div className="pt-margin-bar">
                                <div className="pt-margin-fill" style={{ width: `${Math.min(100, (calculatePositionMargin(p) / (totalMargin || 1)) * 100)}%` }} />
                              </div>
                            </div>
                          </td>
                          <td className="hide-mobile"><span className="pt-duration">{fmtDuration(new Date() - p.entryTime)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Trade History ────────────────────────── */}
          <div className="pt-section">
            <div className="pt-section-header pt-history-header" style={{
              flexDirection: 'column', alignItems: 'stretch', gap: '16px',
              padding: '16px 20px', borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(180deg, var(--bg2) 0%, var(--bg) 100%)'
            }}>
              {/* Row 1: Title and Centered Filter */}
              <div className="pt-history-row-1">
                <div className="pt-history-title-area">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(240, 185, 11, 0.1)', color: 'var(--accent)' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '0.5px', color: 'var(--text)' }}>Trade History</span>
                    <span style={{ fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '1px' }}>Closed Positions</span>
                  </div>
                  <span style={{ background: 'var(--bg3)', color: 'var(--accent)', padding: '2px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, border: '1px solid rgba(240, 185, 11, 0.2)' }}>
                    {filteredTradeHistory.length}
                  </span>
                </div>

                {/* Centered Date Filter */}
                <div className="pt-history-date-filter">
                  <button onClick={() => adjustFilterDay(-1)} title="Previous Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', margin: '0 4px' }}>
                    <input type="date" value={historyFilterDate} onChange={(e) => setHistoryFilterDate(e.target.value)}
                      style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: '13px', fontWeight: 600, padding: 0, width: '125px', outline: 'none', cursor: 'pointer' }} />
                    <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, background: 'rgba(240, 185, 11, 0.1)', padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                      12:00 UTC SESSION
                    </span>
                  </div>
                  <button onClick={() => adjustFilterDay(1)} title="Next Day" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                  </button>
                  <button onClick={resetToToday} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '8px', padding: '4px 12px', fontSize: '11px', color: 'var(--text)', fontWeight: 700, cursor: 'pointer', marginLeft: '4px' }}>
                    TODAY
                  </button>
                  <button onClick={() => setHistoryFilterDate('')} title="Show All History"
                    style={{ background: historyFilterDate ? 'none' : 'rgba(240, 185, 11, 0.1)', border: 'none', color: historyFilterDate ? 'var(--text-dim)' : 'var(--accent)', cursor: 'pointer', display: 'flex', padding: '6px', borderRadius: '6px', marginLeft: '4px' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
                  </button>
                </div>
              </div>

              {/* Row 2: Stats and Export */}
              {filteredTradeHistory.length > 0 && (
                <div className="pt-history-row-2">
                  <div className="pt-history-stats" style={{ gap: '20px' }}>
                    <div className="pt-history-stat">
                      <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Net Realized:</span>
                      <span className={`value ${filteredRealizedPnl >= 0 ? 'green' : 'red'}`} style={{ fontSize: '14px' }}>
                        {filteredRealizedPnl > 0 ? '+' : ''}{filteredRealizedPnl.toFixed(2)}
                      </span>
                    </div>
                    <div style={{ width: '1px', height: '16px', background: 'var(--border)' }} />
                    <div className="pt-history-stat">
                      <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Win / Loss:</span>
                      <span style={{ fontSize: '14px', fontWeight: 700 }}>
                        <span className="value green">{filteredWins}</span>
                        <span style={{ margin: '0 4px', color: 'var(--text-dim)', fontWeight: 400 }}>/</span>
                        <span className="value red">{filteredTradeHistory.length - filteredWins}</span>
                      </span>
                    </div>
                  </div>
                  <button className="pt-export-btn" onClick={exportCSV}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', borderRadius: '8px', background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                    Export CSV
                  </button>
                </div>
              )}
            </div>

            {filteredTradeHistory.length === 0 ? (
              <div className="pt-empty">
                <div className="pt-empty-icon idle">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2"><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" /></svg>
                </div>
                <span className="pt-empty-title">No Closed Trades</span>
                <span className="pt-empty-desc">Trades will appear here once positions are exited for the selected day.</span>
              </div>
            ) : (
              <div className="pt-table-scroll">
                <table className="pt-table">
                  <thead><tr>
                    <th className="hide-mobile">Entry Time</th>
                    <th className="hide-mobile">Exit Time</th>
                    <th className="hide-mobile">Duration</th>
                    <th>Expiry</th>
                    <th>Type / Ratio</th>
                    <th>Buy / Sell Strike</th>
                    <th>Spot (In / Out)</th>
                    <th>In (Buy / Sell)</th>
                    <th className="hide-mobile">IV In (B/S)</th>
                    <th className="hide-mobile">Entry ATM Ratio (Prices)</th>
                    <th className="hide-mobile">Entry Fee</th>
                    <th className="hide-mobile">Exit Fee</th>
                    <th>Out (Buy / Sell)</th>
                    <th className="hide-mobile">IV Out (B/S)</th>
                    <th className="hide-mobile">Exit ATM Ratio (Prices)</th>
                    <th>Realized P&L</th>
                    <th>Exit Reason</th>
                  </tr></thead>
                  <tbody>
                    {filteredTradeHistory.map((t, i) => {
                      const pnlValue = includeFees ? (t.realizedNetPnl || 0) : (t.realizedGrossPnl || 0);
                      const pnlClass = pnlValue > 0 ? 'positive' : pnlValue < 0 ? 'negative' : 'zero';
                      const durationMs = t.exitTime && t.entryTime ? (t.exitTime - t.entryTime) : 0;

                      const displayBuyQty = t.buyLeg.lotSize;
                      const displaySellQty = t.sellQty;
                      const displayMargin = t.margin || 0;

                      const origLot = t.buyLeg?.originalLotSize || t.buyLeg?.lotSize || 1;
                      const rawOrigSellQty = t.buyLeg?.originalSellQty !== undefined ? t.buyLeg.originalSellQty : t.sellQty;
                      const displayOrigSellQty = Math.round((rawOrigSellQty / origLot) * 4) / 4;

                      return (
                        <tr key={i}>
                          <td className="hide-mobile" style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.entryTime)}</td>
                          <td className="hide-mobile" style={{ color: 'var(--text-dim)', fontSize: '11px', whiteSpace: 'nowrap' }}>{formatDateTime(t.exitTime)}</td>
                          <td className="hide-mobile"><span className="pt-duration" style={{ fontSize: '11px' }}>{fmtDuration(durationMs)}</span></td>
                          <td><span style={{ fontSize: '11px', fontWeight: 600 }}>{fmtExpiry(t.expiry)}</span></td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span className={`pt-type-badge ${t.type}`}>
                                {t.type.toUpperCase()}
                                {t._isPartial && (
                                  <span style={{ fontSize: '9px', marginLeft: 4, opacity: 0.8 }}>
                                    ({t.exitReason?.match(/\d+%/)?.[0] || 'P'})
                                  </span>
                                )}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600 }}>
                                {displayBuyQty.toFixed(2)}:{displaySellQty.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '9px', color: 'var(--text-dim)', opacity: 0.8 }}>
                                (Orig 1:{displayOrigSellQty.toFixed(2)})
                              </span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span className="pt-strike-buy">{t.buyLeg.strike.toLocaleString()}</span>
                              <span className="pt-strike-sell" style={{ fontSize: '11px', opacity: 0.8 }}>{t.sellLeg.strike.toLocaleString()}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                              <span style={{ color: 'var(--text-dim)' }}>{t.entrySpotPrice ? t.entrySpotPrice.toLocaleString() : '—'}</span>
                              <span style={{ color: 'var(--text-dim)', opacity: 0.8 }}>{t.exitSpotPrice ? t.exitSpotPrice.toLocaleString() : '—'}</span>
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{t.entryBuyPrice?.toFixed(2)}</span>
                              <span style={{ color: '#f85149' }}>{t.entrySellPrice?.toFixed(2)}</span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 600, marginTop: 2 }}>
                                {renderRatio(t)}
                              </span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text-dim)' }}>
                              <span>{t.entryBuyIv != null ? t.entryBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{t.entrySellIv != null ? t.entrySellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            {t.buyLeg?.entryAtmRatio != null ? (
                              <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                                <span style={{ fontWeight: 600 }}>{t.buyLeg.entryAtmRatio.toFixed(2)}</span>
                                <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
                                  ({t.buyLeg.entryBuyAtmPrice != null ? t.buyLeg.entryBuyAtmPrice.toFixed(2) : '—'} / {t.buyLeg.entrySellAtmPrice != null ? t.buyLeg.entrySellAtmPrice.toFixed(2) : '—'})
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-dim)' }}>—</span>
                            )}
                          </td>
                          <td className="hide-mobile">
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                              ${t.entryFee?.toFixed(2) || '0.00'}
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                              ${t.exitFee?.toFixed(2) || '0.00'}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '12px' }}>
                              <span style={{ color: '#3fb950' }}>{t.exitBuyPrice?.toFixed(2) || '—'}</span>
                              <span style={{ color: '#f85149' }}>{t.exitSellPrice?.toFixed(2) || '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px', color: 'var(--text)' }}>
                              <span>{t.exitBuyIv != null ? t.exitBuyIv.toFixed(1) + '%' : '—'}</span>
                              <span>{t.exitSellIv != null ? t.exitSellIv.toFixed(1) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td className="hide-mobile">
                            {t.buyLeg?.exitAtmRatio != null ? (
                              <div style={{ display: 'flex', flexDirection: 'column', fontSize: '11px' }}>
                                <span style={{ fontWeight: 600 }}>{t.buyLeg.exitAtmRatio.toFixed(2)}</span>
                                <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
                                  ({t.buyLeg.exitBuyAtmPrice != null ? t.buyLeg.exitBuyAtmPrice.toFixed(2) : '—'} / {t.buyLeg.exitSellAtmPrice != null ? t.buyLeg.exitSellAtmPrice.toFixed(2) : '—'})
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-dim)' }}>—</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                              <span className={`pt-pnl ${pnlClass}`}>
                                {pnlValue > 0 ? '+' : ''}{pnlValue.toFixed(2)}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>Margin: ${displayMargin.toFixed(0)}</span>
                            </div>
                          </td>
                          <td><span className={`pt-exit-badge ${exitBadgeClass(t.exitReason)}`}>{t.exitReason}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </>
    )}
  </div>

      {/* Create Account Modal */}
      {isCreateModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <form onSubmit={handleSubmitCreate(handleModalSubmit)} style={{
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '24px',
            width: '720px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px solid var(--border)', paddingBottom: '10px' }}>Create New Account</h3>
            
            <div style={{ display: 'flex', gap: '24px' }}>
              {/* Left Column: Account Details */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Account Info</h4>

                {/* Admin-only: Owner Selector */}
                {userProfile?.role === 'admin' && profiles.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>
                      Owner (Client)
                      <span style={{ marginLeft: 6, padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: 'rgba(9,105,218,0.15)', color: '#0969da', border: '1px solid rgba(9,105,218,0.25)' }}>ADMIN</span>
                    </label>
                    <select
                      {...registerCreate('ownerId')}
                      defaultValue={session?.user?.id ?? ''}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none',
                        width: '100%'
                      }}
                    >
                      {profiles.map(p => (
                        <option key={p.id} value={p.id} style={{ background: 'var(--bg3)', color: 'var(--text)' }}>
                          {p.email}{p.id === session?.user?.id ? ' (you)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Account Name</label>
                  <input
                    type="text"
                    {...registerCreate('name', {
                      required: 'Account name is required',
                      validate: value => value.trim() !== '' || 'Account name cannot be empty'
                    })}
                    placeholder="e.g. BTC Aggressive"
                    style={{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: errorsCreate.name ? '1px solid #f85149' : '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: '13px',
                      outline: 'none'
                    }}
                  />
                  {errorsCreate.name && (
                    <span style={{ fontSize: '11px', color: '#f85149', marginTop: '2px' }}>
                      {errorsCreate.name.message}
                    </span>
                  )}
                </div>
              </div>

              {/* Right Column: Default Filters */}
              <div style={{ flex: 1.5, display: 'flex', flexDirection: 'column', gap: '16px', borderLeft: '1px solid var(--border)', paddingLeft: '24px' }}>
                <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text)', borderBottom: '1px dashed var(--border)', paddingBottom: '4px' }}>Default Strategy Filters</h4>
                
                {/* Row 1: Underlying & Days to Expiry */}
                <div style={{ display: 'flex', gap: '16px' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Underlying</label>
                    <select
                      {...registerCreate('underlying')}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none',
                        width: '100%'
                      }}
                    >
                      <option value="BTC" style={{ background: 'var(--bg3)', color: 'var(--text)' }}>BTC</option>
                      <option value="ETH" style={{ background: 'var(--bg3)', color: 'var(--text)' }}>ETH</option>
                    </select>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Days to Expiry</label>
                    <input
                      type="number"
                      {...registerCreate('daysToExpiry', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>

                {/* Row 2: Min Strike Diff & Min IV Diff */}
                <div style={{ display: 'flex', gap: '16px' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Min Strike Diff ($)</label>
                    <input
                      type="number"
                      {...registerCreate('minStrikeDiff', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Min IV Diff (%)</label>
                    <input
                      type="number"
                      {...registerCreate('minIvDiff', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>

                {/* Row 3: Max Ratio Deviation & Min Sell Premium */}
                <div style={{ display: 'flex', gap: '16px' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Max Ratio Dev</label>
                    <input
                      type="number"
                      step="0.01"
                      {...registerCreate('maxRatioDeviation', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Min Sell Premium ($)</label>
                    <input
                      type="number"
                      {...registerCreate('minSellPremium', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>

                {/* Row 4: Max Debit & Min Long Distance */}
                <div style={{ display: 'flex', gap: '16px' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Max Debit ($)</label>
                    <input
                      type="number"
                      {...registerCreate('maxNetPremium', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Min Long Dist</label>
                    <input
                      type="number"
                      {...registerCreate('minLongDist', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>

                {/* Row 5: Max Sell Qty & ATM Scaling Toggle */}
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Max Ratio (1:X)</label>
                    <input
                      type="number"
                      step="0.25"
                      {...registerCreate('maxSellQty', { valueAsNumber: true })}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg3)',
                        color: 'var(--text)',
                        fontSize: '13px',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '20px' }}>
                    <input
                      type="checkbox"
                      id="createAtmRatioScaling"
                      {...registerCreate('atmRatioScaling')}
                      style={{ cursor: 'pointer' }}
                    />
                    <label htmlFor="createAtmRatioScaling" style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text)', cursor: 'pointer', marginBottom: 0 }}>
                      ATM Ratio Entry
                    </label>
                  </div>
                </div>

                {/* Row 6 (Conditional): ATM Pct Call & Put */}
                {watchCreateAtmRatioScaling && (
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Call ATM Pct (%)</label>
                      <input
                        type="number"
                        {...registerCreate('atmRatioPctCall', { valueAsNumber: true })}
                        style={{
                          padding: '8px 12px',
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: '13px',
                          outline: 'none'
                        }}
                      />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Put ATM Pct (%)</label>
                      <input
                        type="number"
                        {...registerCreate('atmRatioPctPut', { valueAsNumber: true })}
                        style={{
                          padding: '8px 12px',
                          borderRadius: '6px',
                          border: '1px solid var(--border)',
                          background: 'var(--bg3)',
                          color: 'var(--text)',
                          fontSize: '13px',
                          outline: 'none'
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px', borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
              <button
                type="button"
                disabled={isCreatingAccount}
                onClick={() => setIsCreateModalOpen(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  cursor: isCreatingAccount ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  opacity: isCreatingAccount ? 0.6 : 1
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreatingAccount}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#0969da',
                  color: '#ffffff',
                  cursor: isCreatingAccount ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  opacity: isCreatingAccount ? 0.8 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
              >
                {isCreatingAccount ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                      <circle cx="12" cy="12" r="10" stroke="rgba(255, 255, 255, 0.25)" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="#ffffff" />
                    </svg>
                    Creating...
                  </>
                ) : 'Create Account'}
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Delete Account Confirmation Modal */}
      {isDeleteModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '24px',
            width: '400px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#f85149' }}>Delete Account</h3>
            
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
              {positions.length > 0 && activeAccountId === accountToDeleteId ? (
                <span style={{ color: '#f85149', fontWeight: 600 }}>
                  ⚠️ WARNING: "{accounts.find(a => a.id === accountToDeleteId)?.name || 'this account'}" has active open positions. Deleting this account will permanently delete all open positions for this account. Trade history will be preserved.
                </span>
              ) : (
                `Are you sure you want to delete "${accounts.find(a => a.id === accountToDeleteId)?.name || 'this account'}"?`
              )}
            </p>

            <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-dim)' }}>
              This action is irreversible. All associated strategy configurations will also be deleted.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button
                disabled={isDeletingAccount}
                onClick={() => {
                  setIsDeleteModalOpen(false);
                  setAccountToDeleteId(null);
                }}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  cursor: isDeletingAccount ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  opacity: isDeletingAccount ? 0.6 : 1
                }}
              >
                Cancel
              </button>
              <button
                disabled={isDeletingAccount}
                onClick={handleConfirmDelete}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#f85149',
                  color: '#ffffff',
                  cursor: isDeletingAccount ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  opacity: isDeletingAccount ? 0.8 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
              >
                {isDeletingAccount ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                      <circle cx="12" cy="12" r="10" stroke="rgba(255, 255, 255, 0.25)" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="#ffffff" />
                    </svg>
                    Deleting...
                  </>
                ) : 'Delete Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Account Modal */}
      {isEditModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <form onSubmit={handleSubmitEdit(handleEditSubmit)} style={{
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '24px',
            width: '380px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--text)' }}>Edit Account Details</h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Account Name</label>
              <input
                type="text"
                {...registerEdit('name', {
                  required: 'Account name is required',
                  validate: value => value.trim() !== '' || 'Account name cannot be empty'
                })}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: errorsEdit.name ? '1px solid #f85149' : '1px solid var(--border)',
                  background: 'var(--bg3)',
                  color: 'var(--text)',
                  fontSize: '13px',
                  outline: 'none'
                }}
              />
              {errorsEdit.name && (
                <span style={{ fontSize: '11px', color: '#f85149', marginTop: '2px' }}>
                  {errorsEdit.name.message}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-dim)' }}>Balance ($)</label>
              <input
                type="number"
                {...registerEdit('balance', {
                  required: 'Balance is required',
                  valueAsNumber: true,
                  validate: value => (!isNaN(value) && value > 0) || 'Balance must be a positive number'
                })}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: errorsEdit.balance ? '1px solid #f85149' : '1px solid var(--border)',
                  background: 'var(--bg3)',
                  color: 'var(--text)',
                  fontSize: '13px',
                  outline: 'none'
                }}
              />
              {errorsEdit.balance && (
                <span style={{ fontSize: '11px', color: '#f85149', marginTop: '2px' }}>
                  {errorsEdit.balance.message}
                </span>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button
                type="button"
                disabled={isSavingAccount}
                onClick={() => {
                  setIsEditModalOpen(false);
                  resetEdit();
                }}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'var(--text)',
                  cursor: isSavingAccount ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  opacity: isSavingAccount ? 0.6 : 1
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSavingAccount}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#0969da',
                  color: '#ffffff',
                  cursor: isSavingAccount ? 'not-allowed' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  opacity: isSavingAccount ? 0.8 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
              >
                {isSavingAccount ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ animation: 'spin 0.8s linear infinite' }}>
                      <circle cx="12" cy="12" r="10" stroke="rgba(255, 255, 255, 0.25)" />
                      <path d="M12 2a10 10 0 0 1 10 10" stroke="#ffffff" />
                    </svg>
                    Saving...
                  </>
                ) : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}