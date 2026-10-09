CREATE SEQUENCE IF NOT EXISTS public.work_order_number_seq;

CREATE OR REPLACE FUNCTION public.generate_work_order_number()
RETURNS varchar
LANGUAGE sql
VOLATILE
AS $$
  SELECT (
    'OS-' || EXTRACT(YEAR FROM CURRENT_DATE)::integer || '-' ||
    LPAD(number::text, GREATEST(4, length(number::text)), '0')
  )::varchar
  FROM (SELECT nextval('public.work_order_number_seq') AS number) AS generated
$$;

CREATE TABLE IF NOT EXISTS public.work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  os_number varchar(255) NOT NULL DEFAULT public.generate_work_order_number(),
  asset_id uuid NOT NULL REFERENCES public.assets(id),
  title varchar(255) NOT NULL,
  description text,
  order_type varchar(20) NOT NULL CHECK (order_type IN ('corrective', 'preventive', 'inspection')),
  priority varchar(20) NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status varchar(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'waiting_parts', 'completed', 'cancelled')),
  assigned_to uuid REFERENCES public.app_users(id),
  opened_by uuid REFERENCES public.app_users(id),
  meter_at_service numeric,
  started_at timestamptz,
  completed_at timestamptz,
  downtime_hours numeric NOT NULL DEFAULT 0,
  resolution_notes text,
  parts_cost_mzn numeric NOT NULL DEFAULT 0,
  labor_cost_mzn numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS os_number varchar(255),
  ADD COLUMN IF NOT EXISTS opened_by uuid,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_notes text,
  ADD COLUMN IF NOT EXISTS downtime_hours numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parts_cost_mzn numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS labor_cost_mzn numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_orders'
      AND column_name = 'reported_by'
  ) THEN
    EXECUTE 'UPDATE public.work_orders SET opened_by = reported_by WHERE opened_by IS NULL';
    EXECUTE 'ALTER TABLE public.work_orders ALTER COLUMN reported_by DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_orders'
      AND column_name = 'closed_at'
  ) THEN
    EXECUTE 'UPDATE public.work_orders SET completed_at = closed_at WHERE completed_at IS NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_orders'
      AND column_name = 'wo_number'
  ) THEN
    EXECUTE 'ALTER TABLE public.work_orders ALTER COLUMN wo_number DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'work_orders'
      AND column_name = 'opened_at'
  ) THEN
    EXECUTE 'ALTER TABLE public.work_orders ALTER COLUMN opened_at DROP NOT NULL';
  END IF;
END
$$;

UPDATE public.work_orders
SET os_number = public.generate_work_order_number()
WHERE os_number IS NULL;

ALTER TABLE public.work_orders
  ALTER COLUMN os_number SET DEFAULT public.generate_work_order_number(),
  ALTER COLUMN os_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS work_orders_os_number_uidx
  ON public.work_orders (os_number);

CREATE INDEX IF NOT EXISTS work_orders_tenant_created_idx
  ON public.work_orders (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'work_orders'
      AND policyname = 'work_orders_tenant_isolation'
  ) THEN
    CREATE POLICY work_orders_tenant_isolation
      ON public.work_orders
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
