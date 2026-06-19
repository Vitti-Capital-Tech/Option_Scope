import React, { useEffect, useState, useCallback, useRef } from 'react';
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
import ActivePositionsTable from './components/PaperTrading/ActivePositionsTable';
import TradeHistoryTable from './components/PaperTrading/TradeHistoryTable';
import CreateAccountModal from './components/PaperTrading/CreateAccountModal';
import EditAccountModal from './components/PaperTrading/EditAccountModal';
import DeleteAccountModal from './components/PaperTrading/DeleteAccountModal';

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
  spotDiff: 0.5,
  exitType: 'ATM',
  exitPoints: 0
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
      spotDiff: 0.5,
      exitType: 'ATM',
      exitPoints: 0
    }
  });

  const watchCreateAtmRatioScaling = watchCreate('atmRatioScaling');
  const watchCreateExitType = watchCreate('exitType');

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
    atmRatioScaling: true,
    atmRatioPctCall: 50,
    atmRatioPctPut: 25,
    daysToExpiry: 0,
    numberOfCalls: 3,
    numberOfPuts: 3,
    spotDiff: 0.5,
    exitType: 'ATM',
    exitPoints: 0
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
  const lastDaysToExpiryRef = useRef(null);

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
      spotDiff: data.spotDiff,
      exitType: data.exitType,
      exitPoints: data.exitPoints
    });

    setIsCreatingAccount(true);
    try {
      const { data: accList, error: accErr } = await supabase
        .from('paper_trading_accounts')
        .insert([{
          name: trimmedName,
          is_active: true,
          user_id: ownerUserId,
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
          spot_diff: data.spotDiff ?? 0.5,
          exit_type: data.exitType ?? 'ATM',
          exit_points: data.exitPoints ?? 0
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
      spotDiff: config.spotDiff ?? 0.5,
      exitType: config.exitType ?? 'ATM',
      exitPoints: config.exitPoints ?? 0
    });
    setIsCreateModalOpen(true);
  };

  const triggerEditAccount = () => {
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    if (!activeAccount) return;
    resetEdit({
      name: activeAccount.name
    });
    setIsEditModalOpen(true);
  };

  const handleEditSubmit = async (data) => {
    const trimmedName = data.name.trim();

    setIsSavingAccount(true);
    try {
      setAccounts(prev => prev.map(a => a.id === activeAccountId ? { ...a, name: trimmedName } : a));
      const { error } = await supabase
        .from('paper_trading_accounts')
        .update({ name: trimmedName })
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
        number_of_calls: newCfg.numberOfCalls ?? 3,
        number_of_puts: newCfg.numberOfPuts ?? 3,
        spot_diff: newCfg.spotDiff ?? 0.5,
        exit_type: newCfg.exitType ?? 'ATM',
        exit_points: newCfg.exitPoints ?? 0,
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
    'daysToExpiry',
    'numberOfCalls',
    'numberOfPuts',
    'spotDiff',
    'exitType',
    'exitPoints'
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

  const activeAccount = React.useMemo(() => {
    return accounts.find(a => a.id === activeAccountId) || null;
  }, [accounts, activeAccountId]);

  const DEFAULT_FILTERS = React.useMemo(() => {
    const baseFilters = {
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
      spotDiff: 0.5,
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
    return FILTER_KEYS.some(k => draftConfig[k] !== config[k]);
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
          spot_diff: 0.5,
          exit_type: 'ATM',
          exit_points: 0,
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
          spotDiff: data.spot_diff ?? 0.5,
          exitType: data.exit_type ?? 'ATM',
          exitPoints: data.exit_points ?? 0
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
      if (!error && data) {
        setSchedules(data.map(s => ({
          id: s.id,
          label: s.label || 'Window',
          startTime: utcToIst(s.start_time),
          endTime: utcToIst(s.end_time),
          numberOfCalls: s.number_of_calls ?? 3,
          numberOfPuts: s.number_of_puts ?? 3,
          minLongDist: s.min_long_dist ?? 500,
          minStrikeDiff: s.min_strike_diff ?? 800,
          isActive: s.is_active ?? true,
          sort_order: s.sort_order ?? 0,
        })));
      }
    } catch (e) { console.error('Schedule fetch error', e); }
  }, [activeAccountId]);

  const saveSupabaseSchedules = useCallback(async () => {
    if (!activeAccountId) return;
    setIsSavingSchedules(true);
    try {
      await supabase.from('paper_trading_schedules').delete().eq('account_id', activeAccountId);
      if (schedules.length > 0) {
        const rows = schedules.map((s, i) => ({
          account_id: activeAccountId,
          label: s.label || 'Window',
          start_time: istToUtc(s.startTime),
          end_time: istToUtc(s.endTime),
          number_of_calls: s.numberOfCalls ?? 3,
          number_of_puts: s.numberOfPuts ?? 3,
          min_long_dist: s.minLongDist ?? 500,
          min_strike_diff: s.minStrikeDiff ?? 800,
          is_active: s.isActive ?? true,
          sort_order: i,
          updated_at: new Date().toISOString(),
        }));
        await supabase.from('paper_trading_schedules').insert(rows);
      }
      await fetchSupabaseSchedules();
    } catch (e) { console.error('Schedule save error', e); }
    finally { setIsSavingSchedules(false); }
  }, [activeAccountId, schedules, fetchSupabaseSchedules]);

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
        .select('id, trade_id, underlying, expiry, type, buy_leg, sell_leg, sell_qty, strike_diff, entry_time, exit_time, entry_buy_price, entry_sell_price, exit_buy_price, exit_sell_price, entry_spot_price, exit_spot_price, margin, realized_gross_pnl, realized_net_pnl, exit_fee, total_fees, exit_reason, is_partial, lot_size, account_id')
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
    fetchSupabaseSchedules();

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
        }
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
        .select('id, last_heartbeat, status, ws_status, underlying, expiry, active_positions, spot_price')
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
            ? calculateFee(latestBuy, spotPrice, pos.buyLeg.lotSize, pos.buyLeg.originalLotSize || 1) + calculateFee(latestSell, spotPrice, pos.sellQty, pos.sellLeg.lotSize)
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
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
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
            />


            <KpiDashboard
              todayPnl={todayPnl}
              todayRealizedPnl={todayRealizedPnl}
              totalUnrealizedPnl={totalUnrealizedPnl}
              totalPnl={totalPnl}
              totalRealizedPnl={totalRealizedPnl}
              winRate={winRate}
              wins={wins}
              tradeHistoryLength={tradeHistory.length}
              activePositionsCount={positions.filter(p => p.underlying === underlying).length}
              activeCallsCount={positions.filter(p => p.type === 'call' && p.underlying === underlying).length}
              activePutsCount={positions.filter(p => p.type === 'put' && p.underlying === underlying).length}
              totalMargin={totalMargin}
            />

            <div className="pt-tables-container">
              <ActivePositionsTable
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
                exitType={config.exitType}
                exitPoints={config.exitPoints}
              />

              <TradeHistoryTable
                filteredTradeHistory={filteredTradeHistory}
                historyFilterDate={historyFilterDate}
                setHistoryFilterDate={setHistoryFilterDate}
                adjustFilterDay={adjustFilterDay}
                resetToToday={resetToToday}
                filteredRealizedPnl={filteredRealizedPnl}
                filteredWins={filteredWins}
                exportCSV={exportCSV}
                includeFees={includeFees}
              />
            </div>
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
      />
    </div>
  );
}