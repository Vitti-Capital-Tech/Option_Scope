import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, apiGet, getTickers
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime, formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';

import Navbar from './components/PaperTrading/Navbar';
import LoginCard from './components/PaperTrading/LoginCard';
import FirstAccountCard from './components/PaperTrading/FirstAccountCard';
import AccountSelectorStrip from './components/PaperTrading/AccountSelectorStrip';
import ControlPanel from './components/PaperTrading/ControlPanel';
import KpiDashboard from './components/PaperTrading/KpiDashboard';
import TradingWorkspace from './components/PaperTrading/TradingWorkspace';
import CreateAccountModal from './components/PaperTrading/CreateAccountModal';
import EditAccountModal from './components/PaperTrading/EditAccountModal';
import DeleteAccountModal from './components/PaperTrading/DeleteAccountModal';
import ConfirmExitModal from './components/PaperTrading/ConfirmExitModal';

const UNDERLYINGS = ['BTC', 'ETH'];
const HEARTBEAT_ONLINE_THRESHOLD = 60000;
const HEARTBEAT_STALE_THRESHOLD = 120000;

const ACCOUNT_CONFIG_DEFAULTS = {
  minStrikeDiff: 800,
  minIvDiff: 5,
  maxRatioDeviation: 0.25,
  minSellPremium: 10,
  maxNetPremium: 20,
  minLongDist: 500,
  maxSellQty: 10,
  atmRatioScaling: true,
  atmRatioPctCall: 50,
  atmRatioPctPut: 25,
  daysToExpiry: 0,
  numberOfCalls: 3,
  numberOfPuts: 3,
  exitType: 'ATM',
  exitPoints: 0,
  shortExitPrice: 1.1,
  longExitSlices: 10,
  variableExitSlices: false,
  balanceAllocationPct: 90,
  entryBuyOffset: 5,
  entrySellOffset: 2
};

const normalizeAccountDefaultConfig = (config = {}) => {
  return Object.keys(ACCOUNT_CONFIG_DEFAULTS).reduce((acc, key) => {
    acc[key] = config?.[key] ?? ACCOUNT_CONFIG_DEFAULTS[key];
    return acc;
  }, {});
};

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

// Window 1 — the permanent, non-deletable first window. Auto-created (seeded from
// the account's base/initial config) for any account that has no windows yet, so
// the initial sizing/scaling values are always visible and editable. Spans the
// full day by default (17:30 → 17:29 IST wraps ~24h) so it behaves like the base
// config until the user narrows it and adds more windows.
const makeFirstWindow = (cfg = {}) => ({
  id: 'seed-window-1',
  label: 'Window 1',
  startTime: '17:30',
  endTime: '17:29',
  numberOfCalls: cfg.numberOfCalls ?? 3,
  numberOfPuts: cfg.numberOfPuts ?? 3,
  minLongDist: cfg.minLongDist ?? 500,
  minStrikeDiff: cfg.minStrikeDiff ?? 800,
  atmRatioScaling: cfg.atmRatioScaling ?? true,
  atmRatioPctCall: cfg.atmRatioPctCall ?? 50,
  atmRatioPctPut: cfg.atmRatioPctPut ?? 25,
  maxNetPremium: cfg.maxNetPremium ?? 20,
  exitType: cfg.exitType ?? 'ATM',
  exitPoints: cfg.exitPoints ?? 0,
  isActive: true,
  sort_order: 0,
});

