-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 024 — cut engine_heartbeat disk IO (UNLOGGED + HOT-friendly fillfactor)
-- ─────────────────────────────────────────────────────────────────────────────
-- `engine_heartbeat` is a tiny table (one row per running engine) that every engine
-- re-upserts every ~30s as a liveness signal. Because `last_heartbeat` changes on
-- every write, each upsert makes a dead tuple, and on a table this small autovacuum
-- fires roughly every ~1.5 min, all day — by far the largest autovacuum/WAL churn in
-- the database (observed autovacuum_count in the tens of thousands vs <400 elsewhere).
-- That constant WAL + vacuum IO is the dominant consumer of the Supabase disk IO budget.
--
-- The data is PURELY EPHEMERAL: on a crash the engine simply rewrites its row within
-- ~30s of restart, and the UI marks an engine offline after 120s of silence anyway. So
-- it does not need crash-durable, WAL-logged storage.
--
--   • SET UNLOGGED  → writes and autovacuum on this table no longer generate WAL, and
--     it is skipped by checkpoints/crash recovery. This removes essentially all of its
--     disk IO. (Safe: the UI READS this table by polling `.select()`, not via Realtime,
--     so it is not in the `supabase_realtime` publication — an unlogged table cannot be
--     logically replicated, hence the defensive drop below.)
--   • fillfactor 70 → leaves free space per page so repeated updates are HOT (in-page),
--     avoiding index churn and keeping the tiny table from bloating between vacuums.
--
-- Additive / reversible: `ALTER TABLE ... SET LOGGED` restores the previous behaviour.
-- ─────────────────────────────────────────────────────────────────────────────

-- Unlogged tables can't belong to a logical-replication publication — drop it if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'engine_heartbeat'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.engine_heartbeat';
  END IF;
END $$;

ALTER TABLE public.engine_heartbeat SET UNLOGGED;
ALTER TABLE public.engine_heartbeat SET (fillfactor = 70);
