-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 071 — Paper entry selection by max net credit
-- ─────────────────────────────────────────────────────────────────────────────
-- paper_trading_config.entry_by_max_credit (default false). Control Panel toggle,
-- account-global (not per window). PAPER accounts only; live ignores it.
--   • OFF (default) — unchanged: a candidate must clear Min ATM P&L / Min ATM ROI, the
--     best-ROI spread is kept per long strike, and candidates are tried nearest-ATM first.
--   • ON  — the ATM P&L / ROI floors are skipped. Per long strike the spread with the
--     largest net credit is kept (short qty × short bid − long ask − hedge cost, per 1
--     long), and candidates are tried highest-net-credit first. Every scan filter
--     (Max Net Debit, hedge rules, etc.) still applies.
-- Group sync copies the column like every other config column.
--
-- Additive and safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS entry_by_max_credit BOOLEAN NOT NULL DEFAULT false;
