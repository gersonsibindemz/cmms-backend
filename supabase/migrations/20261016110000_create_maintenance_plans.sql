ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS operational_scope varchar(10);

UPDATE public.assets
SET operational_scope = domain
WHERE operational_scope IS NULL;

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS operational_scope varchar(10),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS checklist_items jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.work_orders
SET operational_scope = domain
WHERE operational_scope IS NULL;

UPDATE public.work_orders
SET closed_at = completed_at
WHERE closed_at IS NULL
  AND completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.maintenance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  asset_id uuid NOT NULL REFERENCES public.assets(id),
  domain varchar(10) NOT NULL CHECK (domain IN ('fleet', 'plant')),
  title varchar(255) NOT NULL,
  trigger_type varchar(10) NOT NULL CHECK (trigger_type IN ('time', 'meter', 'both')),
  interval_days integer CHECK (interval_days IS NULL OR interval_days > 0),
  interval_meter numeric CHECK (interval_meter IS NULL OR interval_meter > 0),
  checklist_items jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(checklist_items) = 'array'),
  assigned_technician_id uuid,
  is_active boolean NOT NULL DEFAULT TRUE,
  next_due_at date,
  next_due_meter numeric,
  last_generated_at timestamptz,
  last_work_order_id uuid REFERENCES public.work_orders(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  deleted_at timestamptz,
  CHECK (
    trigger_type NOT IN ('time', 'both')
    OR interval_days IS NOT NULL
  ),
  CHECK (
    trigger_type NOT IN ('meter', 'both')
    OR interval_meter IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS maintenance_plans_tenant_domain_idx
  ON public.maintenance_plans (tenant_id, domain, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS maintenance_plans_due_idx
  ON public.maintenance_plans (next_due_at, next_due_meter)
  WHERE deleted_at IS NULL AND is_active IS TRUE;

ALTER TABLE public.maintenance_plans ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'maintenance_plans'
      AND policyname = 'maintenance_plans_tenant_isolation'
  ) THEN
    CREATE POLICY maintenance_plans_tenant_isolation
      ON public.maintenance_plans
      USING (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      )
      WITH CHECK (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      );
  END IF;
END
$$;
