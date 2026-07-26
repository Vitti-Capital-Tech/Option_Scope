-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 034 — drop number_of_calls / number_of_puts (combined model is now sole)
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 027's combined-cap model (maxCombinedPositions + combinedSplitPct) has
-- been promoted to LIVE and is now the ONLY entry-cap model for every account — the
-- per-type derived cap is ceil(split% × maxCombined). The old explicit per-type caps
-- number_of_calls / number_of_puts are no longer read or written by the engine or UI,
-- so their columns are dropped from both config tables.
--
-- ⚠️ DESTRUCTIVE + ORDER-SENSITIVE: run this ONLY AFTER the engine + frontend that no
-- longer reference these columns are deployed. If pre-034 code (which still INSERTs
-- number_of_calls) runs after the drop, its writes fail. The columns were NOT NULL
-- DEFAULT 3, unused post-promotion, so dropping loses no live information.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.paper_trading_config    DROP COLUMN IF EXISTS number_of_calls;
ALTER TABLE public.paper_trading_config    DROP COLUMN IF EXISTS number_of_puts;
ALTER TABLE public.paper_trading_schedules DROP COLUMN IF EXISTS number_of_calls;
ALTER TABLE public.paper_trading_schedules DROP COLUMN IF EXISTS number_of_puts;
