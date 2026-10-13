CREATE TABLE IF NOT EXISTS public.parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  domain varchar(10) NOT NULL DEFAULT 'fleet'
    CHECK (domain IN ('fleet', 'plant')),
  part_number varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  category varchar(100) NOT NULL DEFAULT 'Geral',
  unit_of_measure varchar(50) NOT NULL DEFAULT 'un',
  location text,
  current_stock numeric NOT NULL DEFAULT 0,
  min_stock numeric NOT NULL DEFAULT 0,
  unit_cost numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.work_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id),
  part_id uuid NOT NULL REFERENCES public.parts(id),
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit_cost numeric NOT NULL DEFAULT 0,
  applied_by uuid REFERENCES public.app_users(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  part_id uuid NOT NULL REFERENCES public.parts(id),
  work_order_id uuid REFERENCES public.work_orders(id),
  user_id uuid REFERENCES public.app_users(id),
  movement_type varchar(10) NOT NULL CHECK (movement_type IN ('in', 'out')),
  quantity numeric NOT NULL,
  unit_cost numeric NOT NULL DEFAULT 0,
  reason text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fuel_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  asset_id uuid NOT NULL REFERENCES public.assets(id),
  driver_or_operator_id uuid,
  logged_at timestamptz NOT NULL DEFAULT now(),
  fuel_type varchar(100) NOT NULL,
  liters numeric NOT NULL,
  price_per_liter_mzn numeric NOT NULL,
  total_cost_mzn numeric GENERATED ALWAYS AS (liters * price_per_liter_mzn) STORED,
  current_meter numeric NOT NULL,
  previous_meter numeric,
  station_name text,
  receipt_doc_ref text,
  receipt_photo_url text
);

CREATE INDEX IF NOT EXISTS parts_tenant_domain_idx
  ON public.parts (tenant_id, domain)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS work_order_parts_tenant_order_idx
  ON public.work_order_parts (tenant_id, work_order_id);
CREATE INDEX IF NOT EXISTS stock_movements_tenant_part_created_idx
  ON public.stock_movements (tenant_id, part_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fuel_logs_tenant_logged_at_idx
  ON public.fuel_logs (tenant_id, logged_at DESC);

ALTER TABLE public.parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fuel_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'parts'
      AND policyname = 'parts_tenant_isolation'
  ) THEN
    CREATE POLICY parts_tenant_isolation ON public.parts
      USING (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      )
      WITH CHECK (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'work_order_parts'
      AND policyname = 'work_order_parts_tenant_isolation'
  ) THEN
    CREATE POLICY work_order_parts_tenant_isolation ON public.work_order_parts
      USING (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      )
      WITH CHECK (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stock_movements'
      AND policyname = 'stock_movements_tenant_isolation'
  ) THEN
    CREATE POLICY stock_movements_tenant_isolation ON public.stock_movements
      USING (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      )
      WITH CHECK (
        tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'fuel_logs'
      AND policyname = 'fuel_logs_tenant_isolation'
  ) THEN
    CREATE POLICY fuel_logs_tenant_isolation ON public.fuel_logs
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
