import os

code = """import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  loadProducts, getExpiries, getStrikes, getSpotPrice,
  fmtExpiry, createTickerStream, apiGet, getTickers
} from './api';
import { normalizeIv, toFiniteNumber, matchesOptionType, formatTime, formatDateTime } from './scannerUtils';
import { useTabListener } from './useTabSync';
import { supabase } from './supabase';

const UNDERLYINGS = ['BTC', 'ETH'];

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

const calcMargin = (buyPrice, buyLot, spot, sellQty, sellLot = 1) => {
  const longMargin = (buyPrice || 0) * (buyLot || 1);
  const shortValue = (spot || 0) * (sellQty || 0) * sellLot;
  let leverage = 200;
  if (shortValue <= 200000) leverage = 200;
  else if (shortValue <= 450000) leverage = 100;
  else if (shortValue <= 950000) leverage = 50;
  else leverage = 25;
  return longMargin + (shortValue / leverage);
};

const getQtyTable = (sellQty) => {
  if (sellQty <= 2.5) return 'atm_exit_qty_0_2_5';
  if (sellQty <= 5) return 'atm_exit_qty_2_5_5';
  if (sellQty <= 7.5) return 'atm_exit_qty_5_7_5';
  return 'atm_exit_qty_7_5_10';
};

const upsertAnalytics = async (trade) => {
  try {
    const tableName = getQtyTable(trade.sellQty);
    const netPremium = (trade.entryBuyPrice || 0) - (trade.sellQty || 0) * (trade.entrySellPrice || 0);
    const strikeDiff = Math.round((trade.strikeDiff || 0) / 100) * 100;

    const { data: existing } = await supabase
      .from(tableName)
      .select('*')
      .eq('strike_diff', strikeDiff)
      .eq('underlying', trade.underlying)
      .eq('type', trade.type)
      .maybeSingle();

    if (existing) {
      const n = existing.trade_count + 1;
      const avg = (v, nv) => ((v * (n - 1)) + nv) / n;
      await supabase.from(tableName).update({
        trade_count: n,
        avg_margin: avg(existing.avg_margin || 0, trade.margin || 0),
        avg_pnl: avg(existing.avg_pnl || 0, trade.realizedNetPnl || 0),
        avg_net_premium: avg(existing.avg_net_premium || 0, netPremium),
        avg_fees: avg(existing.avg_fees || 0, trade.totalFees || 0),
        updated_at: new Date().toISOString(),
      })
        .eq('strike_diff', strikeDiff)
        .eq('underlying', trade.underlying)
        .eq('type', trade.type);
    } else {
      await supabase.from(tableName).insert([{
        strike_diff: strikeDiff,
        underlying: trade.underlying,
        type: trade.type,
        trade_count: 1,
        avg_margin: trade.margin || 0,
        median_margin: trade.margin || 0,
        avg_pnl: trade.realizedNetPnl || 0,
        avg_net_premium: netPremium,
        avg_fees: trade.totalFees || 0,
        updated_at: new Date().toISOString(),
      }]);
    }
  } catch (e) { console.error('Analytics upsert error:', e); }
};
"""

with open('src/ATMExitTrading.jsx', 'w', encoding='utf-8') as f:
    f.write(code)

print("Part 1 written successfully.")
