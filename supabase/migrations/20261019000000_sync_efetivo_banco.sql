-- Migração para sincronizar o esquema com o estado efetivo do banco de produção
-- Data: 2026-10-19
-- Motivo: O banco de produção evoluiu além das migrações versionadas.

-- ============================================================
-- 1. TIPOS ENUM (usados no banco efetivo, ausentes nas migrações)
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.user_role AS ENUM (
    'super_admin', 'tenant_admin', 'supervisor', 'technician', 'driver_operator'
  );
EXCEPTION WHEN duplicate_object THEN NULL END $$;

DO $$ BEGIN
  CREATE TYPE public.wo_type AS ENUM ('corrective', 'preventive', 'inspection');
EXCEPTION WHEN duplicate_object THEN NULL END $$;

DO $$ BEGIN
  CREATE TYPE public.wo_priority AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL END $$;

DO $$ BEGIN
  CREATE TYPE public.asset_status AS ENUM (
    'operational', 'under_maintenance', 'breakdown', 'decommissioned'
  );
EXCEPTION WHEN duplicate_object THEN NULL END $$;

DO $$ BEGIN
  CREATE TYPE public.meter_type AS ENUM ('odometer_km', 'hourmeter_hours');
EXCEPTION WHEN duplicate_object THEN NULL END $$;

-- ============================================================
-- 2. TABELA audit_logs (existente no banco, ausente nas migrações)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid REFERENCES public.app_users(id),
  action varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id uuid NOT NULL,
  old_data jsonb,
  new_data jsonb,
  client_ip varchar(45),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON public.audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_tenant_isolation'
  ) THEN
    CREATE POLICY audit_logs_tenant_isolation
      ON public.audit_logs
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

-- ============================================================
-- 3. COLUNAS EXTRAS NA TABELA tenants (presentes no banco efetivo)
-- ============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS status varchar DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS business_types varchar[] DEFAULT ARRAY['fleet'::varchar, 'plant'::varchar],
  ADD COLUMN IF NOT EXISTS max_assets integer DEFAULT 50,
  ADD COLUMN IF NOT EXISTS max_users integer DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_storage_mb integer DEFAULT 1024,
  ADD COLUMN IF NOT EXISTS features_enabled jsonb DEFAULT '{"fuel": true, "qr_field": true, "compliance": true}'::jsonb;

-- ============================================================
-- 4. COLUNAS EXTRAS / AJUSTES NA TABELA app_users
-- ============================================================

ALTER TABLE public.app_users
  ALTER COLUMN role TYPE public.user_role USING role::public.user_role,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS default_operational_scope varchar DEFAULT 'fleet',
  ADD COLUMN IF NOT EXISTS phone varchar;

-- ============================================================
-- 5. COLUNAS EXTRAS NA TABELA assets (presentes no banco efetivo)
-- ============================================================

ALTER TABLE public.assets
  ALTER COLUMN category TYPE public.asset_status USING category::public.asset_status,
  ALTER COLUMN meter_kind TYPE public.meter_type USING meter_kind::public.meter_type,
  ALTER COLUMN status TYPE public.asset_status USING status::public.asset_status,
  ADD COLUMN IF NOT EXISTS asset_category varchar,
  ADD COLUMN IF NOT EXISTS technical_specs jsonb DEFAULT '{}'::jsonb;

-- ============================================================
-- 6. COLUNAS EXTRAS NA TABELA work_orders
-- ============================================================

ALTER TABLE public.work_orders
  ALTER COLUMN order_type TYPE public.wo_type USING order_type::public.wo_type,
  ALTER COLUMN priority TYPE public.wo_priority USING priority::public.wo_priority,
  ADD COLUMN IF NOT EXISTS wo_number bigint,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS parts_cost numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS labor_cost numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost numeric DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_work_orders_wo_number ON public.work_orders (wo_number);

-- ============================================================
-- 7. COLUNAS EXTRAS / AJUSTES NA TABELA maintenance_plans
-- ============================================================

ALTER TABLE public.maintenance_plans
  ADD COLUMN IF NOT EXISTS code_tag varchar,
  ADD COLUMN IF NOT EXISTS next_due_date date,
  ADD COLUMN IF NOT EXISTS last_executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_executed_meter numeric;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='maintenance_plans' AND column_name='plan_code'
  ) THEN
    EXECUTE 'UPDATE public.maintenance_plans SET code_tag = plan_code WHERE code_tag IS NULL';
  END IF;
END
$$;

