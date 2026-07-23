import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, apiGet, getTickers
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime, formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';
import { Loader2, AlertTriangle } from 'lucide-react';

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
  initialBalance: 3000,
  maxCombinedPositions: 4,
  combinedSplitPct: 70,
  entryBuyOffset: 10,
  entrySellOffset: 3
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

// Stable UUID for a schedule row. crypto.randomUUID is available in all modern
// browsers on https/localhost; getRandomValues is the belt-and-braces fallback so
// we NEVER hand the DB a non-uuid (which would fail the insert) or a missing id
// (which would break the "prune removed windows" step in saveSupabaseSchedules).
const genScheduleId = () => {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  maxCombinedPositions: cfg.maxCombinedPositions ?? 4,
  combinedSplitPct: cfg.combinedSplitPct ?? 70,
  minLongDist: cfg.minLongDist ?? 500,
  minStrikeDiff: cfg.minStrikeDiff ?? 800,
  atmRatioScaling: cfg.atmRatioScaling ?? true,
  atmRatioPctCall: cfg.atmRatioPctCall ?? 50,
  atmRatioPctPut: cfg.atmRatioPctPut ?? 25,
  maxNetPremium: cfg.maxNetPremium ?? 20,
  exitType: cfg.exitType ?? 'ATM',
  exitPoints: cfg.exitPoints ?? 0,
  slTpDecoyDiff: cfg.slTpDecoyDiff ?? 0,
  daysToExpiry: cfg.daysToExpiry ?? 0,
  hedgeStrikeType: 'none',
  hedgeCallPrice: 0,
  hedgeCallPct: 0,
  hedgePutPrice: 0,
  hedgePutPct: 0,
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
  // Mirrors the engine's getActiveSchedule: a covering window wins; otherwise the gap
  // carries the previous (most-recently-ended) window's config forward, not the base config.
  let mostRecent = null, minSinceEnd = Infinity;
  for (const s of schedules) {
    if (s.isActive === false) continue;
    const start = toMin(s.startTime), end = toMin(s.endTime);
    const inWin = start > end ? (istMin >= start || istMin < end) : (istMin >= start && istMin < end);
    if (inWin) return s;
    const sinceEnd = (istMin - end + 1440) % 1440;
    if (sinceEnd < minSinceEnd) { minSinceEnd = sinceEnd; mostRecent = s; }
  }
  return mostRecent;
};