// Mirror of the engine's getActiveSchedule: the window whose IST time range covers
// `nowMs` (handles overnight windows). Returns null when none is active (the
// uncovered-slot gap), so callers fall back to the account-level config.
const findActiveSchedule = (schedules, nowMs) => {
  if (!Array.isArray(schedules) || schedules.length === 0) return null;
  const d = new Date(nowMs);
  const istMin = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
  const toMin = (t) => { const [h, m] = String(t || '00:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  for (const s of schedules) {
    if (s.isActive === false) continue;
    const start = toMin(s.startTime), end = toMin(s.endTime);
    const inWin = start > end ? (istMin >= start || istMin < end) : (istMin >= start && istMin < end);
    if (inWin) return s;
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

  // Time-based schedule windows
  const [schedules, setSchedules] = useState([]);
  const [isSavingSchedules, setIsSavingSchedules] = useState(false);

  const {
    register: registerCreate,
    handleSubmit: handleSubmitCreate,
    formState: { errors: errorsCreate },
    reset: resetCreate,
    watch: watchCreate,
    setValue: setValueCreate
  } = useForm({
    defaultValues: {
      name: '',
      ownerId: '',
      mode: 'paper',
      apiKey: '',
      apiSecret: '',
      credVerified: false,
      underlying: 'BTC',
      minStrikeDiff: 800,
      minIvDiff: 5,
      maxRatioDeviation: 0.25,
      minSellPremium: 10,
      maxNetPremium: 20,
      minLongDist: 500,
      maxSellQty: 10,
      atmRatioScaling: true,
      atmRatioPctCall: 50,
      atmRatioPctPut: 25,
      daysToExpiry: 0,
      numberOfCalls: 3,
      numberOfPuts: 3,
      exitType: 'ATM',
      exitPoints: 0,
      shortExitPrice: 1.1,
      longExitSlices: 10,
      variableExitSlices: false,
      balanceAllocationPct: 90,
      entryBuyOffset: 5,
      entrySellOffset: 2
    }
  });

  const watchCreateAtmRatioScaling = watchCreate('atmRatioScaling');
  const watchCreateExitType = watchCreate('exitType');

  const {
    register: registerEdit,
    handleSubmit: handleSubmitEdit,
    formState: { errors: errorsEdit },
    reset: resetEdit,
    watch: watchEdit,
    setValue: setValueEdit
  } = useForm();

  // Delta credential metadata for the account currently open in the edit modal
  const [editCredentialsMeta, setEditCredentialsMeta] = useState(null);

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
    atmRatioScaling: true,
    atmRatioPctCall: 50,
    atmRatioPctPut: 25,
    daysToExpiry: 0,
    numberOfCalls: 3,
    numberOfPuts: 3,
    exitType: 'ATM',
    exitPoints: 0,
    shortExitPrice: 1.1,
    longExitSlices: 10,
    variableExitSlices: false
  }));
  const [draftConfig, setDraftConfig] = useState(() => ({ ...config }));
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => window.innerWidth <= 900);

  const underlying = config.underlying;
  const selExpiry = config.expiry;

  // Always-current config in a ref so the schedule fetch (deps: activeAccountId
  // only) can seed Window 1 from real values (see makeFirstWindow).
  const configRef = useRef(config);
  configRef.current = config;

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
  const [walletBalance, setWalletBalance] = useState(null); // live USDT balance from heartbeat
  const [engineDryRun, setEngineDryRun] = useState(null); // engine execution mode: true=sim, false=real, null=unknown
  const [engineMaxPositions, setEngineMaxPositions] = useState(null); // engine's max positions (base + windows)
  const [engineAllocationPct, setEngineAllocationPct] = useState(null); // engine's live allocation %
  const [liveExchangeState, setLiveExchangeState] = useState(null); // real Delta snapshot (live accounts only)
  // On reload the live-vs-paper decision (mode + engineDryRun + snapshot) resolves
  // async, so the paper tables briefly flash before the live tables. Track whether
  // the first heartbeat AND snapshot probe have completed for the active account;
  // until then a live account shows a loading state instead of the paper fallback.
  const [liveViewResolved, setLiveViewResolved] = useState(false);
  const liveProbeRef = useRef({ hb: false, snap: false });
  const markLiveProbe = useCallback((key) => {
    liveProbeRef.current[key] = true;
    if (liveProbeRef.current.hb && liveProbeRef.current.snap) setLiveViewResolved(true);
  }, []);

  // Lightweight toast notifications (top-right, auto-dismiss).
  const [toasts, setToasts] = useState([]);
  const pushToast = useCallback((msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);
  // In-app confirmation (toast-styled, no browser alert): { message, confirmLabel, onConfirm }.
  const [confirmDialog, setConfirmDialog] = useState(null);
  // Session-open spot per underlying → drives the % change on the spot bar shown
  // above the tables (captured once, first time we see a spot for that underlying).
  const spotOpenRef = useRef({});

  const [includeFees, setIncludeFees] = useState(true);
  const [positions, setPositions] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  // Server-aggregated all-time KPIs (single row via get_trade_stats RPC) — no
  // full-table scan, so egress stays fixed regardless of trade history size.
  const [historyStats, setHistoryStats] = useState({
    totalGross: 0, totalNet: 0, totalCount: 0,
    winGross: 0, winNet: 0, todayGross: 0, todayNet: 0,
  });
  const [positionToExit, setPositionToExit] = useState(null);
  const [isExitingPosition, setIsExitingPosition] = useState(false);

  const [historyFilterDate, setHistoryFilterDate] = useState(() => {
    const d = new Date();
    d.setUTCHours(d.getUTCHours() + 12);
    return d.toISOString().split('T')[0];
  });
  // Holds the latest selected day so fetchSupabaseTradeHistory stays stable
  // (date changes refetch via a dedicated effect, not by re-subscribing Realtime).
  const historyFilterDateRef = useRef(historyFilterDate);

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
  const lastDaysToExpiryRef = useRef(null);
  const lastSavedSchedulesRef = useRef(null);

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
    } catch (e) { console.error('Failed to load products:', e); }
  }, [underlying]);

  // Validate expiry when config and products are loaded
  useEffect(() => {
    if (isConfigLoaded && products.length > 0) {
      const exps = getExpiries(products);
      if (exps.length) {
        // Did daysToExpiry filter actually change?
        const daysFilterChanged = lastDaysToExpiryRef.current !== null && lastDaysToExpiryRef.current !== config.daysToExpiry;
        lastDaysToExpiryRef.current = config.daysToExpiry;

        let isExpiryInvalid = !selExpiry || !exps.includes(selExpiry);

        // If the daysToExpiry filter changed, we ALWAYS want to select the nearest matching expiry
        if (daysFilterChanged) {
          isExpiryInvalid = true;
        } else if (!isExpiryInvalid && selExpiry) {
          // If the filter did not change, we only invalidate the expiry if it violates the minimum days requirement
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
          if (selectedExpiry !== selExpiry) {
            updateConfig('expiry', selectedExpiry);
          }
        }
      }
    } else if (isConfigLoaded) {
      lastDaysToExpiryRef.current = config.daysToExpiry;
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

  const fetchAccounts = useCallback(async () => {
    if (!userProfile) return;
    try {
      let query = supabase.from('paper_trading_accounts').select('*');
      if (userProfile.role === 'client') {
        query = query.eq('user_id', session?.user?.id);
      }
      const { data, error } = await query.order('created_at', { ascending: true });
      if (data && !error) {
        const normalizedAccounts = data.map(acc => ({
          ...acc,
          default_config: normalizeAccountDefaultConfig(acc.default_config)
        }));

        setAccounts(normalizedAccounts);
        if (normalizedAccounts.length > 0) {
          setActiveAccountId(prev => {
            if (prev && normalizedAccounts.some(a => a.id === prev)) return prev;
            return normalizedAccounts[0].id;
          });
        } else {
          setActiveAccountId(null);
        }

        const staleAccounts = normalizedAccounts.filter((acc, index) => {
          const original = data[index]?.default_config || {};
          return Object.keys(ACCOUNT_CONFIG_DEFAULTS).some(key => original[key] === undefined || original[key] === null);
        });

        if (staleAccounts.length > 0) {
          await Promise.all(staleAccounts.map(acc => (
            supabase
              .from('paper_trading_accounts')
              .update({ default_config: normalizeAccountDefaultConfig(acc.default_config) })
              .eq('id', acc.id)
          )));
        }

        try {
          const ch = new BroadcastChannel('option-scope-sync');
          ch.postMessage({ type: 'ACCOUNTS_SYNC', payload: { accounts: normalizedAccounts }, senderId: 'paper-trading-dashboard', timestamp: Date.now() });
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
    const accountMode = data.mode === 'live' ? 'live' : 'paper';

    // Determine the owner: admin can pick any profile, client defaults to self
    const ownerUserId = userProfile?.role === 'admin' && data.ownerId
      ? data.ownerId
      : (session?.user?.id ?? null);

    const defaultConfigVal = normalizeAccountDefaultConfig({
      minStrikeDiff: data.minStrikeDiff,
      minIvDiff: data.minIvDiff,
      maxRatioDeviation: data.maxRatioDeviation,
      minSellPremium: data.minSellPremium,
      maxNetPremium: data.maxNetPremium,
      minLongDist: data.minLongDist,
      maxSellQty: data.maxSellQty,
      atmRatioScaling: data.atmRatioScaling,
      atmRatioPctCall: data.atmRatioPctCall,
      atmRatioPctPut: data.atmRatioPctPut,
      daysToExpiry: data.daysToExpiry,
      numberOfCalls: data.numberOfCalls,
      numberOfPuts: data.numberOfPuts,
      exitType: data.exitType,
      exitPoints: data.exitPoints,
      shortExitPrice: data.shortExitPrice,
      longExitSlices: data.longExitSlices,
      variableExitSlices: data.variableExitSlices,
      balanceAllocationPct: data.balanceAllocationPct,
      entryBuyOffset: data.entryBuyOffset,
      entrySellOffset: data.entrySellOffset
    });

    setIsCreatingAccount(true);
    try {
      const { data: accList, error: accErr } = await supabase
        .from('paper_trading_accounts')
        .insert([{
          name: trimmedName,
          is_active: true,
          user_id: ownerUserId,
          mode: accountMode,
          live_enabled: false, // kill-switch stays off; arm explicitly later
          default_config: defaultConfigVal
        }])
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
          number_of_calls: data.numberOfCalls ?? 3,
          number_of_puts: data.numberOfPuts ?? 3,
          exit_type: data.exitType ?? 'ATM',
          exit_points: data.exitPoints ?? 0,
          leg_swap_premium: 0,
          short_exit_price: data.shortExitPrice ?? 1.1,
          long_exit_slices: data.longExitSlices ?? 10,
          variable_exit_slices: data.variableExitSlices ?? false,
          balance_allocation_pct: data.balanceAllocationPct ?? 90,
          entry_buy_offset: data.entryBuyOffset ?? 5,
          entry_sell_offset: data.entrySellOffset ?? 2
        }]);

        // For live accounts, store the (encrypted) Delta credentials via RPC.
        if (accountMode === 'live' && data.apiKey?.trim() && data.apiSecret?.trim()) {
          const { error: credErr } = await supabase.rpc('upsert_delta_credentials', {
            p_account_id: accData.id,
            p_api_key: data.apiKey.trim(),
            p_api_secret: data.apiSecret.trim(),
            p_verified: !!data.credVerified
          });
          if (credErr) {
            console.error('Failed to store Delta credentials:', credErr);
            alert(`Account created, but storing Delta credentials failed: ${credErr.message}\nYou can add them later via Edit Account.`);
          }
        }

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
      mode: 'paper',
      apiKey: '',
      apiSecret: '',
      credVerified: false,
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
      numberOfCalls: config.numberOfCalls ?? 3,
      numberOfPuts: config.numberOfPuts ?? 3,
      exitType: config.exitType ?? 'ATM',
      exitPoints: config.exitPoints ?? 0,
      shortExitPrice: config.shortExitPrice ?? 1.1,
      longExitSlices: config.longExitSlices ?? 10,
      variableExitSlices: config.variableExitSlices ?? false
    });
    setIsCreateModalOpen(true);
  };

  const triggerEditAccount = async () => {
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    if (!activeAccount) return;
    resetEdit({
      name: activeAccount.name,
      mode: activeAccount.mode || 'paper',
      apiKey: '',
      apiSecret: '',
      credVerified: false,
      balanceAllocationPct: activeAccount.default_config?.balanceAllocationPct ?? 90,
      entryBuyOffset: activeAccount.default_config?.entryBuyOffset ?? 5,
      entrySellOffset: activeAccount.default_config?.entrySellOffset ?? 2
    });
    setEditCredentialsMeta(null);
    setIsEditModalOpen(true);

    // Pull (non-secret) credential metadata for display, if any.
    if ((activeAccount.mode || 'paper') === 'live') {
      try {
        const { data, error } = await supabase.rpc('get_delta_credentials_meta', {
          p_account_id: activeAccount.id
        });
        if (!error && data && data[0]) setEditCredentialsMeta(data[0]);
      } catch (e) { /* no credentials yet */ }
    }
  };

  const handleEditSubmit = async (data) => {
    const trimmedName = data.name.trim();
    const accountMode = data.mode === 'live' ? 'live' : 'paper';

    setIsSavingAccount(true);
    try {
      // Switching back to paper also disarms the live kill-switch.
      const updatePayload = accountMode === 'live'
        ? { name: trimmedName, mode: 'live' }
        : { name: trimmedName, mode: 'paper', live_enabled: false };

      // Persist live sizing/entry params into default_config.
      const allocPct = Number.isFinite(data.balanceAllocationPct) ? data.balanceAllocationPct : 90;
      const buyOff = Number.isFinite(data.entryBuyOffset) ? data.entryBuyOffset : 5;
      const sellOff = Number.isFinite(data.entrySellOffset) ? data.entrySellOffset : 2;
      const activeAccount = accounts.find(a => a.id === activeAccountId);
      if (activeAccount?.default_config) {
        updatePayload.default_config = {
          ...activeAccount.default_config,
          balanceAllocationPct: allocPct,
          entryBuyOffset: buyOff,
          entrySellOffset: sellOff,
        };
      }

      setAccounts(prev => prev.map(a => a.id === activeAccountId ? { ...a, ...updatePayload } : a));
      const { error } = await supabase
        .from('paper_trading_accounts')
        .update(updatePayload)
        .eq('id', activeAccountId);

      if (error) {
        console.error('Failed to update account:', error);
        alert(`Failed to update account: ${error.message}`);
        return;
      }

      // Mirror allocation + entry offsets into paper_trading_config so the engine reads them live.
      await supabase.from('paper_trading_config')
        .update({
          balance_allocation_pct: allocPct,
          entry_buy_offset: buyOff,
          entry_sell_offset: sellOff,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', activeAccountId);

      // If live and a new key/secret were entered, replace stored credentials.
      if (accountMode === 'live' && data.apiKey?.trim() && data.apiSecret?.trim()) {
        const { error: credErr } = await supabase.rpc('upsert_delta_credentials', {
          p_account_id: activeAccountId,
          p_api_key: data.apiKey.trim(),
          p_api_secret: data.apiSecret.trim(),
          p_verified: !!data.credVerified
        });
        if (credErr) {
          console.error('Failed to update Delta credentials:', credErr);
          alert(`Account saved, but updating Delta credentials failed: ${credErr.message}`);
        }
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

  // ── Live account controls (arm / pause) ───────────────────────────────
  // Flags live on paper_trading_accounts; the engine picks them up via Realtime.
  const updateAccountFlags = async (accountId, patch) => {
    setAccounts(prev => prev.map(a => (a.id === accountId ? { ...a, ...patch } : a)));
    const { error } = await supabase
      .from('paper_trading_accounts')
      .update(patch)
      .eq('id', accountId);
    if (error) {
      console.error('Failed to update account flags:', error);
      alert(`Failed to update account: ${error.message}`);
    }
    await fetchAccounts();
  };

  const triggerStartLive = (accountId) => {
    const acc = accounts.find(a => a.id === accountId);
    if (!window.confirm(`Start LIVE trading for "${acc?.name}"?\n\nThe engine will place real orders for this account (subject to the engine's dry-run switch).`)) return;
    updateAccountFlags(accountId, { live_enabled: true, paused: false });
  };
  const triggerDisarmLive = (accountId) => updateAccountFlags(accountId, { live_enabled: false });
  const triggerPauseAccount = (accountId) => updateAccountFlags(accountId, { paused: true });
  const triggerResumeAccount = (accountId) => updateAccountFlags(accountId, { paused: false });

  // Actually flatten the account — flags every position; the engine exits them
  // (cancel resting + market-close) within ~1.5s. Runs after the in-app confirm.
  const performCloseAll = async () => {
    const acc = accounts.find(a => a.id === activeAccountId);
    const isLiveAcc = acc?.mode === 'live';
    const liveLegs = (liveExchangeState?.positions || []).filter(p => Number(p.size) !== 0).length;
    const count = Math.max(positions.length, liveLegs);
    const { error } = await supabase
      .from('paper_trading_accounts')
      .update({ close_all_requested: true })
      .eq('id', activeAccountId);
    if (error) {
      console.error('Close-all failed:', error);
      pushToast(`Failed to close all: ${error.message}`, 'error');
      return;
    }
    setPositions(prev => prev.map(p => ({ ...p, exitRequested: true })));
    pushToast(isLiveAcc ? 'Closing all positions on Delta…' : `Closing all ${count} position(s)…`, 'success');
    // Mark the flatten pending so refetches don't resurrect the positions until
    // the engine publishes a snapshot showing the account flat.
    pendingCloseRef.current.closeAll = { since: Date.now() };
    setLiveExchangeState(prev => prev ? { ...prev, positions: [], orders: [], stop_orders: [] } : prev);
    // Confirm from the server once the engine has flattened + booked.
    setTimeout(() => syncAll(), 2500);
    setTimeout(() => syncAll(), 6000);
  };

  // Close ALL open positions for the active account at once (like Delta's close-all).
  // Shows an in-app confirmation (no browser alert) before flattening.
  const triggerCloseAll = () => {
    const acc = accounts.find(a => a.id === activeAccountId);
    // Count from the live Delta snapshot too — the engine may have lost track of
    // positions that are still open on Delta (orphans), so don't block on the
    // engine's count being 0. For a live account, close_all flattens the account.
    const liveLegs = (liveExchangeState?.positions || []).filter(p => Number(p.size) !== 0).length;
    const count = Math.max(positions.length, liveLegs);
    const isLiveAcc = acc?.mode === 'live';
    if (count === 0 && !isLiveAcc) { pushToast('No open positions to close.', 'info'); return; }
    setConfirmDialog({
      title: 'Close All Positions',
      message: isLiveAcc
        ? `Close ALL positions on Delta${count ? ` (${count} leg${count !== 1 ? 's' : ''})` : ''}? Every position will be closed at market — including any the dashboard isn't showing.`
        : `Close ALL ${count} open position(s)? Every trade will be exited at market.`,
      confirmLabel: 'Close All',
      onConfirm: performCloseAll,
    });
  };

  // Close a single Delta position by symbol (per-row ✕ on an orphan leg the engine
  // no longer tracks). The engine reduce_only-market-closes exactly that leg.
  const triggerCloseOrphan = async (symbol) => {
    if (!symbol) return;
    // Close directly — no confirmation prompt.
    const { error } = await supabase
      .from('delta_close_requests')
      .insert([{ account_id: activeAccountId, product_symbol: symbol }]);
    if (error) { console.error('close-symbol failed', error); alert(`Failed to close ${symbol}: ${error.message}`); return; }
    // Keep this leg hidden across refetches until the engine snapshot drops it.
    pendingCloseRef.current.symbols.set(symbol, { since: Date.now() });
    setLiveExchangeState(prev => prev ? { ...prev, positions: (prev.positions || []).filter(p => p.product_symbol !== symbol) } : prev);
    setTimeout(() => syncAll(), 2500);
    setTimeout(() => syncAll(), 6000);
  };

  // Cancel a single resting order from the Open Orders table (per-row ✕).
  const triggerCancelOrder = async (o) => {
    if (!o?.id) return;
    const { error } = await supabase
      .from('delta_cancel_requests')
      .insert([{ account_id: activeAccountId, order_id: o.id, product_id: o.product_id }]);
    if (error) { console.error('cancel-order failed', error); alert(`Failed to cancel order: ${error.message}`); return; }
    setLiveExchangeState(prev => prev ? { ...prev, orders: (prev.orders || []).filter(x => x.id !== o.id) } : prev);
    setTimeout(() => syncAll(), 2000);
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
        number_of_calls: newCfg.numberOfCalls ?? 3,
        number_of_puts: newCfg.numberOfPuts ?? 3,
        exit_type: newCfg.exitType ?? 'ATM',
        exit_points: newCfg.exitPoints ?? 0,
        leg_swap_premium: 0,
        short_exit_price: newCfg.shortExitPrice ?? 1.1,
        long_exit_slices: newCfg.longExitSlices ?? 10,
        variable_exit_slices: newCfg.variableExitSlices ?? false,
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

  // The 8 sizing/scaling fields (calls/puts, spread width, spot distance, ATM
  // scaling + call/put %, re-entry step) are not shown in the Control Panel.
  // They are set at account creation (base config = the 24/7 backup) and
  // overridden per time window in the Schedule Panel.
  const FILTER_KEYS = [
    'minIvDiff',
    'maxRatioDeviation',
    'minSellPremium',
    'maxNetPremium',
    'maxSellQty',
    'daysToExpiry',
    'exitType',
    'exitPoints',
    'shortExitPrice',
    'longExitSlices',
    'variableExitSlices'
  ];

  const updateConfig = (keyOrObj, value) => {
    const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
    const parsedUpdates = {};
    for (const k of Object.keys(updates)) {
      const val = updates[k];
      if (k === 'exitType' || k === 'variableExitSlices' || k === 'atmRatioScaling' || k === 'underlying' || k === 'expiry') {
        parsedUpdates[k] = val;
      } else {
        const num = (val === '' || val === '-' || val == null) ? null : Number(val);
        if (num === null || isNaN(num)) {
          parsedUpdates[k] = config[k] ?? DEFAULT_FILTERS[k] ?? ACCOUNT_CONFIG_DEFAULTS[k] ?? 0;
        } else {
          parsedUpdates[k] = num;
        }
      }
    }
    setConfig(c => {
      const newConfig = { ...c, ...parsedUpdates };
      setTimeout(() => {
        tabBroadcast('CONFIG_SYNC', { config: newConfig });
        saveSupabaseConfig(newConfig);
      }, 0);
      return newConfig;
    });
    setDraftConfig(dc => {
      if (dc) return { ...dc, ...parsedUpdates };
      return { ...config, ...parsedUpdates };
    });
  };

  const updateDraftConfig = (keyOrObj, value) => {
    setDraftConfig(dc => {
      const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
      return { ...dc, ...updates };
    });
  };

  const activeAccount = React.useMemo(() => {
    return accounts.find(a => a.id === activeAccountId) || null;
  }, [accounts, activeAccountId]);

  const useLive = activeAccount?.mode === 'live' && engineDryRun === false && !!liveExchangeState;

  const DEFAULT_FILTERS = React.useMemo(() => {
    const baseFilters = {
      minIvDiff: 5,
      maxRatioDeviation: 0.25,
      minSellPremium: 10,
      maxNetPremium: 20,
      maxSellQty: 10,
      daysToExpiry: 0,
      exitType: 'ATM',
      exitPoints: 0
    };
    if (activeAccount && activeAccount.default_config) {
      return { ...baseFilters, ...activeAccount.default_config };
    }
    return baseFilters;
  }, [activeAccount]);

  const isDefaultConfig = React.useMemo(() => {
    if (!config) return true;
    return Object.keys(DEFAULT_FILTERS).every(k => config[k] === DEFAULT_FILTERS[k]);
  }, [config, DEFAULT_FILTERS]);

  const isFiltersDirty = React.useMemo(() => {
    if (!draftConfig || !config) return false;
    return FILTER_KEYS.some(k => {
      const val1 = draftConfig[k];
      const val2 = config[k];
      if (k === 'exitType' || k === 'variableExitSlices' || k === 'atmRatioScaling' || k === 'underlying' || k === 'expiry') {
        return val1 !== val2;
      }
      const num1 = (val1 === '' || val1 === '-' || val1 == null) ? null : Number(val1);
      const num2 = (val2 === '' || val2 === '-' || val2 == null) ? null : Number(val2);
      return num1 !== num2;
    });
  }, [draftConfig, config]);

  const handleApplyFilters = () => {
    if (draftConfig) {
      updateConfig(draftConfig);
    }
  };

  const handleCancelFilters = () => {
    setDraftConfig({ ...config });
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
          id: activeAccountId,
          account_id: activeAccountId,
          underlying: 'BTC',
          min_strike_diff: 800,
          min_iv_diff: 5,
          max_ratio_deviation: 0.25,
          min_sell_premium: 10,
          max_net_premium: 20,
          min_long_dist: 500,
          max_sell_qty: 10,
          atm_ratio_scaling: true,
          atm_ratio_distance_call: 50,
          atm_ratio_distance_put: 25,
          days_to_expiry: 0,
          number_of_calls: 3,
          number_of_puts: 3,
          exit_type: 'ATM',
          exit_points: 0,
          leg_swap_premium: 0,
          variable_exit_slices: false,
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
          atmRatioScaling: data.atm_ratio_scaling ?? true,
          atmRatioPctCall: data.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: data.atm_ratio_distance_put ?? 25,
          daysToExpiry: data.days_to_expiry ?? 0,
          numberOfCalls: data.number_of_calls ?? 3,
          numberOfPuts: data.number_of_puts ?? 3,
          exitType: data.exit_type ?? 'ATM',
          exitPoints: data.exit_points ?? 0,
          shortExitPrice: data.short_exit_price ?? 1.1,
          longExitSlices: data.long_exit_slices ?? 10,
          variableExitSlices: data.variable_exit_slices ?? false
        };
        setConfig(loadedConfig);
        setDraftConfig(loadedConfig);
        setConfigDbId(data.id);
        setIsConfigLoaded(true);
      }
    } catch (e) { }
  }, [activeAccountId]);

  // Convert UTC time string 'HH:mm' or 'HH:mm:ss' to IST 'HH:mm'
  const utcToIst = (utcTimeStr) => {
    if (!utcTimeStr) return '05:30';
    const parts = utcTimeStr.split(':').map(Number);
    const h = parts[0] || 0;
    const m = parts[1] || 0;
    const totalMin = (h * 60 + m + 330) % 1440;
    const istH = Math.floor(totalMin / 60);
    const istM = totalMin % 60;
    return `${String(istH).padStart(2, '0')}:${String(istM).padStart(2, '0')}`;
  };

  // Convert IST time string 'HH:mm' to UTC 'HH:mm'
  const istToUtc = (istTimeStr) => {
    if (!istTimeStr) return '18:30';
    const parts = istTimeStr.split(':').map(Number);
    const h = parts[0] || 0;
    const m = parts[1] || 0;
    const totalMin = (h * 60 + m - 330 + 1440) % 1440;
    const utcH = Math.floor(totalMin / 60);
    const utcM = totalMin % 60;
    return `${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;
  };

  const fetchSupabaseSchedules = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const { data, error } = await supabase
        .from('paper_trading_schedules')
        .select('*')
        .eq('account_id', activeAccountId)
        .order('sort_order', { ascending: true });
      if (error) console.error('Fetch schedules error:', error);
      if (data) {
        const mapped = data.map(s => ({
          id: s.id,
          label: s.label || 'Window',
          startTime: s.start_time ? s.start_time.substring(0, 5) : '17:30',
          endTime: s.end_time ? s.end_time.substring(0, 5) : '17:29',
          numberOfCalls: s.number_of_calls ?? 3,
          numberOfPuts: s.number_of_puts ?? 3,
          minLongDist: s.min_long_dist ?? 500,
          minStrikeDiff: s.min_strike_diff ?? 800,
          atmRatioScaling: s.atm_ratio_scaling ?? true,
          atmRatioPctCall: s.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: s.atm_ratio_distance_put ?? 25,
          maxNetPremium: s.max_net_premium ?? 20,
          exitType: s.exit_type ?? 'ATM',
          exitPoints: s.exit_points ?? 0,
          isActive: s.is_active ?? true,
          sort_order: s.sort_order ?? 0,
        }));
        // Guarantee a permanent Window 1. Accounts with no windows get one
        // seeded from base config (so the initial values are visible/editable);
        // it persists on the next auto-save (lastSaved snapshot excludes it).
        const finalList = mapped.length > 0
          ? mapped
          : [makeFirstWindow(configRef.current)];
        setSchedules(finalList);
        lastSavedSchedulesRef.current = JSON.stringify(mapped.map(s => ({
          label: s.label,
          startTime: s.startTime,
          endTime: s.endTime,
          numberOfCalls: s.numberOfCalls,
          numberOfPuts: s.numberOfPuts,
          minLongDist: s.minLongDist,
          minStrikeDiff: s.minStrikeDiff,
          atmRatioScaling: s.atmRatioScaling,
          atmRatioPctCall: s.atmRatioPctCall,
          atmRatioPctPut: s.atmRatioPctPut,
          maxNetPremium: s.maxNetPremium,
          exitType: s.exitType,
          exitPoints: s.exitPoints,
          isActive: s.isActive
        })));
      }
    } catch (e) { console.error('Schedule fetch error', e); }
  }, [activeAccountId]);

  const saveSupabaseSchedules = useCallback(async () => {
    if (!activeAccountId) return;
    setIsSavingSchedules(true);
    try {
      const { error: delErr } = await supabase.from('paper_trading_schedules').delete().eq('account_id', activeAccountId);
      if (delErr) console.error('Delete schedules error:', delErr);
      if (schedules.length > 0) {
        const rows = schedules.map((s, i) => ({
          account_id: activeAccountId,
          label: s.label || 'Window',
          start_time: s.startTime,
          end_time: s.endTime,
          number_of_calls: s.numberOfCalls ?? 3,
          number_of_puts: s.numberOfPuts ?? 3,
          min_long_dist: s.minLongDist ?? 500,
          min_strike_diff: s.minStrikeDiff ?? 800,
          atm_ratio_scaling: s.atmRatioScaling ?? true,
          atm_ratio_distance_call: s.atmRatioPctCall ?? 50,
          atm_ratio_distance_put: s.atmRatioPctPut ?? 25,
          max_net_premium: s.maxNetPremium ?? 20,
          exit_type: s.exitType ?? 'ATM',
          exit_points: s.exitPoints ?? 0,
          is_active: s.isActive ?? true,
          sort_order: i,
          updated_at: new Date().toISOString(),
        }));
        const { error: insErr } = await supabase.from('paper_trading_schedules').insert(rows);
        if (insErr) console.error('Insert schedules error:', insErr);
      }

      const savedJson = JSON.stringify(schedules.map(s => ({
        label: s.label,
        startTime: s.startTime,
        endTime: s.endTime,
        numberOfCalls: s.numberOfCalls,
        numberOfPuts: s.numberOfPuts,
        minLongDist: s.minLongDist,
        minStrikeDiff: s.minStrikeDiff,
        atmRatioScaling: s.atmRatioScaling,
        atmRatioPctCall: s.atmRatioPctCall,
        atmRatioPctPut: s.atmRatioPctPut,
        maxNetPremium: s.maxNetPremium,
        exitType: s.exitType,
        exitPoints: s.exitPoints,
        isActive: s.isActive
      })));
      lastSavedSchedulesRef.current = savedJson;

      await fetchSupabaseSchedules();
    } catch (e) { console.error('Schedule save error', e); }
    finally { setIsSavingSchedules(false); }
  }, [activeAccountId, schedules, fetchSupabaseSchedules]);

  // Auto-save schedules when they change (debounced)
  useEffect(() => {
    if (!activeAccountId) return;

    // Check if there is any overlap in the schedules
    const toMin = (t) => {
      if (!t) return 0;
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const checkOverlapLocal = (list, current) => {
      if (!current.isActive) return null;
      const curStart = toMin(current.startTime);
      const curEnd = toMin(current.endTime);
      const curIsOvernight = curStart > curEnd;
      const overlaps = (s1, e1, s2, e2) => Math.max(s1, s2) < Math.min(e1, e2);

      for (const s of list) {
        if (s.id === current.id || !s.isActive) continue;
        const start = toMin(s.startTime);
        const end = toMin(s.endTime);
        const isOvernight = start > end;

        if (curIsOvernight && isOvernight) {
          return s;
        } else if (curIsOvernight) {
          if (overlaps(curStart, 1440, start, end) || overlaps(0, curEnd, start, end)) {
            return s;
          }
        } else if (isOvernight) {
          if (overlaps(start, 1440, curStart, curEnd) || overlaps(0, end, curStart, curEnd)) {
            return s;
          }
        } else {
          if (overlaps(curStart, curEnd, start, end)) {
            return s;
          }
        }
      }
      return null;
    };

    const hasOverlap = schedules.some(s => s.isActive && checkOverlapLocal(schedules, s) !== null);
    if (hasOverlap) return; // Do not auto-save if they overlap

    const currentJson = JSON.stringify(schedules.map(s => ({
      label: s.label,
      startTime: s.startTime,
      endTime: s.endTime,
      numberOfCalls: s.numberOfCalls,
      numberOfPuts: s.numberOfPuts,
      minLongDist: s.minLongDist,
      minStrikeDiff: s.minStrikeDiff,
      atmRatioScaling: s.atmRatioScaling,
      atmRatioPctCall: s.atmRatioPctCall,
      atmRatioPctPut: s.atmRatioPctPut,
      maxNetPremium: s.maxNetPremium,
      exitType: s.exitType,
      exitPoints: s.exitPoints,
      isActive: s.isActive
    })));

    if (lastSavedSchedulesRef.current === currentJson) {
      return; // Skip if it matches the DB version
    }

    const timer = setTimeout(async () => {
      lastSavedSchedulesRef.current = currentJson;
      await saveSupabaseSchedules();
    }, 1200);

    return () => clearTimeout(timer);
  }, [schedules, activeAccountId, saveSupabaseSchedules]);

  // ── Supabase reads ────────────────────────────────────────────────────
  // Shared DB-row → position mapper (preserves client-computed live fields).
  const mapDbPosition = useCallback((p, existing) => {
    const buyLeg = safeParseLeg(p.buy_leg);
    const sellLeg = safeParseLeg(p.sell_leg);
    if (!buyLeg || !sellLeg) return null;
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
  }, []);

  const sortActivePositions = useCallback((arr) => {
    return [...arr].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'call' ? -1 : 1;
      if (a.type === 'call') return a.buyLeg.strike - b.buyLeg.strike;
      return b.buyLeg.strike - a.buyLeg.strike;
    });
  }, []);

  // Patch one position from a Realtime payload (no full-table refetch).
  const applyPositionRealtimeChange = useCallback((payload) => {
    const eventType = payload.eventType || payload.type;
    setPositions(prev => {
      if (eventType === 'DELETE') {
        const id = payload.old?.id;
        return id ? prev.filter(p => p.id !== id) : prev;
      }
      const row = payload.new;
      if (!row) return prev;
      const mapped = mapDbPosition(row, prev.find(p => p.id === row.id));
      if (!mapped) return prev;
      return sortActivePositions([...prev.filter(p => p.id !== row.id), mapped]);
    });
  }, [mapDbPosition, sortActivePositions]);

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
          const mapped = data.map(p => mapDbPosition(p, prevMap.get(p.id))).filter(Boolean);
          return sortActivePositions(mapped);
        });
      } else if (data) {
        setPositions([]);
      }
    } catch (e) { console.error('Fetch Active Error:', e); }
  }, [activeAccountId]);

  // Lightweight all-time aggregates for the cumulative KPIs — no heavy JSON legs.
  const fetchHistoryStats = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      // Server-side aggregation returns ONE row (sums, counts, today buckets),
      // replacing what used to be a full trade_history download per refresh.
      const { data, error } = await supabase
        .rpc('get_trade_stats', { p_account_id: activeAccountId, p_underlying: underlying })
        .single();
      if (error || !data) return;
      setHistoryStats({
        totalGross: data.total_gross || 0,
        totalNet: data.total_net || 0,
        totalCount: data.total_count || 0,
        winGross: data.win_gross || 0,
        winNet: data.win_net || 0,
        todayGross: data.today_gross || 0,
        todayNet: data.today_net || 0,
      });
    } catch (e) { /* non-fatal */ }
  }, [activeAccountId, underlying]);

  const fetchSupabaseTradeHistory = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      let query = supabase
        .from('trade_history')
        .select('id, trade_id, underlying, expiry, type, buy_leg, sell_leg, sell_qty, strike_diff, entry_time, exit_time, entry_buy_price, entry_sell_price, exit_buy_price, exit_sell_price, entry_spot_price, exit_spot_price, margin, realized_gross_pnl, realized_net_pnl, exit_fee, total_fees, exit_reason, is_partial, lot_size, account_id')
        .eq('account_id', activeAccountId)
        .eq('underlying', underlying)
        .order('exit_time', { ascending: false });

      // Server-side fetch of just the selected day (matches the UTC+12 day bucket
      // used by filteredTradeHistory) — keeps egress tiny regardless of history size.
      const day = historyFilterDateRef.current;
      if (day) {
        const base = new Date(`${day}T00:00:00.000Z`).getTime();
        const startISO = new Date(base - 12 * 3600 * 1000).toISOString();
        const endISO = new Date(base + 12 * 3600 * 1000).toISOString();
        query = query.gte('exit_time', startISO).lt('exit_time', endISO).limit(1000);
      } else {
        query = query.limit(300);
      }

      const { data, error } = await query;

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

  // Refetch just the selected day's trades from the server whenever the date
  // changes (also covers mount + account/underlying changes via the fn identity).
  useEffect(() => {
    historyFilterDateRef.current = historyFilterDate;
    fetchSupabaseTradeHistory();
  }, [historyFilterDate, fetchSupabaseTradeHistory]);

  const handleConfirmExitPosition = async (pos) => {
    if (!pos || !activeAccountId) return;
    setIsExitingPosition(true);
    try {
      // LIVE accounts: don't book/delete from the browser (it can't touch Delta).
      // Flag the position; the engine closes it on Delta, books, and deletes the row.
      if (activeAccount?.mode === 'live') {
        const { error } = await supabase
          .from('active_positions')
          .update({ exit_requested: true })
          .eq('id', pos.id);
        if (error) {
          console.error('Failed to request manual exit:', error);
          alert(`Failed to request exit: ${error.message}`);
          setIsExitingPosition(false);
          return;
        }
        setPositions(prev => prev.map(p => p.id === pos.id ? { ...p, exitRequested: true } : p));
        // Optimistically drop this spread's legs from the live snapshot so the table
        // updates instantly, and keep them hidden across refetches until the engine
        // snapshot drops them (else a stale refetch flashes them back).
        const now = Date.now();
        if (pos.buyLeg?.symbol) pendingCloseRef.current.symbols.set(pos.buyLeg.symbol, { since: now });
        if (pos.sellLeg?.symbol) pendingCloseRef.current.symbols.set(pos.sellLeg.symbol, { since: now });
        setLiveExchangeState(prev => prev ? {
          ...prev,
          positions: (prev.positions || []).filter(lp =>
            lp.product_symbol !== pos.buyLeg?.symbol && lp.product_symbol !== pos.sellLeg?.symbol),
        } : prev);
        setPositionToExit(null);
        setIsExitingPosition(false);
        // Confirm from the server once the engine has processed the close.
        setTimeout(() => syncAll(), 2500);
        setTimeout(() => syncAll(), 6000);
        return; // engine handles close + book + delete (Realtime removes the row)
      }

      const exitTime = new Date().toISOString();
      const exitBuyPrice = pos.currentBuyPrice !== null ? pos.currentBuyPrice : pos.entryBuyPrice;
      const exitSellPrice = pos.currentSellPrice !== null ? pos.currentSellPrice : pos.entrySellPrice;
      const exitSpotPrice = spotPrice || pos.entrySpotPrice; // Fallback to entry spot if current spot is null

      const buyPriceDiff = (exitBuyPrice != null && pos.entryBuyPrice != null) ? (exitBuyPrice - pos.entryBuyPrice) : 0;
      const sellPriceDiff = (exitSellPrice != null && pos.entrySellPrice != null) ? (pos.entrySellPrice - exitSellPrice) : 0;

      // Calculate gross PnL
      const grossPnl = (buyPriceDiff * pos.buyLeg.lotSize) + (sellPriceDiff * pos.sellQty * pos.sellLeg.lotSize) + (pos.accumulatedSellPnl || 0);

      // Calculate exit fee and total fees
      const exitFee = calculateFee(exitBuyPrice, exitSpotPrice, pos.buyLeg.lotSize, pos.buyLeg.originalLotSize || 1) +
        calculateFee(exitSellPrice, exitSpotPrice, pos.sellQty, pos.sellLeg.lotSize);
      const totalFees = (pos.entryFee || 0) + exitFee;
      const netPnl = grossPnl - totalFees;

      // Add exit details to buyLeg and sellLeg JSON
      const buyLegWithExit = {
        ...pos.buyLeg,
        exitIv: pos.currentBuyIv || pos.buyLeg.exitIv || null
      };

      const sellLegWithExit = {
        ...pos.sellLeg,
        exitIv: pos.currentSellIv || pos.sellLeg.exitIv || null
      };

      // 1. Insert into trade_history
      const historyRow = {
        trade_id: pos.id,
        account_id: activeAccountId,
        underlying: pos.underlying,
        expiry: pos.expiry,
        type: pos.type,
        buy_leg: JSON.stringify(buyLegWithExit),
        sell_leg: JSON.stringify(sellLegWithExit),
        sell_qty: pos.sellQty,
        strike_diff: pos.strikeDiff,
        entry_time: pos.entryTime.toISOString(),
        entry_buy_price: pos.entryBuyPrice,
        entry_sell_price: pos.entrySellPrice,
        entry_spot_price: pos.entrySpotPrice,
        margin: pos.margin,
        exit_time: exitTime,
        exit_buy_price: exitBuyPrice,
        exit_sell_price: exitSellPrice,
        exit_spot_price: exitSpotPrice,
        realized_gross_pnl: grossPnl,
        realized_net_pnl: netPnl,
        exit_fee: exitFee,
        total_fees: totalFees,
        exit_reason: 'Manual Exit',
        is_partial: false
      };

      const { error: histError } = await supabase.from('trade_history').insert([historyRow]);
      if (histError) {
        console.error('Failed to insert into trade_history:', histError);
        alert(`Error recording trade history: ${histError.message}`);
        setIsExitingPosition(false);
        return;
      }

      // 2. Delete from active_positions
      const { error: delError } = await supabase.from('active_positions').delete().eq('id', pos.id);
      if (delError) {
        console.error('Failed to delete from active_positions:', delError);
        alert(`Error deleting active position: ${delError.message}`);
        setIsExitingPosition(false);
        return;
      }

      // 3. Immediately update UI state
      setPositions(prev => prev.filter(p => p.id !== pos.id));

      // Update last db write ref to prevent immediate auto-fetch clash
      lastDbWriteRef.current = Date.now();

      // Close the modal
      setPositionToExit(null);

      // 4. Refresh trade history
      fetchSupabaseTradeHistory();
      fetchHistoryStats();

    } catch (e) {
      console.error('Error during manual exit:', e);
      alert(`An error occurred: ${e.message}`);
    } finally {
      setIsExitingPosition(false);
    }
  };

  // ── Initial data load + Realtime subscription ─────────────────────────
  useEffect(() => {
    if (!activeAccountId) return;

    fetchSupabaseActivePositions();
    fetchHistoryStats();
    fetchSupabaseConfig();
    fetchSupabaseSchedules();

    const realtimeChannel = supabase
      .channel(`active_positions_changes_${activeAccountId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'active_positions', filter: `account_id=eq.${activeAccountId}` },
        (payload) => { applyPositionRealtimeChange(payload); }
      )
      .subscribe();

    const historyChannel = supabase
      .channel(`trade_history_changes_${activeAccountId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'trade_history', filter: `account_id=eq.${activeAccountId}` },
        (payload) => {
          // Use payload.new directly — no need to re-fetch all history on every insert
          const t = payload.new;
          if (!t || t.underlying !== underlying) return;
          const parsedBuyLeg = safeParseLeg(t.buy_leg);
          const parsedSellLeg = safeParseLeg(t.sell_leg);
          const newTrade = {
            id: t.trade_id || t.id,
            underlying: t.underlying, expiry: t.expiry, type: t.type,
            buyLeg: parsedBuyLeg, sellLeg: parsedSellLeg,
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
            entryBuyIv: parsedBuyLeg?.entryIv || null,
            entrySellIv: parsedSellLeg?.entryIv || null,
            exitBuyIv: parsedBuyLeg?.exitIv || null,
            exitSellIv: parsedSellLeg?.exitIv || null,
            _isPartial: t.is_partial || false,
            _exitedBuyQty: t.lot_size ?? parsedBuyLeg?.lotSize ?? 1,
          };
          setTradeHistory(prev => [newTrade, ...prev]);
          // Refresh the all-time aggregates from the server (single row) so the
          // KPIs stay correct without re-deriving sums/today-bucket on the client.
          fetchHistoryStats();
        }
      )
      .subscribe();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchSupabaseActivePositions();
        fetchSupabaseTradeHistory();
        fetchHistoryStats();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      supabase.removeChannel(realtimeChannel);
      supabase.removeChannel(historyChannel);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchHistoryStats, fetchSupabaseConfig, applyPositionRealtimeChange, activeAccountId]);

  // ── Engine heartbeat ──────────────────────────────────────────────────
  const fetchHeartbeat = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const { data, error } = await supabase
        .from('engine_heartbeat')
        .select('id, last_heartbeat, status, ws_status, underlying, expiry, active_positions, spot_price, wallet_balance, dry_run, max_positions, allocation_pct')
        .eq('id', `paper_trading_${activeAccountId}`);

      if (error || !data || data.length === 0) {
        setEngineStatus({ status: 'offline', lastHeartbeat: null, data: null });
        setWalletBalance(null);
        setEngineDryRun(null);
        setEngineMaxPositions(null);
        setEngineAllocationPct(null);
        return;
      }

      const row = data[0];
      setWalletBalance(row.wallet_balance != null ? Number(row.wallet_balance) : null);
      setEngineMaxPositions(row.max_positions != null ? Number(row.max_positions) : null);
      setEngineAllocationPct(row.allocation_pct != null ? Number(row.allocation_pct) : null);
      // Only meaningful when the engine is actually online (fresh heartbeat).
      const hbAge = Date.now() - new Date(row.last_heartbeat).getTime();
      setEngineDryRun(hbAge < HEARTBEAT_STALE_THRESHOLD ? row.dry_run : null);
      const age = Date.now() - new Date(row.last_heartbeat).getTime();
      const status = age < HEARTBEAT_ONLINE_THRESHOLD ? 'online'
        : age < HEARTBEAT_STALE_THRESHOLD ? 'stale' : 'offline';

      setEngineStatus({ status, lastHeartbeat: new Date(row.last_heartbeat), data: row.payload });

      // Use server's last evaluation time for the UI timestamp
      if (row.last_heartbeat) {
        setLastEvaluated(new Date(row.last_heartbeat).getTime());
      }
    } catch (e) { } finally { markLiveProbe('hb'); }
  }, [activeAccountId, markLiveProbe]);

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

  // ── Live exchange snapshot (real Delta state for live accounts) ──────────
  // Mirrors what the engine publishes to `live_exchange_state`. Only meaningful
  // for live accounts; paper accounts have no row so this stays null and the
  // workspace tabs fall back to their engine-derived views.
  const isActiveLive = activeAccount?.mode === 'live';
  // Tracks optimistic closes so a stale live-snapshot refetch can't resurrect
  // positions the user just closed. The engine only republishes its Delta snapshot
  // every ~20s, so a refetch in between returns the OLD snapshot (positions still
  // present) and would flash them back. We keep the just-closed legs hidden until
  // the engine publishes a snapshot that no longer contains them (or 25s elapses).
  const pendingCloseRef = useRef({ closeAll: null, symbols: new Map() });
  const CLOSE_GUARD_MS = 25000;
  const applyCloseGuard = useCallback((snap) => {
    if (!snap) return snap;
    const pc = pendingCloseRef.current;
    let out = snap;
    // Account-level flatten: hide ALL positions/orders/stops until the exchange
    // snapshot reports the account flat (or the guard times out).
    if (pc.closeAll) {
      const openLegs = (out.positions || []).filter(p => Number(p.size) !== 0);
      const timedOut = Date.now() - pc.closeAll.since > CLOSE_GUARD_MS;
      if (openLegs.length > 0 && !timedOut) {
        out = { ...out, positions: [], orders: [], stop_orders: [] };
      } else {
        pc.closeAll = null; // engine confirmed flat (or timeout) → trust the snapshot
      }
    }
    // Per-leg closes: hide each closed symbol until it's gone from the snapshot.
    if (pc.symbols.size) {
      const keep = new Map();
      for (const [sym, info] of pc.symbols) {
        const present = (out.positions || []).some(p => p.product_symbol === sym && Number(p.size) !== 0);
        if (present && Date.now() - info.since <= CLOSE_GUARD_MS) keep.set(sym, info);
      }
      pendingCloseRef.current.symbols = keep;
      if (keep.size) out = { ...out, positions: (out.positions || []).filter(p => !keep.has(p.product_symbol)) };
    }
    return out;
  }, []);
  const fetchLiveExchangeState = useCallback(async () => {
    if (!activeAccountId || !isActiveLive) { setLiveExchangeState(null); markLiveProbe('snap'); return; }
    try {
      const { data, error } = await supabase
        .from('live_exchange_state')
        // Select all columns so a not-yet-migrated `order_history` column can't
        // make the whole query fail (which would blank every live tab). It stays
        // undefined until migration 017 + the engine deploy land.
        .select('*')
        .eq('account_id', activeAccountId)
        .maybeSingle();
      if (error || !data) { setLiveExchangeState(null); return; }
      // Treat a stale snapshot (engine offline) as absent so tabs don't show ghosts.
      const age = Date.now() - new Date(data.updated_at).getTime();
      setLiveExchangeState(age < HEARTBEAT_STALE_THRESHOLD ? applyCloseGuard(data) : null);
    } catch (e) { setLiveExchangeState(null); }
    finally { markLiveProbe('snap'); }
  }, [activeAccountId, isActiveLive, applyCloseGuard, markLiveProbe]);

  // Reset the resolved gate whenever the selected account changes so we re-probe
  // (and re-show the loading state) instead of flashing the previous view.
  useEffect(() => {
    liveProbeRef.current = { hb: false, snap: false };
    setLiveViewResolved(false);
  }, [activeAccountId]);

  // Manual "Sync" — pull everything fresh on demand (no page reload needed).
  const [isSyncing, setIsSyncing] = useState(false);
  const syncAll = useCallback(async () => {
    setIsSyncing(true);
    try {
      await Promise.allSettled([
        fetchSupabaseActivePositions(),
        fetchSupabaseTradeHistory(),
        fetchHistoryStats(),
        fetchHeartbeat(),
        fetchLiveExchangeState(),
      ]);
    } finally {
      setIsSyncing(false);
    }
  }, [fetchSupabaseActivePositions, fetchSupabaseTradeHistory, fetchHistoryStats, fetchHeartbeat, fetchLiveExchangeState]);

  // Periodic auto-refresh of the live view (positions + snapshot) every 10s while the
  // tab is visible, as a safety net behind Realtime. Positions have their own Realtime
  // subscription (instant patch), so this poll only backstops a missed message — 10s is
  // plenty and halves the egress vs the old 5s. Heartbeat is NOT fetched here (it has
  // its own dedicated 30s poll above — fetching it here too was a redundant 5s read).
  // Skips the heavier trade-history/stats reads (those refresh on trade close).
  const liveSnapPollRef = useRef(0);
  useEffect(() => {
    if (!activeAccountId) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      fetchSupabaseActivePositions();
      // The live snapshot is Realtime-driven (subscription below refetches on every
      // change), so we don't re-pull its heavy payload every tick. Poll it only as a
      // slow safety net (every 3rd tick ≈ 30s) to catch a missed Realtime message.
      if (isActiveLive) {
        liveSnapPollRef.current = (liveSnapPollRef.current + 1) % 3;
        if (liveSnapPollRef.current === 0) fetchLiveExchangeState();
      }
    };
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, [activeAccountId, isActiveLive, fetchSupabaseActivePositions, fetchLiveExchangeState]);

  useEffect(() => {
    if (!isActiveLive) { setLiveExchangeState(null); return; }
    // Realtime-driven only — no 20s poll. The engine now upserts live_exchange_state
    // only when it structurally changes (else once per 60s keepalive), and Realtime
    // pushes each change → we refetch on demand. Dropping the redundant interval poll
    // removes a full-snapshot read every 20s per open tab. We still refetch once when
    // the tab regains focus, to catch up on anything missed while hidden.
    const refresh = () => { if (document.visibilityState === 'visible') fetchLiveExchangeState(); };
    refresh(); // prime on mount / account switch
    const handleVisibility = () => { if (document.visibilityState === 'visible') fetchLiveExchangeState(); };
    document.addEventListener('visibilitychange', handleVisibility);

    const channel = supabase
      .channel(`live_exchange_state_${activeAccountId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'live_exchange_state', filter: `account_id=eq.${activeAccountId}` },
        refresh)
      .subscribe();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      supabase.removeChannel(channel);
    };
  }, [fetchLiveExchangeState, isActiveLive, activeAccountId]);

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

          // Long-only held positions (short leg already exited) only need the long price.
          const isLongOnly = (pos.sellQty || 0) === 0;
          const canCompute = isLongOnly ? (latestBuy != null) : (latestBuy != null && latestSell != null);
          const buyPnl = canCompute ? ((latestBuy - pos.entryBuyPrice) || 0) : 0; // Sell - Buy
          const sellPnl = (canCompute && !isLongOnly) ? (((pos.entrySellPrice - latestSell) * pos.sellQty) || 0) : 0;
          const grossPnl = canCompute
            ? (buyPnl * pos.buyLeg.lotSize) + (sellPnl * (pos.sellLeg.lotSize || 0)) + (pos.accumulatedSellPnl || 0)
            : pos.unrealizedGrossPnl;
          const exitFee = canCompute
            ? calculateFee(latestBuy, spotPrice, pos.buyLeg.lotSize, pos.buyLeg.originalLotSize || 1) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize)
            : pos.currentExitFee;
          const totalFees = canCompute ? ((pos.entryFee || 0) + exitFee) : pos.currentTotalFees;

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
      'Initial Buy Qty', 'Initial Sell Qty',
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

      const initBuyQty = t.buyLeg?.initialScaledLotSize ?? t.buyLeg?.lotSize ?? 0;
      const initSellQty = t.buyLeg?.initialScaledLotSize !== undefined && t.buyLeg?.originalSellQty !== undefined
        ? (t.buyLeg.initialScaledLotSize * t.buyLeg.originalSellQty)
        : t.sellQty;

      return [
        formatDateTime(t.entryTime), formatDateTime(t.exitTime), fmtExpiry(t.expiry),
        t.type.toUpperCase(), `${buyLot.toFixed(2)}:${sellQty.toFixed(2)}`,
        `${(t.buyLeg?.originalLotSize || t.buyLeg.lotSize).toFixed(2)}:${(t.buyLeg?.originalSellQty || t.sellQty).toFixed(2)}`,
        initBuyQty.toFixed(2), initSellQty.toFixed(2),
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

  // Delta option symbols are like "C-BTC-95000-310125" / "P-BTC-…", so a plain
  // startsWith(underlying) misses them. Match the type-prefixed form instead.
  const liveBelongsToUnderlying = (sym) => {
    const s = sym || '';
    return s.startsWith(`C-${underlying}-`) || s.startsWith(`P-${underlying}-`);
  };

  const totalUnrealizedPnl = useLive
    ? (liveExchangeState?.positions || [])
        .filter(p => Number(p.size) !== 0 && liveBelongsToUnderlying(p.product_symbol))
        .reduce((s, p) => s + (Number(p.unrealized_pnl ?? p.unrealised_pnl) || 0), 0)
    : positions
        .filter(p => p.underlying === underlying)
        .reduce((s, p) => s + (includeFees ? (p.unrealizedNetPnl || 0) : (p.unrealizedGrossPnl || 0)), 0);

  // Session spot change (%) for the spot bar shown above the tables.
  if (spotPrice != null && spotOpenRef.current[underlying] == null) spotOpenRef.current[underlying] = spotPrice;
  const spotOpen = spotOpenRef.current[underlying];
  const spotChangePct = (spotOpen && spotPrice) ? ((spotPrice - spotOpen) / spotOpen) * 100 : null;

  // Realized P&L for the KPI cards.
  //  • Paper accounts: server-aggregated trade_history stats (get_trade_stats).
  //  • LIVE accounts: Delta's OWN realized P&L — sum of meta_data.pnl on each
  //    order-history record (the same number Delta shows in its Realized PnL
  //    column), so the cards match Delta exactly. Net subtracts Delta's own
  //    commission (paid_commission). Today = orders whose fill/close time
  //    (updated_at) falls on the local (IST) calendar day.
  const liveRealized = useMemo(() => {
    if (!useLive) return null;
    const orders = (liveExchangeState?.order_history || [])
      .filter(o => liveBelongsToUnderlying(o.product_symbol));
    const today = new Date().toDateString();
    let grossAll = 0, grossToday = 0, feesAll = 0, feesToday = 0;
    for (const o of orders) {
      const pnl = Number(o.meta_data?.pnl);         // realized P&L (USD), closes only
      const fee = Number(o.paid_commission ?? o.commission);
      let isToday = false;
      try { isToday = new Date(o.updated_at ?? o.created_at).toDateString() === today; } catch { /* skip */ }
      if (Number.isFinite(pnl)) { grossAll += pnl; if (isToday) grossToday += pnl; }
      if (Number.isFinite(fee)) { feesAll += fee; if (isToday) feesToday += fee; }
    }
    return {
      totalGross: grossAll, totalNet: grossAll - feesAll,
      todayGross: grossToday, todayNet: grossToday - feesToday,
    };
  }, [useLive, liveExchangeState, underlying]);

  const totalRealizedPnl = useLive
    ? (includeFees ? liveRealized.totalNet : liveRealized.totalGross)
    : (includeFees ? historyStats.totalNet : historyStats.totalGross);

  const totalPnl = totalRealizedPnl + totalUnrealizedPnl;

  const todayRealizedPnl = useLive
    ? (includeFees ? liveRealized.todayNet : liveRealized.todayGross)
    : (includeFees ? historyStats.todayNet : historyStats.todayGross);

  const todayPnl = todayRealizedPnl + totalUnrealizedPnl;
  const wins = includeFees ? historyStats.winNet : historyStats.winGross;
  const winRate = historyStats.totalCount > 0
    ? ((wins / historyStats.totalCount) * 100).toFixed(1) : '—';
  const calculatePositionMargin = useCallback((p) => {
    const buyPrice = p.currentBuyPrice != null ? p.currentBuyPrice : (p.entryBuyPrice || 0);
    const buyLot = p.buyLeg?.lotSize || 1;
    const sellLot = p.sellLeg?.lotSize || 1;
    const spot = spotPrice || p.entrySpotPrice || 0;
    const sellQty = p.sellQty;
    const longMargin = buyPrice * buyLot;
    const shortValue = Math.min(195000, spot * sellQty * sellLot);
    const leverage = 200;
    return longMargin + (shortValue / leverage);
  }, [spotPrice]);

  const totalMargin = React.useMemo(() => {
    if (useLive) {
      return (liveExchangeState?.positions || [])
        .filter(p => Number(p.size) !== 0 && liveBelongsToUnderlying(p.product_symbol))
        .reduce((s, p) => s + (Number(p.margin) || 0), 0);
    }
    return positions
      .filter(p => p.underlying === underlying)
      .reduce((s, p) => s + calculatePositionMargin(p), 0);
  }, [positions, underlying, calculatePositionMargin, useLive, liveExchangeState]);

  // Count SPREADS, not legs: Delta reports the long and short as separate positions,
  // but a spread = 1 position. Each spread has exactly one LONG leg (size > 0), so
  // counting long legs = counting spreads. (Margin/PnL above still use both legs.)
  const livePositions = useLive
    ? (liveExchangeState?.positions || []).filter(p => Number(p.size) > 0 && liveBelongsToUnderlying(p.product_symbol))
    : [];
  const activePositionsCount = useLive
    ? livePositions.length
    : positions.filter(p => p.underlying === underlying).length;
  const activeCallsCount = useLive
    ? livePositions.filter(p => (p.product_symbol || '').startsWith('C-')).length
    : positions.filter(p => p.type === 'call' && p.underlying === underlying).length;
  const activePutsCount = useLive
    ? livePositions.filter(p => (p.product_symbol || '').startsWith('P-')).length
    : positions.filter(p => p.type === 'put' && p.underlying === underlying).length;
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
    : engineStatus.status === 'stale' ? '#3b82f6'
      : '#f85149';

  // ── Render ────────────────────────────────────────────────────────────

  // Show loading spinner while auth state is resolving
  if (isAuthLoading) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" style={{ animation: 'spin 0.9s linear infinite' }}>
            <circle cx="12" cy="12" r="10" stroke="rgba(59, 130, 246,0.15)" />
            <path d="M12 2a10 10 0 0 1 10 10" />
          </svg>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Navbar
        activeTab="trading"
        onNavigate={onNavigate}
        theme={theme}
        toggleTheme={toggleTheme}
        badgeLabel={engineStatusLabel}
        badgeColor={engineStatusColor}
      />

      <div className="body trading-body" style={{ flexDirection: 'column', overflowY: 'auto' }}>
        {!session ? (
          <LoginCard
            authEmail={authEmail}
            setAuthEmail={setAuthEmail}
            authError={authError}
            isAuthenticating={isAuthenticating}
            handleAuthSubmit={handleAuthSubmit}
          />
        ) : (isAccountsLoaded && accounts.length === 0) ? (
          <FirstAccountCard
            onSubmit={handleSubmitCreate(handleModalSubmit)}
            register={registerCreate}
            errors={errorsCreate}
            isCreatingAccount={isCreatingAccount}
            watchAtmRatioScaling={watchCreateAtmRatioScaling}
            watchCreateExitType={watchCreateExitType}
            onCancel={handleLogout}
            setValue={setValueCreate}
            watch={watchCreate}
          />
        ) : (
          <>
            <AccountSelectorStrip
              accounts={accounts}
              activeAccountId={activeAccountId}
              setActiveAccountId={setActiveAccountId}
              triggerCreateAccount={triggerCreateAccount}
              triggerDeleteAccount={triggerDeleteAccount}
              triggerStartLive={triggerStartLive}
              triggerDisarmLive={triggerDisarmLive}
              triggerPauseAccount={triggerPauseAccount}
              triggerResumeAccount={triggerResumeAccount}
              triggerEditAccount={triggerEditAccount}
              engineDryRun={engineDryRun}
              userProfile={userProfile}
              session={session}
              handleLogout={handleLogout}
            />

            <ControlPanel
              underlying={underlying}
              updateConfig={updateConfig}
              selExpiry={selExpiry}
              filteredExpiries={filteredExpiries}
              activeAccountId={activeAccountId}
              accounts={accounts}
              triggerEditAccount={triggerEditAccount}
              isFiltersCollapsed={isFiltersCollapsed}
              setIsFiltersCollapsed={setIsFiltersCollapsed}
              draftConfig={draftConfig}
              updateDraftConfig={updateDraftConfig}
              isFiltersDirty={isFiltersDirty}
              handleApplyFilters={handleApplyFilters}
              handleCancelFilters={handleCancelFilters}
              isDefaultConfig={isDefaultConfig}
              handleResetFilters={handleResetFilters}
              spotPrice={spotPrice}
              schedules={schedules}
              setSchedules={setSchedules}
              onSaveSchedules={saveSupabaseSchedules}
              isSavingSchedules={isSavingSchedules}
              positions={positions}
              tradeHistory={tradeHistory}
            />


            <KpiDashboard
              todayPnl={todayPnl}
              todayRealizedPnl={todayRealizedPnl}
              totalUnrealizedPnl={totalUnrealizedPnl}
              totalPnl={totalPnl}
              totalRealizedPnl={totalRealizedPnl}
              winRate={winRate}
              wins={wins}
              tradeHistoryLength={historyStats.totalCount}
              activePositionsCount={activePositionsCount}
              activeCallsCount={activeCallsCount}
              activePutsCount={activePutsCount}
              totalMargin={totalMargin}
              isLive={activeAccount?.mode === 'live'}
              walletBalance={walletBalance}
              allocationPct={engineAllocationPct ?? activeAccount?.default_config?.balanceAllocationPct ?? 90}
              maxPositions={(() => {
                // Per-position margin (allocated ÷ maxPositions) sizes for the
                // BUSIEST window — the GREATEST (calls + puts) across ALL active
                // schedule windows — matching the engine's sizing, so it's not tied
                // to whichever window happens to be active now.
                const active = (schedules || []).filter(s => s.isActive);
                if (active.length > 0) {
                  return Math.max(1, ...active.map(s => (s.numberOfCalls || 0) + (s.numberOfPuts || 0)));
                }
                // No windows: fall back to the engine's published value, else base config.
                return engineMaxPositions ?? Math.max(1, (activeAccount?.default_config?.numberOfCalls ?? 3) + (activeAccount?.default_config?.numberOfPuts ?? 3));
              })()}
            />

            {/* Spot price — shown just above the trading tables */}
            {spotPrice != null && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 0 12px' }}>
                <div className="pt-spot-display">
                  <span className="pt-spot-label">SPOT</span>
                  <span className="pt-spot-value">${spotPrice.toLocaleString()}</span>
                  {spotChangePct != null && (
                    <span className={`pt-spot-chg ${spotChangePct >= 0 ? 'up' : 'down'}`}>
                      {spotChangePct >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%
                    </span>
                  )}
                </div>
              </div>
            )}

            <TradingWorkspace
              positions={positions}
              underlying={underlying}
              lastEvaluated={lastEvaluated}
              fetchSupabaseActivePositions={fetchSupabaseActivePositions}
              fetchSupabaseTradeHistory={fetchSupabaseTradeHistory}
              fetchHeartbeat={fetchHeartbeat}
              now={now}
              includeFees={includeFees}
              setIncludeFees={setIncludeFees}
              spotPrice={spotPrice}
              engineStatusColor={engineStatusColor}
              engineStatusLabel={engineStatusLabel}
              calculatePositionMargin={calculatePositionMargin}
              totalMargin={totalMargin}
              exitType={findActiveSchedule(schedules, now)?.exitType ?? config.exitType}
              exitPoints={findActiveSchedule(schedules, now)?.exitPoints ?? config.exitPoints}
              onExitPosition={(p) => setPositionToExit(p)}
              onCloseAll={triggerCloseAll}
              onCloseOrphan={triggerCloseOrphan}
              onCancelOrder={triggerCancelOrder}
              onSync={syncAll}
              isSyncing={isSyncing}
              filteredTradeHistory={filteredTradeHistory}
              historyFilterDate={historyFilterDate}
              setHistoryFilterDate={setHistoryFilterDate}
              adjustFilterDay={adjustFilterDay}
              resetToToday={resetToToday}
              filteredRealizedPnl={filteredRealizedPnl}
              filteredWins={filteredWins}
              exportCSV={exportCSV}
              schedules={schedules}
              tradeHistory={tradeHistory}
              isLiveAccount={activeAccount?.mode === 'live'}
              liveExchangeState={liveExchangeState}
              engineDryRun={engineDryRun}
              liveLoading={activeAccount?.mode === 'live' && !liveViewResolved}
            />
          </>
        )}
      </div>

      <CreateAccountModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSubmit={handleSubmitCreate(handleModalSubmit)}
        register={registerCreate}
        errors={errorsCreate}
        isCreating={isCreatingAccount}
        watchAtmRatioScaling={watchCreateAtmRatioScaling}
        watchCreateExitType={watchCreateExitType}
        profiles={profiles}
        userRole={userProfile?.role}
        setValue={setValueCreate}
        watch={watchCreate}
      />

      <DeleteAccountModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setAccountToDeleteId(null);
        }}
        onConfirm={handleConfirmDelete}
        isDeleting={isDeletingAccount}
        positions={positions}
        activeAccountId={activeAccountId}
        accountToDeleteId={accountToDeleteId}
        accounts={accounts}
      />

      <EditAccountModal
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          resetEdit();
        }}
        onSubmit={handleSubmitEdit(handleEditSubmit)}
        register={registerEdit}
        errors={errorsEdit}
        isSaving={isSavingAccount}
        watch={watchEdit}
        setValue={setValueEdit}
        credentialsMeta={editCredentialsMeta}
      />

      <ConfirmExitModal
        isOpen={!!positionToExit}
        onClose={() => setPositionToExit(null)}
        onConfirm={handleConfirmExitPosition}
        isExiting={isExitingPosition}
        position={positionToExit}
        includeFees={includeFees}
      />

      {/* In-app confirmation — centered modal card (same style as Logout) */}
      {confirmDialog && (
        <div className="modal-overlay-wrapper" onClick={() => setConfirmDialog(null)} style={{ animation: 'fadeIn 0.15s ease-out' }}>
          <div className="modal-container-delete" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400, margin: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#f85149', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              {confirmDialog.title || 'Please confirm'}
            </h3>
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
              {confirmDialog.message}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '6px' }}>
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { const fn = confirmDialog.onConfirm; setConfirmDialog(null); if (fn) fn(); }}
                style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#f85149', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
              >
                {confirmDialog.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notifications (top-right) */}
      <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none' }}>
        {toasts.map(t => {
          const accent = t.type === 'error' ? 'var(--put)' : t.type === 'success' ? 'var(--call)' : '#3b82f6';
          return (
            <div key={t.id} style={{
              background: 'rgba(10, 13, 18, 0.98)',
              border: '1px solid var(--border)',
              borderLeft: `4px solid ${accent}`,
              padding: '11px 16px', borderRadius: 8, color: 'var(--text)',
              fontSize: 12.5, fontWeight: 600, maxWidth: 340,
              boxShadow: '0 12px 32px rgba(0,0,0,0.6)', animation: 'slideIn 0.25s ease-out',
            }}>
              {t.msg}
            </div>
          );
        })}
      </div>
    </div>
  );
}