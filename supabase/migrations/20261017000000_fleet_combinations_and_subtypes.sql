ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS asset_type varchar,
  ADD COLUMN IF NOT EXISTS asset_subtype varchar,
  ADD COLUMN IF NOT EXISTS energy_type varchar,
  ADD COLUMN IF NOT EXISTS ownership_type varchar,
  ADD COLUMN IF NOT EXISTS axle_config integer;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS suspension_reason text;

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS suspension_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS assets_id_tenant_uidx
  ON public.assets (id, tenant_id);

CREATE TABLE IF NOT EXISTS public.fleet_combinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  combination_code varchar NOT NULL,
  truck_id uuid NOT NULL,
  status varchar NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'terminated')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, combination_code),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (truck_id, tenant_id)
    REFERENCES public.assets (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS public.fleet_combination_trailers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  combination_id uuid NOT NULL,
  trailer_id uuid NOT NULL,
  role_in_combination varchar NOT NULL
    CHECK (role_in_combination IN ('leader', 'follower')),
  position_order integer NOT NULL CHECK (position_order > 0),
  FOREIGN KEY (combination_id, tenant_id)
    REFERENCES public.fleet_combinations (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (trailer_id, tenant_id)
    REFERENCES public.assets (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS fleet_combinations_tenant_status_idx
  ON public.fleet_combinations (tenant_id, status);

CREATE INDEX IF NOT EXISTS fleet_combination_trailers_combination_order_idx
  ON public.fleet_combination_trailers (combination_id, position_order);

ALTER TABLE public.fleet_combinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_combination_trailers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'fleet_combinations'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation
      ON public.fleet_combinations
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
      AND tablename = 'fleet_combination_trailers'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation
      ON public.fleet_combination_trailers
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
