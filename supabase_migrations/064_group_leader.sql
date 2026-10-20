-- Migration 064: Group leader — which account a group's other members follow.
--
-- Until now a group had no fixed source: whichever member saved last had its settings copied
-- to the rest (sync_account_group(source)). A group now names its LEADER: the members follow
-- the leader's filters / schedule windows, and only a save on the leader is copied to the group
-- (the frontend calls sync_account_group with the leader as source; the RPC is unchanged).
--
-- NULL (or a leader that has since left the group) = the group's first-created member, which is
-- what the frontend falls back to. Existing groups are backfilled to that member here.
-- ON DELETE SET NULL: deleting the leader account falls back the same way.
--
-- Additive; run before deploying the frontend that reads it.

ALTER TABLE public.account_groups
  ADD COLUMN IF NOT EXISTS leader_account_id UUID
    REFERENCES public.paper_trading_accounts(id) ON DELETE SET NULL;

UPDATE public.account_groups g
   SET leader_account_id = (
         SELECT a.id FROM public.paper_trading_accounts a
          WHERE a.group_id = g.id
          ORDER BY a.created_at, a.id
          LIMIT 1)
 WHERE g.leader_account_id IS NULL;
