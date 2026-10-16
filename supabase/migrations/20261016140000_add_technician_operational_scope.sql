ALTER TABLE public.technicians
  ADD COLUMN IF NOT EXISTS operational_scope varchar(10);

UPDATE public.technicians
SET operational_scope = domain
WHERE operational_scope IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.technicians'::regclass
      AND conname = 'technicians_operational_scope_check'
  ) THEN
    ALTER TABLE public.technicians
      ADD CONSTRAINT technicians_operational_scope_check
      CHECK (
        operational_scope IS NULL
        OR operational_scope IN ('fleet', 'plant')
      );
  END IF;
END
$$;
