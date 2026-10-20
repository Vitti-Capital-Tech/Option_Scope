-- Migration 065: OI filter mode — Delta's lock only (default) or a manual OI cap.
--
-- The OI filter (062) skipped a strike when Delta had locked it (oi_reduce_only_mode) OR when
-- its OI (USD) was at/over a cap, defaulting to BTC $15M. Delta's real cap is higher: strikes at
-- $17–21M stay open while only a ~$30M strike is locked, so the $15M default skipped strikes
-- Delta still allows. Delta's own lock flag is the reliable signal, so it becomes the default.
--
-- paper_trading_config.oi_filter_mode:
--   'lock' (default) — skip only the strikes Delta has locked (oi_reduce_only_mode).
--   'cap'            — also skip strikes whose OI (USD) is at/over oi_max_cap_m
--                      (NULL = the underlying's default: BTC 15, ETH 10, XAUT 5).
-- Rows that already set a manual cap keep that behaviour ('cap'); the rest become 'lock'.
--
-- Group sync (sync_account_group) copies every config column dynamically — no RPC change.

ALTER TABLE public.paper_trading_config
  ADD COLUMN IF NOT EXISTS oi_filter_mode TEXT NOT NULL DEFAULT 'lock'
    CHECK (oi_filter_mode IN ('lock', 'cap'));

UPDATE public.paper_trading_config
   SET oi_filter_mode = 'cap'
 WHERE oi_max_cap_m IS NOT NULL AND oi_filter_mode = 'lock';
