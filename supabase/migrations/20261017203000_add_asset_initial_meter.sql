ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS initial_meter numeric
    CHECK (initial_meter IS NULL OR initial_meter >= 0);