-- ============================================================
-- 8. COLUNAS EXTRAS / AJUSTES NA TABELA maintenance_notifications
-- ============================================================

ALTER TABLE public.maintenance_notifications
  ADD COLUMN IF NOT EXISTS registration_plate varchar,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- ============================================================
-- 9. COLUNAS EXTRAS NA TABELA fuel_price_settings
-- ============================================================

ALTER TABLE public.fuel_price_settings
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.app_users(id);

-- ============================================================
-- 10. TRIGGERS (presentes no banco efetivo, ausentes nas migrações)
-- ============================================================

-- trg_work_order_parts_consumption (mantém parts.current_stock sincronizado)
CREATE OR REPLACE FUNCTION public.trg_apply_work_order_part()
RETURNS trigger AS $$
BEGIN
  UPDATE public.parts
     SET current_stock = current_stock - NEW.quantity,
         updated_at = NOW()
   WHERE id = NEW.part_id
     AND tenant_id = NEW.tenant_id
     AND current_stock >= NEW.quantity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock insuficiente para a peça %', NEW.part_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_work_order_parts_consumption ON public.work_order_parts;
CREATE TRIGGER trg_work_order_parts_consumption
  AFTER INSERT ON public.work_order_parts
  FOR EACH ROW EXECUTE FUNCTION public.trg_apply_work_order_part();

-- trigger_update_asset_meter (atualiza medidor do ativo após abastecimento)
CREATE OR REPLACE FUNCTION public.trg_update_asset_meter_after_fuel()
RETURNS trigger AS $$
BEGIN
  UPDATE public.assets
     SET current_meter = NEW.current_meter,
         updated_at = NOW()
   WHERE id = NEW.asset_id
     AND tenant_id = NEW.tenant_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_asset_meter ON public.fuel_logs;
CREATE TRIGGER trigger_update_asset_meter
  AFTER INSERT ON public.fuel_logs
  FOR EACH ROW EXECUTE FUNCTION public.trg_update_asset_meter_after_fuel();

-- trg_audit_assets (audit_logs para assets)
CREATE OR REPLACE FUNCTION public.fn_audit_asset_changes()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.audit_logs (
    tenant_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at
  )
  VALUES (
    NEW.tenant_id, NEW.uploaded_by OR NULL, 'asset_change', 'asset', NEW.id,
    to_jsonb(OLD), to_jsonb(NEW), NOW()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_assets ON public.assets;
CREATE TRIGGER trg_audit_assets
  AFTER INSERT OR UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.fn_audit_asset_changes();

-- trg_set_notification_number (gera número sequencial)
CREATE OR REPLACE FUNCTION public.fn_generate_notification_number()
RETURNS trigger AS $$
BEGIN
  NEW.notification_number := 'MN-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
    lpad(nextval('public.maintenance_notification_seq')::text, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_notification_number ON public.maintenance_notifications;
CREATE TRIGGER trg_set_notification_number
  BEFORE INSERT ON public.maintenance_notifications

-- trg_sync_app_user_to_technician
CREATE OR REPLACE FUNCTION public.fn_sync_app_user_to_technician()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.technicians (
      tenant_id, name, email, phone, user_id, domain, operational_scope, status
    )
    VALUES (
      NEW.tenant_id, NEW.full_name, NEW.email, NEW.phone, NEW.id,
      COALESCE(NEW.operational_scope, 'fleet'), COALESCE(NEW.operational_scope, 'fleet'), 'active'
    )
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.technicians
       SET name = NEW.full_name,
           email = NEW.email,
           phone = NEW.phone,
           operational_scope = COALESCE(NEW.operational_scope, 'fleet')
     WHERE user_id = NEW.id AND tenant_id = NEW.tenant_id;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_app_user_to_technician ON public.app_users;
CREATE TRIGGER trg_sync_app_user_to_technician
  AFTER INSERT OR UPDATE ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_app_user_to_technician();

-- trg_sync_asset_status (sincroniza status do ativo com work_orders)
CREATE OR REPLACE FUNCTION public.fn_sync_asset_status_on_wo_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'under_maintenance' OR NEW.status = 'completed' THEN
    UPDATE public.assets
       SET status = CASE WHEN NEW.status = 'under_maintenance' THEN 'under_maintenance' ELSE 'operational' END,
           updated_at = NOW()
     WHERE id = NEW.asset_id AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_asset_status ON public.work_orders;
CREATE TRIGGER trg_sync_asset_status
  AFTER INSERT OR UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_asset_status_on_wo_change();
  FOR EACH ROW EXECUTE FUNCTION public.fn_generate_notification_number();