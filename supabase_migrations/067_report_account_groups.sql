-- Migration 067: Daily Report account groups, editable per user.
--
-- The Daily Report groups accounts whose names differ only by a trailing number (Shubham /
-- Shubham2). This table stores a user's own version of those groups once they edit them
-- (add / remove accounts, rename, new or deleted groups). No row = the automatic name groups.
--
-- report_account_groups.groups: JSON array of { id, label, ids } — ids = account ids. Purely a
-- reporting view: it does not touch account_groups (migration 050) or any trading setting.
--
-- Additive; run before deploying the frontend that reads it (without it the report keeps the
-- automatic groups and saving shows an error).

CREATE TABLE IF NOT EXISTS public.report_account_groups (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    groups JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(groups) = 'array'),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.report_account_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own report groups" ON public.report_account_groups;
CREATE POLICY "Users manage own report groups"
    ON public.report_account_groups FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