export default function PaperTrading({ onNavigate, theme, toggleTheme, mode = 'paper' }) {
  // Which dashboard this instance is: 'paper' (Paper Trading) or 'live' (Live
  // Trading). The two tabs mount separate instances of this same component; they
  // share all logic but each only ever sees, manages and syncs accounts whose
  // account.mode matches this dashboard's mode.
  const dashboardMode = mode === 'live' ? 'live' : 'paper';
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
      mode: mode === 'live' ? 'live' : 'paper',
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
      initialBalance: 3000,
      maxCombinedPositions: 4,
      combinedSplitPct: 70,
      entryBuyOffset: 10,
      entrySellOffset: 3
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
    variableExitSlices: false,
    strategyVersion: 1,
    tradeDays: [0, 1, 2, 3, 4, 5, 6],
    // Paper full-deployment fill (migration 030) — paper only.
    fullDeployEnabled: false,
    fullDeployTime: '04:30'
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

  // Effective min-days-to-expiry driving expiry selection. Days-to-expiry lives per
  // schedule window for ALL accounts (migration 019), so mirror the engine and use the
  // SMALLEST (min) across active windows — the global expiry rolls to the nearest expiry
  // the nearest-eligible window allows; the account-level value is only a fallback.
  const effectiveMinDte = React.useMemo(() => {
    const activeWins = (schedules || []).filter(s => s.isActive);
    return activeWins.length > 0
      ? Math.max(0, Math.min(...activeWins.map(s => s.daysToExpiry ?? 0)))
      : (config?.daysToExpiry || 0);
  }, [config?.daysToExpiry, schedules]);

  const filteredExpiries = React.useMemo(() => {
    if (!expiries || expiries.length === 0) return [];
    const minDays = effectiveMinDte;
    const filtered = expiries.filter(exp => {
      const daysRemaining = (new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      return daysRemaining >= minDays;
    });
    return filtered.length > 0 ? filtered : expiries;
  }, [expiries, effectiveMinDte]);

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

    const rawInput = authEmail.trim().toLowerCase();
    if (!rawInput) {
      setAuthError('Please enter a valid email address.');
      setIsAuthenticating(false);
      return;
    }

    // Admin shortcut: typing the word "trade" (instead of an email) logs in as the
    // designated admin account. That account's profiles row must have role='admin',
    // and it must have been created through THIS flow (so its password matches the
    // derived one below). Applies to both Paper and Live (same component).
    const ADMIN_SHORTCUT = 'trade';
    const ADMIN_SHORTCUT_EMAIL = 'admin@vitticapital.ai';
    const email = rawInput === ADMIN_SHORTCUT ? ADMIN_SHORTCUT_EMAIL : rawInput;

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
  // True while our own schedule save round-trip is in flight, and true when the
  // local schedule state has unsaved edits. Both gate the cross-tab Realtime resync
  // (below) so it never (a) reacts to our own writes or (b) stomps in-progress edits.
  const isSavingSchedulesRef = useRef(false);
  const schedulesDirtyRef = useRef(false);
  // Same idea for base config: gate the cross-device config resync so it ignores our
  // own writes and never stomps unsaved form edits (isFiltersDirty mirrored to a ref
  // so the Realtime callback can read the latest value).
  const isSavingConfigRef = useRef(false);
  const configDirtyRef = useRef(false);

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
        // Did the effective days-to-expiry filter actually change? (v2 = peak of windows)
        const daysFilterChanged = lastDaysToExpiryRef.current !== null && lastDaysToExpiryRef.current !== effectiveMinDte;
        lastDaysToExpiryRef.current = effectiveMinDte;

        let isExpiryInvalid = !selExpiry || !exps.includes(selExpiry);

        // If the effective filter changed, we ALWAYS want to select the nearest matching expiry
        if (daysFilterChanged) {
          isExpiryInvalid = true;
        } else if (!isExpiryInvalid && selExpiry) {
          // If the filter did not change, we only invalidate the expiry if it violates the minimum days requirement
          const daysRemaining = (new Date(selExpiry).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
          if (daysRemaining < effectiveMinDte) {
            isExpiryInvalid = true;
          }
        }

        if (isExpiryInvalid) {
          let selectedExpiry = null;
          for (const exp of exps) {
            const daysRemaining = (new Date(exp).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
            if (daysRemaining >= effectiveMinDte) {
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
      lastDaysToExpiryRef.current = effectiveMinDte;
    }
  }, [isConfigLoaded, products, selExpiry, effectiveMinDte]);

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
        const mappedAccounts = data.map(acc => ({
          ...acc,
          default_config: normalizeAccountDefaultConfig(acc.default_config)
        }));

        // This dashboard only ever manages accounts matching its mode: the Paper
        // Trading tab shows mode !== 'live', the Live Trading tab shows mode === 'live'.
        const normalizedAccounts = mappedAccounts.filter(
          acc => (acc.mode === 'live' ? 'live' : 'paper') === dashboardMode
        );

        setAccounts(normalizedAccounts);
        if (normalizedAccounts.length > 0) {
          setActiveAccountId(prev => {
            if (prev && normalizedAccounts.some(a => a.id === prev)) return prev;
            return normalizedAccounts[0].id;
          });
        } else {
          setActiveAccountId(null);
        }

        const staleAccounts = mappedAccounts.filter((acc, index) => {
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
          ch.postMessage({ type: `ACCOUNTS_SYNC_${dashboardMode}`, payload: { accounts: normalizedAccounts }, senderId: 'paper-trading-dashboard', timestamp: Date.now() });
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
      .channel(`accounts_changes_ui_${dashboardMode}`)
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
      initialBalance: data.initialBalance,
      maxCombinedPositions: data.maxCombinedPositions,
      combinedSplitPct: data.combinedSplitPct,
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
          short_exit_price: data.shortExitPrice ?? 1.1,
          long_exit_slices: data.longExitSlices ?? 10,
          variable_exit_slices: data.variableExitSlices ?? false,
          balance_allocation_pct: data.balanceAllocationPct ?? 90,
          initial_balance: data.initialBalance ?? 3000,
          max_combined_positions: data.maxCombinedPositions ?? 4,
          combined_split_pct: data.combinedSplitPct ?? 70,
          entry_buy_offset: data.entryBuyOffset ?? 10,
          entry_sell_offset: data.entrySellOffset ?? 3,
          // Paper accounts are the experimental testbed → v2; live starts on stable v1.
          strategy_version: accountMode === 'live' ? 1 : 2,
          trade_days: [0, 1, 2, 3, 4, 5, 6]
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
      mode: dashboardMode,
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
      variableExitSlices: config.variableExitSlices ?? false,
      balanceAllocationPct: config.balanceAllocationPct ?? 90,
      initialBalance: config.initialBalance ?? 3000,
      maxCombinedPositions: config.maxCombinedPositions ?? 4,
      combinedSplitPct: config.combinedSplitPct ?? 70
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
      initialBalance: activeAccount.default_config?.initialBalance ?? 3000,
      entryBuyOffset: activeAccount.default_config?.entryBuyOffset ?? 10,
      entrySellOffset: activeAccount.default_config?.entrySellOffset ?? 3
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
      const buyOff = Number.isFinite(data.entryBuyOffset) ? data.entryBuyOffset : 10;
      const sellOff = Number.isFinite(data.entrySellOffset) ? data.entrySellOffset : 3;
      // Paper starting equity (initial + realized). Ignored by live accounts.
      const initBal = Number.isFinite(data.initialBalance) ? data.initialBalance : 3000;
      const activeAccount = accounts.find(a => a.id === activeAccountId);
      if (activeAccount?.default_config) {
        updatePayload.default_config = {
          ...activeAccount.default_config,
          balanceAllocationPct: allocPct,
          initialBalance: initBal,
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
          initial_balance: initBal,
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

  // ── Telegram per-account linking (live accounts) ──────────────────────
  // "Connect" writes a fresh single-use link code; the UI builds a t.me/<bot>?start=<code>
  // deep link. When the user presses Start, the engine's bot listener matches the code,
  // stores telegram_chat_id and clears the code — surfaced back here via Realtime refetch.
  const [telegramBusy, setTelegramBusy] = useState(false);
  const genTelegramCode = () => {
    try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, ''); } catch { /* fall through */ }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  };
  const handleTelegramConnect = async (accountId) => {
    if (!accountId) return;
    setTelegramBusy(true);
    try { await updateAccountFlags(accountId, { telegram_link_code: genTelegramCode() }); }
    finally { setTelegramBusy(false); }
  };
  const handleTelegramDisconnect = async (accountId) => {
    if (!accountId) return;
    setTelegramBusy(true);
    try { await updateAccountFlags(accountId, { telegram_chat_id: null, telegram_link_code: null }); }
    finally { setTelegramBusy(false); }
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
    isSavingConfigRef.current = true;
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
        short_exit_price: newCfg.shortExitPrice ?? 1.1,
        long_exit_slices: newCfg.longExitSlices ?? 10,
        variable_exit_slices: newCfg.variableExitSlices ?? false,
        trade_days: Array.isArray(newCfg.tradeDays) ? newCfg.tradeDays : [0, 1, 2, 3, 4, 5, 6],
        full_deploy_enabled: newCfg.fullDeployEnabled ?? false,
        full_deploy_time: newCfg.fullDeployTime ?? '04:30',
        updated_at: new Date().toISOString()
      }).select();
      if (error) {
        console.error('[saveSupabaseConfig] supabase error:', error);
      } else {
        console.log('[saveSupabaseConfig] success:', data);
      }
    } catch (e) {
      console.error('[saveSupabaseConfig] exception:', e);
    } finally {
      isSavingConfigRef.current = false;
    }
  }, [activeAccountId, configDbId]);

  // The 8 sizing/scaling fields (calls/puts, spread width, spot distance, ATM
  // scaling + call/put %, re-entry step) are not shown in the Control Panel.
  // They are set at account creation (base config = the 24/7 backup) and
  // overridden per time window in the Schedule Panel.
  const FILTER_KEYS = [
    'underlying',
    'expiry',
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
    'variableExitSlices',
    'tradeDays',
    'fullDeployEnabled',
    'fullDeployTime'
  ];

  const updateConfig = (keyOrObj, value) => {
    const updates = typeof keyOrObj === 'object' ? keyOrObj : { [keyOrObj]: value };
    const parsedUpdates = {};
    for (const k of Object.keys(updates)) {
      const val = updates[k];
      if (k === 'exitType' || k === 'variableExitSlices' || k === 'atmRatioScaling' || k === 'underlying' || k === 'expiry' || k === 'tradeDays') {
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
        tabBroadcast(`CONFIG_SYNC_${dashboardMode}`, { config: newConfig });
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
      if (k === 'tradeDays') {
        const arr1 = Array.isArray(val1) ? val1 : [];
        const arr2 = Array.isArray(val2) ? val2 : [];
        if (arr1.length !== arr2.length) return true;
        return arr1.some((v, idx) => v !== arr2[idx]);
      }
      if (k === 'exitType' || k === 'variableExitSlices' || k === 'atmRatioScaling' || k === 'underlying' || k === 'expiry'
        || k === 'fullDeployEnabled' || k === 'fullDeployTime') {
        return val1 !== val2;
      }
      const num1 = (val1 === '' || val1 === '-' || val1 == null) ? null : Number(val1);
      const num2 = (val2 === '' || val2 === '-' || val2 == null) ? null : Number(val2);
      return num1 !== num2;
    });
  }, [draftConfig, config]);

  // Keep a ref copy so the cross-device config resync (below) can read the latest
  // dirty state from inside its Realtime callback without re-subscribing.
  useEffect(() => { configDirtyRef.current = isFiltersDirty; }, [isFiltersDirty]);

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
        tabBroadcast(`CONFIG_SYNC_${dashboardMode}`, { config: resetConfig });
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
          initial_balance: 3000,
          max_combined_positions: 4,
          combined_split_pct: 70,
          exit_type: 'ATM',
          exit_points: 0,
          variable_exit_slices: false,
          strategy_version: 1,
          trade_days: [0, 1, 2, 3, 4, 5, 6],
          full_deploy_enabled: false,
          full_deploy_time: '04:30',
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
          // Account-level exchange SL/TP decoy fallback (migration 031). Per-window value
          // (SchedulePanel) is primary; this seeds a new Window 1. Live only.
          slTpDecoyDiff: data.sl_tp_decoy_diff ?? 0,
          shortExitPrice: data.short_exit_price ?? 1.1,
          longExitSlices: data.long_exit_slices ?? 10,
          variableExitSlices: data.variable_exit_slices ?? false,
          balanceAllocationPct: data.balance_allocation_pct ?? 90,
          // Paper funded-account model (migration 027). Live accounts ignore these.
          initialBalance: data.initial_balance ?? 3000,
          maxCombinedPositions: data.max_combined_positions ?? 4,
          combinedSplitPct: data.combined_split_pct ?? 70,
          // Which strategy logic this account runs (1 = stable/live, 2+ = experimental
          // paper). Gate v2-only UI controls on this so they don't show on live accounts,
          // e.g. {config.strategyVersion >= 2 && <NewFilterField />}. See migration 018.
          strategyVersion: data.strategy_version ?? 1,
          // Weekdays new entries are allowed on (0=Sun..6=Sat). v2/paper entry-gate. See migration 021.
          tradeDays: Array.isArray(data.trade_days) ? data.trade_days : [0, 1, 2, 3, 4, 5, 6],
          // Paper full-deployment fill (migration 030) — paper only.
          fullDeployEnabled: data.full_deploy_enabled ?? false,
          fullDeployTime: data.full_deploy_time ?? '04:30'
        };
        setConfig(loadedConfig);
        setDraftConfig(loadedConfig);
        setConfigDbId(data.id);
        setIsConfigLoaded(true);
        // Return the freshly-loaded config so the schedule fetch can seed Window 1 from
        // it directly, instead of racing the async setConfig → configRef update (which
        // left a new account's Window 1 seeded from the PREVIOUS account's / default config).
        return loadedConfig;
      }
    } catch (e) { }
    return null;
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

  const fetchSupabaseSchedules = useCallback(async (cfgForSeed = null) => {
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
          maxCombinedPositions: s.max_combined_positions ?? 4,
          combinedSplitPct: s.combined_split_pct ?? 70,
          minLongDist: s.min_long_dist ?? 500,
          minStrikeDiff: s.min_strike_diff ?? 800,
          atmRatioScaling: s.atm_ratio_scaling ?? true,
          atmRatioPctCall: s.atm_ratio_distance_call ?? 50,
          atmRatioPctPut: s.atm_ratio_distance_put ?? 25,
          maxNetPremium: s.max_net_premium ?? 20,
          exitType: s.exit_type ?? 'ATM',
          exitPoints: s.exit_points ?? 0,
          slTpDecoyDiff: s.sl_tp_decoy_diff ?? 0,
          daysToExpiry: s.days_to_expiry ?? 0,
          hedgeStrikeType: s.hedge_strike_type ?? 'none',
          hedgeCallPrice: s.hedge_call_price ?? 0,
          hedgeCallPct: s.hedge_call_pct ?? 0,
          hedgePutPrice: s.hedge_put_price ?? 0,
          hedgePutPct: s.hedge_put_pct ?? 0,
          isActive: s.is_active ?? true,
          sort_order: s.sort_order ?? 0,
        }));
        // Guarantee a permanent Window 1. Accounts with no windows get one
        // seeded from base config (so the initial values are visible/editable);
        // it persists on the next auto-save (lastSaved snapshot excludes it).
        const finalList = mapped.length > 0
          ? mapped
          : [makeFirstWindow(cfgForSeed ?? configRef.current)];
        setSchedules(finalList);
        lastSavedSchedulesRef.current = JSON.stringify(mapped.map(s => ({
          label: s.label,
          startTime: s.startTime,
          endTime: s.endTime,
          numberOfCalls: s.numberOfCalls,
          numberOfPuts: s.numberOfPuts,
          maxCombinedPositions: s.maxCombinedPositions,
          combinedSplitPct: s.combinedSplitPct,
          minLongDist: s.minLongDist,
          minStrikeDiff: s.minStrikeDiff,
          atmRatioScaling: s.atmRatioScaling,
          atmRatioPctCall: s.atmRatioPctCall,
          atmRatioPctPut: s.atmRatioPctPut,
          maxNetPremium: s.maxNetPremium,
          exitType: s.exitType,
          exitPoints: s.exitPoints,
          slTpDecoyDiff: s.slTpDecoyDiff,
          daysToExpiry: s.daysToExpiry,
          hedgeStrikeType: s.hedgeStrikeType,
          hedgeCallPrice: s.hedgeCallPrice,
          hedgeCallPct: s.hedgeCallPct,
          hedgePutPrice: s.hedgePutPrice,
          hedgePutPct: s.hedgePutPct,
          isActive: s.isActive
        })));
      }
    } catch (e) { console.error('Schedule fetch error', e); }
  }, [activeAccountId]);

  const saveSupabaseSchedules = useCallback(async () => {
    if (!activeAccountId) return;
    setIsSavingSchedules(true);
    isSavingSchedulesRef.current = true;
    try {
      // Stable ids: reuse a persisted row's uuid, mint one for new/seed windows. This
      // lets us UPSERT in place instead of DELETE-all-then-INSERT — so a failed write
      // can NEVER leave the account with zero rows (which would reseed Window 1 from
      // base config and silently reset the user's filters).
      const rows = schedules.map((s, i) => ({
        id: UUID_RE.test(String(s.id)) ? s.id : genScheduleId(),
        account_id: activeAccountId,
        label: s.label || 'Window',
        start_time: s.startTime,
        end_time: s.endTime,
        number_of_calls: s.numberOfCalls ?? 3,
        number_of_puts: s.numberOfPuts ?? 3,
        max_combined_positions: s.maxCombinedPositions ?? 4,
        combined_split_pct: s.combinedSplitPct ?? 70,
        min_long_dist: s.minLongDist ?? 500,
        min_strike_diff: s.minStrikeDiff ?? 800,
        atm_ratio_scaling: s.atmRatioScaling ?? true,
        atm_ratio_distance_call: s.atmRatioPctCall ?? 50,
        atm_ratio_distance_put: s.atmRatioPctPut ?? 25,
        max_net_premium: s.maxNetPremium ?? 20,
        exit_type: s.exitType ?? 'ATM',
        exit_points: s.exitPoints ?? 0,
        sl_tp_decoy_diff: s.slTpDecoyDiff ?? 0,
        days_to_expiry: s.daysToExpiry ?? 0,
        hedge_strike_type: s.hedgeStrikeType ?? 'none',
        hedge_call_price: s.hedgeCallPrice ?? 0,
        hedge_call_pct: s.hedgeCallPct ?? 0,
        hedge_put_price: s.hedgePutPrice ?? 0,
        hedge_put_pct: s.hedgePutPct ?? 0,
        is_active: s.isActive ?? true,
        sort_order: i,
        updated_at: new Date().toISOString(),
      }));

      // 1) Upsert every current window. If this fails we RETURN without deleting
      //    anything — the existing rows stay intact (no wipe → no reseed).
      if (rows.length > 0) {
        const { error: upErr } = await supabase
          .from('paper_trading_schedules')
          .upsert(rows, { onConflict: 'id' });
        if (upErr) { console.error('Upsert schedules error:', upErr); return; }
      }

      // 2) Prune only the windows the user removed (in DB but no longer in state).
      //    Runs only after a successful upsert, so it can never cause data loss.
      const keepIds = rows.map(r => r.id);
      let delQuery = supabase.from('paper_trading_schedules').delete().eq('account_id', activeAccountId);
      if (keepIds.length > 0) delQuery = delQuery.not('id', 'in', `(${keepIds.map(id => `"${id}"`).join(',')})`);
      const { error: delErr } = await delQuery;
      if (delErr) console.error('Prune removed schedules error:', delErr);

      const savedJson = JSON.stringify(schedules.map(s => ({
        label: s.label,
        startTime: s.startTime,
        endTime: s.endTime,
        numberOfCalls: s.numberOfCalls,
        numberOfPuts: s.numberOfPuts,
        maxCombinedPositions: s.maxCombinedPositions,
        combinedSplitPct: s.combinedSplitPct,
        minLongDist: s.minLongDist,
        minStrikeDiff: s.minStrikeDiff,
        atmRatioScaling: s.atmRatioScaling,
        atmRatioPctCall: s.atmRatioPctCall,
        atmRatioPctPut: s.atmRatioPctPut,
        maxNetPremium: s.maxNetPremium,
        exitType: s.exitType,
        exitPoints: s.exitPoints,
        slTpDecoyDiff: s.slTpDecoyDiff,
        daysToExpiry: s.daysToExpiry,
        hedgeStrikeType: s.hedgeStrikeType,
        hedgeCallPrice: s.hedgeCallPrice,
        hedgeCallPct: s.hedgeCallPct,
        hedgePutPrice: s.hedgePutPrice,
        hedgePutPct: s.hedgePutPct,
        isActive: s.isActive
      })));
      lastSavedSchedulesRef.current = savedJson;
      schedulesDirtyRef.current = false;

      await fetchSupabaseSchedules();
    } catch (e) { console.error('Schedule save error', e); }
    finally { setIsSavingSchedules(false); isSavingSchedulesRef.current = false; }
  }, [activeAccountId, schedules, fetchSupabaseSchedules]);

  const isSchedulesDirty = React.useMemo(() => {
    if (!schedules || lastSavedSchedulesRef.current === null) return false;
    const currentJson = JSON.stringify(schedules.map(s => ({
      label: s.label,
      startTime: s.startTime,
      endTime: s.endTime,
      numberOfCalls: s.numberOfCalls,
      numberOfPuts: s.numberOfPuts,
      maxCombinedPositions: s.maxCombinedPositions,
      combinedSplitPct: s.combinedSplitPct,
      minLongDist: s.minLongDist,
      minStrikeDiff: s.minStrikeDiff,
      atmRatioScaling: s.atmRatioScaling,
      atmRatioPctCall: s.atmRatioPctCall,
      atmRatioPctPut: s.atmRatioPctPut,
      maxNetPremium: s.maxNetPremium,
      exitType: s.exitType,
      exitPoints: s.exitPoints,
      daysToExpiry: s.daysToExpiry,
      hedgeStrikeType: s.hedgeStrikeType,
      hedgeCallPrice: s.hedgeCallPrice,
      hedgeCallPct: s.hedgeCallPct,
      hedgePutPrice: s.hedgePutPrice,
      hedgePutPct: s.hedgePutPct,
      isActive: s.isActive
    })));
    return lastSavedSchedulesRef.current !== currentJson;
  }, [schedules]);

  useEffect(() => {
    schedulesDirtyRef.current = isSchedulesDirty;
  }, [isSchedulesDirty]);

  const handleCancelSchedules = useCallback(async () => {
    await fetchSupabaseSchedules();
  }, [fetchSupabaseSchedules]);

  const handleResetSchedules = useCallback(() => {
    setSchedules([makeFirstWindow(configRef.current)]);
  }, []);

  // Cross-tab / cross-device schedule sync. Without this, a second open tab (or
  // phone) keeps a STALE copy of the schedules; the next local edit there re-saves
  // the whole stale set and silently reverts filters changed elsewhere. We subscribe
  // to this account's schedule changes and refetch — but skip while our OWN save is
  // in flight (our own events) or while there are unsaved local edits (don't stomp
  // what the user is typing). The burst of a save is coalesced into one refetch.
  useEffect(() => {
    if (!activeAccountId) return;
    let debounce = null;
    const channel = supabase
      .channel(`paper_trading_schedules_${activeAccountId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trading_schedules', filter: `account_id=eq.${activeAccountId}` },
        () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            if (isSavingSchedulesRef.current) return; // our own write
            if (schedulesDirtyRef.current) return;    // unsaved local edits — don't clobber
            fetchSupabaseSchedules();
          }, 400);
        }
      )
      .subscribe();
    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [activeAccountId, fetchSupabaseSchedules]);

  // Cross-DEVICE base-config sync. Same-browser tabs already sync via BroadcastChannel
  // (useTabListener → CONFIG_SYNC), but a second DEVICE stays stale. Subscribe to this
  // account's config row and refetch on change — skipping our own writes (isSavingConfigRef)
  // and unsaved form edits (configDirtyRef) so we never clobber in-progress changes.
  // Bonus: the engine's expiry auto-select now reflects across devices too.
  useEffect(() => {
    if (!activeAccountId) return;
    let debounce = null;
    const channel = supabase
      .channel(`paper_trading_config_${activeAccountId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trading_config', filter: `account_id=eq.${activeAccountId}` },
        () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            if (isSavingConfigRef.current) return; // our own write
            if (configDirtyRef.current) return;    // unsaved local edits — don't clobber
            fetchSupabaseConfig();
          }, 400);
        }
      )
      .subscribe();
    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [activeAccountId, fetchSupabaseConfig]);

  // ── Supabase reads ────────────────────────────────────────────────────
  // Shared DB-row → position mapper (preserves client-computed live fields).
  const mapDbPosition = useCallback((p, existing) => {
    const buyLeg = safeParseLeg(p.buy_leg);
    const sellLeg = safeParseLeg(p.sell_leg);
    const hedgeLeg = safeParseLeg(p.hedge_leg); // 3rd long-only leg (triplet); null = plain 2-leg
    if (!buyLeg || !sellLeg) return null;
    return {
      id: p.id, underlying: p.underlying, expiry: p.expiry, type: p.type,
      buyLeg, sellLeg, hedgeLeg,
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
          hedgeLeg: safeParseLeg(t.hedge_leg),
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
    // Load config FIRST, then seed schedules from it — so a new account's Window 1 is
    // seeded from its own freshly-loaded config, not a stale configRef (see fetchSupabaseConfig).
    (async () => {
      const cfg = await fetchSupabaseConfig();
      await fetchSupabaseSchedules(cfg);
    })();

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
    // Realtime-driven only — no 20s poll. The engine upserts live_exchange_state
    // only when it structurally changes (else once per 60s keepalive), and Realtime
    // pushes each change with the FULL new row in the payload. We apply that row
    // directly instead of firing a second `.select('*')` read per change — killing
    // the double-read of the heaviest payload in the app (positions + orders +
    // fills + order_history) per open tab.
    fetchLiveExchangeState(); // prime on mount / account switch
    // Apply an already-delivered row through the same staleness + close-guard path
    // fetchLiveExchangeState uses, so behaviour is identical minus the extra read.
    const applyRow = (row) => {
      if (!row) { setLiveExchangeState(null); return; }
      const age = Date.now() - new Date(row.updated_at).getTime();
      setLiveExchangeState(age < HEARTBEAT_STALE_THRESHOLD ? applyCloseGuard(row) : null);
    };
    const onChange = (payload) => {
      const row = payload?.new;
      // Realtime truncates oversized rows (columns arrive missing). If the payload
      // looks complete, use it for free; otherwise fall back to a full refetch so a
      // large snapshot is never dropped or partially applied.
      if (payload?.eventType !== 'DELETE' && row && typeof row === 'object'
          && 'updated_at' in row && 'positions' in row) {
        applyRow(row);
      } else {
        fetchLiveExchangeState();
      }
    };
    // On regaining focus, catch up on anything the socket missed while backgrounded
    // (browsers can suspend WS in hidden tabs). One read on show, not per change.
    const handleVisibility = () => { if (document.visibilityState === 'visible') fetchLiveExchangeState(); };
    document.addEventListener('visibilitychange', handleVisibility);

    const channel = supabase
      .channel(`live_exchange_state_${activeAccountId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'live_exchange_state', filter: `account_id=eq.${activeAccountId}` },
        onChange)
      .subscribe();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      supabase.removeChannel(channel);
    };
  }, [fetchLiveExchangeState, isActiveLive, activeAccountId, applyCloseGuard]);

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

          // Attached hedge leg (3rd long) — its own live bid feeds the position's P&L.
          const hasHedge = pos.hedgeLeg && (pos.hedgeLeg.lotSize || 0) > 0;
          const tickerHedge = hasHedge ? live[pos.hedgeLeg.symbol] : null;
          const latestHedge = tickerHedge?.bid ?? tickerHedge?.lastPrice ?? tickerHedge?.markPrice ?? null;

          // If we don't have any price at all, skip this position's updates
          if (latestBuy == null && latestSell == null && latestHedge == null) return pos;

          // Long-only held positions (short leg already exited) only need the long price.
          const isLongOnly = (pos.sellQty || 0) === 0;
          // Hedge-only survivor: main long fully exited, only the hedge remains.
          const isHedgeOnly = isLongOnly && (pos.buyLeg.lotSize || 0) <= 0 && hasHedge;
          const canCompute = isHedgeOnly
            ? (latestHedge != null)
            : (isLongOnly ? (latestBuy != null) : (latestBuy != null && latestSell != null));
          const buyPnl = canCompute ? ((latestBuy - pos.entryBuyPrice) || 0) : 0; // Sell - Buy
          const sellPnl = (canCompute && !isLongOnly) ? (((pos.entrySellPrice - latestSell) * pos.sellQty) || 0) : 0;
          const hedgePnl = (canCompute && hasHedge && latestHedge != null)
            ? (((latestHedge - (pos.hedgeLeg.entryPrice || 0)) * pos.hedgeLeg.lotSize) || 0) : 0;
          const grossPnl = canCompute
            ? (buyPnl * pos.buyLeg.lotSize) + (sellPnl * (pos.sellLeg.lotSize || 0)) + hedgePnl + (pos.accumulatedSellPnl || 0)
            : pos.unrealizedGrossPnl;
          const hedgeExitFee = (canCompute && hasHedge && latestHedge != null)
            ? calculateFee(latestHedge, spotPrice, pos.hedgeLeg.lotSize, pos.hedgeLeg.originalLotSize || 1) : 0;
          const exitFee = canCompute
            ? calculateFee(latestBuy, spotPrice, pos.buyLeg.lotSize, pos.buyLeg.originalLotSize || 1) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize) + hedgeExitFee
            : pos.currentExitFee;
          // Position entry fee (main legs) + the hedge's own entry fee, tracked in hedgeLeg.
          const combinedEntryFee = (pos.entryFee || 0) + (hasHedge ? (pos.hedgeLeg.entryFee || 0) : 0);
          const totalFees = canCompute ? (combinedEntryFee + exitFee) : pos.currentTotalFees;

          return {
            ...pos,
            currentBuyPrice: latestBuy,
            currentSellPrice: latestSell,
            currentHedgePrice: latestHedge ?? pos.currentHedgePrice ?? null,
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
    [`CONFIG_SYNC_${dashboardMode}`]: (payload) => {
      if (payload.config) {
        setConfig(payload.config);
        setDraftConfig(payload.config);
      }
    },
    [`ACCOUNTS_SYNC_${dashboardMode}`]: (payload) => {
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

  // LIVE unrealized P&L. The engine's snapshot deliberately suppresses mark/unrealized
  // updates (to keep egress flat), so the snapshot's own `unrealized_pnl` is stale by up
  // to the 60s keepalive — which made Daily P&L (= today realized + unrealized) lag/read
  // wrong. Recompute it here from the LIVE WS mark (~1s fresh), exactly as Delta does:
  // size × contract_value × (mark − entry) — signed size makes shorts profit on decay.
  // Fall back to the snapshot's unrealized_pnl only when no live mark is available yet
  // (symbol not on the WS feed / cross-expiry / orphan leg). Zero extra Supabase egress.
  const totalUnrealizedPnl = useLive
    ? (liveExchangeState?.positions || [])
        .filter(p => Number(p.size) !== 0 && liveBelongsToUnderlying(p.product_symbol))
        .reduce((s, p) => {
          const size = Number(p.size) || 0;
          const cv = Number(p.product?.contract_value) || 0.001;
          const entry = Number(p.entry_price);
          const markNow = Number(latestTickerDataRef.current?.[p.product_symbol]?.markPrice);
          if (Number.isFinite(markNow) && Number.isFinite(entry)) {
            return s + size * cv * (markNow - entry);
          }
          return s + (Number(p.unrealized_pnl ?? p.unrealised_pnl) || 0);
        }, 0)
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
    // Triplet 3rd leg (long-only): premium paid = its margin.
    const hedgeMargin = (p.hedgeLeg && (p.hedgeLeg.lotSize || 0) > 0)
      ? (p.currentHedgePrice != null ? p.currentHedgePrice : (p.hedgeLeg.entryPrice || 0)) * p.hedgeLeg.lotSize
      : 0;
    return longMargin + (shortValue / leverage) + hedgeMargin;
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
          <Loader2 size={36} className="animate-spin" stroke="var(--accent)" strokeWidth={2.5} style={{ animation: 'spin 0.9s linear infinite' }} />
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Navbar
        activeTab={dashboardMode === 'live' ? 'live' : 'trading'}
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
            mode={dashboardMode}
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
              isSavingSchedules={isSavingSchedules}
              isSchedulesDirty={isSchedulesDirty}
              onApplySchedules={saveSupabaseSchedules}
              onCancelSchedules={handleCancelSchedules}
              onResetSchedules={handleResetSchedules}
              positions={positions}
              tradeHistory={tradeHistory}
              historyFilterDate={historyFilterDate}
              now={now}
              strategyVersion={config.strategyVersion ?? 1}
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
              isPaper={activeAccount?.mode !== 'live'}
              paperEquity={activeAccount?.mode !== 'live'
                ? (config.initialBalance ?? activeAccount?.default_config?.initialBalance ?? 3000) + (totalRealizedPnl || 0)
                : null}
              maxPositions={(() => {
                const active = (schedules || []).filter(s => s.isActive);
                if (activeAccount?.mode !== 'live') {
                  // PAPER: per-position margin = allocated ÷ the ACTIVE window's Max
                  // Combined Positions (matches the engine's active-window divisor).
                  const win = findActiveSchedule(active, now);
                  if (win) return Math.max(1, Math.floor(win.maxCombinedPositions ?? 4));
                  if (active.length > 0) return Math.max(1, ...active.map(s => Math.floor(s.maxCombinedPositions || 4)));
                  return Math.max(1, Math.floor(config.maxCombinedPositions ?? activeAccount?.default_config?.maxCombinedPositions ?? 4));
                }
                // LIVE: per-position margin sizes for the BUSIEST window — the GREATEST
                // (calls + puts) across ALL active windows — matching the engine's sizing.
                if (active.length > 0) {
                  return Math.max(1, ...active.map(s => (s.numberOfCalls || 0) + (s.numberOfPuts || 0)));
                }
                // No windows: fall back to the engine's published value, else base config.
                return engineMaxPositions ?? Math.max(1, (activeAccount?.default_config?.numberOfCalls ?? 3) + (activeAccount?.default_config?.numberOfPuts ?? 3));
              })()}
            />

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
              liveMarks={tickerData}
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
        mode={dashboardMode}
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
        account={accounts.find(a => a.id === activeAccountId) || null}
        telegramBotUsername={import.meta.env.VITE_TELEGRAM_BOT_USERNAME || ''}
        telegramBusy={telegramBusy}
        onTelegramConnect={() => handleTelegramConnect(activeAccountId)}
        onTelegramDisconnect={() => handleTelegramDisconnect(activeAccountId)}
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
              <AlertTriangle size={18} strokeWidth={2.5} />
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