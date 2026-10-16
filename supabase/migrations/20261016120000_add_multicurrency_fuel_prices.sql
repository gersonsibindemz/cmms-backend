ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS country varchar(100) NOT NULL DEFAULT 'Moçambique',
  ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'MZN';

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_currency_format_check
    CHECK (currency ~ '^[A-Z]{3}$');

CREATE TABLE IF NOT EXISTS public.fuel_price_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country varchar(100) NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  fuel_type varchar(100) NOT NULL,
  price_per_liter numeric(14, 4) NOT NULL CHECK (price_per_liter >= 0),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT fuel_price_settings_scope_unique
    UNIQUE NULLS NOT DISTINCT (country, currency, tenant_id, fuel_type)
);

CREATE INDEX IF NOT EXISTS fuel_price_settings_country_currency_idx
  ON public.fuel_price_settings (country, currency, fuel_type);

CREATE INDEX IF NOT EXISTS fuel_price_settings_tenant_idx
  ON public.fuel_price_settings (tenant_id, fuel_type)
  WHERE tenant_id IS NOT NULL;

ALTER TABLE public.fuel_price_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'fuel_price_settings'
      AND policyname = 'fuel_price_settings_read_scope'
  ) THEN
    CREATE POLICY fuel_price_settings_read_scope
      ON public.fuel_price_settings
      FOR SELECT
      USING (
        tenant_id IS NULL
        OR tenant_id::text = nullif(current_setting('app.current_tenant', true), '')
        OR current_setting('app.current_user_role', true) = 'super_admin'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'fuel_price_settings'
      AND policyname = 'fuel_price_settings_super_admin_write'
  ) THEN
    CREATE POLICY fuel_price_settings_super_admin_write
      ON public.fuel_price_settings
      FOR ALL
      USING (current_setting('app.current_user_role', true) = 'super_admin')
      WITH CHECK (current_setting('app.current_user_role', true) = 'super_admin');
  END IF;
END
$$;
