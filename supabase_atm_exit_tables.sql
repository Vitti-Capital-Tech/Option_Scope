-- 1. Config Table
CREATE TABLE IF NOT EXISTS atm_exit_config (
  id TEXT PRIMARY KEY,
  underlying TEXT,
  expiry TEXT,
  min_strike_diff NUMERIC,
  min_iv_diff NUMERIC,
  max_ratio_deviation NUMERIC,
  min_sell_premium NUMERIC,
  max_net_premium NUMERIC,
  min_long_dist NUMERIC,
  max_sell_qty NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now())
);

-- 2. Active Positions Table
CREATE TABLE IF NOT EXISTS atm_exit_active_positions (
  id TEXT PRIMARY KEY,
  underlying TEXT,
  expiry TEXT,
  type TEXT,
  buy_leg JSONB,
  sell_leg JSONB,
  sell_qty NUMERIC,
  strike_diff NUMERIC,
  entry_time TIMESTAMPTZ,
  entry_buy_price NUMERIC,
  entry_sell_price NUMERIC,
  entry_spot_price NUMERIC,
  margin NUMERIC,
  entry_fee NUMERIC,
  accumulated_sell_pnl NUMERIC,
  buy_strike NUMERIC,
  sell_strike NUMERIC
);

-- 3. Trade History Table
CREATE TABLE IF NOT EXISTS atm_exit_trade_history (
  id BIGSERIAL PRIMARY KEY,
  trade_id TEXT,
  underlying TEXT,
  expiry TEXT,
  type TEXT,
  buy_leg JSONB,
  sell_leg JSONB,
  sell_qty NUMERIC,
  strike_diff NUMERIC,
  entry_time TIMESTAMPTZ,
  entry_buy_price NUMERIC,
  entry_sell_price NUMERIC,
  entry_spot_price NUMERIC,
  margin NUMERIC,
  exit_time TIMESTAMPTZ,
  exit_buy_price NUMERIC,
  exit_sell_price NUMERIC,
  exit_spot_price NUMERIC,
  realized_gross_pnl NUMERIC,
  realized_net_pnl NUMERIC,
  exit_fee NUMERIC,
  total_fees NUMERIC,
  exit_reason TEXT
);

-- 4. Analytics Tables
CREATE TABLE IF NOT EXISTS atm_exit_qty_0_2_5 (
  strike_diff NUMERIC,
  underlying TEXT,
  type TEXT,
  trade_count INTEGER,
  avg_margin NUMERIC,
  median_margin NUMERIC,
  avg_pnl NUMERIC,
  avg_net_premium NUMERIC,
  avg_fees NUMERIC,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (strike_diff, underlying, type)
);

CREATE TABLE IF NOT EXISTS atm_exit_qty_2_5_5 (
  strike_diff NUMERIC,
  underlying TEXT,
  type TEXT,
  trade_count INTEGER,
  avg_margin NUMERIC,
  median_margin NUMERIC,
  avg_pnl NUMERIC,
  avg_net_premium NUMERIC,
  avg_fees NUMERIC,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (strike_diff, underlying, type)
);

CREATE TABLE IF NOT EXISTS atm_exit_qty_5_7_5 (
  strike_diff NUMERIC,
  underlying TEXT,
  type TEXT,
  trade_count INTEGER,
  avg_margin NUMERIC,
  median_margin NUMERIC,
  avg_pnl NUMERIC,
  avg_net_premium NUMERIC,
  avg_fees NUMERIC,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (strike_diff, underlying, type)
);

CREATE TABLE IF NOT EXISTS atm_exit_qty_7_5_10 (
  strike_diff NUMERIC,
  underlying TEXT,
  type TEXT,
  trade_count INTEGER,
  avg_margin NUMERIC,
  median_margin NUMERIC,
  avg_pnl NUMERIC,
  avg_net_premium NUMERIC,
  avg_fees NUMERIC,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (strike_diff, underlying, type)
);
