import { Pool } from 'pg';

const DATABASE_URL = 'postgresql://postgres.tnrntjfvseyxjxubxitn:moxambique00@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function tryQuery(client, sql, label) {
  try {
    await client.query(sql);
    console.log('  OK:', label);
    return true;
  } catch (e) {
    if (e.code === '42P07' || e.code === '42710' || e.message.includes('already exists')) {
      console.log('  SKIP (já existe):', label);
      return true;
    }
    console.log('  FALHA:', label, '->', e.message);
    return false;
  }
}

(async () => {
  const client = await pool.connect();
  try {
    console.log('=== APLICANDO MIGRAÇÃO DE SINCRONIZAÇÃO ===\n');

    // 1. Tipos ENUM
    console.log('-- 1. Tipos ENUM --');
    await tryQuery(client, `CREATE TYPE public.user_role AS ENUM ('super_admin','tenant_admin','supervisor','technician','driver_operator')`, 'CREATE TYPE user_role');
    await tryQuery(client, `CREATE TYPE public.wo_type AS ENUM ('corrective','preventive','inspection')`, 'CREATE TYPE wo_type');
    await tryQuery(client, `CREATE TYPE public.wo_priority AS ENUM ('low','medium','high','urgent')`, 'CREATE TYPE wo_priority');
    await tryQuery(client, `CREATE TYPE public.asset_status AS ENUM ('operational','under_maintenance','breakdown','decommissioned')`, 'CREATE TYPE asset_status');
    await tryQuery(client, `CREATE TYPE public.meter_type AS ENUM ('odometer_km','hourmeter_hours')`, 'CREATE TYPE meter_type');

    // 2. Tabela audit_logs
    console.log('\n-- 2. Tabela audit_logs --');
    await tryQuery(client, `CREATE TABLE IF NOT EXISTS public.audit_logs (
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
    );`, 'CREATE TABLE audit_logs');
    await tryQuery(client, `CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON public.audit_logs (tenant_id, created_at DESC);`, 'INDEX audit_logs_tenant');
    await tryQuery(client, `CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);`, 'INDEX audit_logs_entity');
    await tryQuery(client, `ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;`, 'RLS audit_logs');
    await tryQuery(client, `DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_logs' AND policyname='audit_logs_tenant_isolation') THEN
          CREATE POLICY audit_logs_tenant_isolation ON public.audit_logs
            USING (tenant_id::text = nullif(current_setting('app.current_tenant', true), '') OR current_setting('app.current_user_role', true) = 'super_admin')
            WITH CHECK (tenant_id::text = nullif(current_setting('app.current_tenant', true), '') OR current_setting('app.current_user_role', true) = 'super_admin');
        END IF;
      END
    $$;`, 'POLICY audit_logs_tenant_isolation');

    // 3. Colunas extras tenants
    console.log('\n-- 3. Colunas extras tenants --');
    await tryQuery(client, `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'active';`, 'tenants.status');
    await tryQuery(client, `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS business_types text[] DEFAULT ARRAY['fleet','plant'];`, 'tenants.business_types');
    await tryQuery(client, `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS max_assets integer DEFAULT 50;`, 'tenants.max_assets');
    await tryQuery(client, `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS max_users integer DEFAULT 10;`, 'tenants.max_users');
    await tryQuery(client, `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS max_storage_mb integer DEFAULT 1024;`, 'tenants.max_storage_mb');
    await tryQuery(client, `ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS features_enabled jsonb DEFAULT '{"fuel": true, "qr_field": true, "compliance": true}'::jsonb;`, 'tenants.features_enabled');

    // 4. Colunas extras app_users
    console.log('\n-- 4. Colunas extras app_users --');
    await tryQuery(client, `ALTER TABLE public.app_users ALTER COLUMN role TYPE public.user_role USING role::public.user_role;`, 'app_users.role -> enum');
    await tryQuery(client, `ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;`, 'app_users.last_login_at');
    await tryQuery(client, `ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS default_operational_scope varchar(20);`, 'app_users.default_operational_scope');
    await tryQuery(client, `ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS phone varchar(50);`, 'app_users.phone');
    await tryQuery(client, `ALTER TABLE public.app_users ADD CONSTRAINT IF NOT EXISTS tenant_role_integrity CHECK (
      (role = 'super_admin' AND tenant_id IS NULL) OR
      (role <> 'super_admin' AND tenant_id IS NOT NULL)
    );`, 'CONSTRAINT tenant_role_integrity');
    // 5. Colunas extras assets
    console.log('\n-- 5. Colunas extras assets --');
    await tryQuery(client, `ALTER TABLE public.assets ALTER COLUMN status TYPE public.asset_status USING status::public.asset_status;`, 'assets.status -> enum');
    await tryQuery(client, `ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS asset_category varchar(100);`, 'assets.asset_category');
    await tryQuery(client, `ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS criticality_level varchar(20);`, 'assets.criticality_level');
    await tryQuery(client, `ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS technical_specs jsonb;`, 'assets.technical_specs');
    await tryQuery(client, `ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS current_meter bigint DEFAULT 0;`, 'assets.current_meter');
    await tryQuery(client, `ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS meter_type public.meter_type DEFAULT 'odometer_km';`, 'assets.meter_type');

    // 6. Colunas extras work_orders
    console.log('\n-- 6. Colunas extras work_orders --');
    await tryQuery(client, `ALTER TABLE public.work_orders ALTER COLUMN order_type TYPE public.wo_type USING order_type::public.wo_type;`, 'work_orders.order_type -> enum');
    await tryQuery(client, `ALTER TABLE public.work_orders ALTER COLUMN priority TYPE public.wo_priority USING priority::public.wo_priority;`, 'work_orders.priority -> enum');
    await tryQuery(client, `ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS wo_number bigint;`, 'work_orders.wo_number');
    await tryQuery(client, `ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS opened_at timestamptz;`, 'work_orders.opened_at');
    await tryQuery(client, `ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS parts_cost numeric(12,2) DEFAULT 0;`, 'work_orders.parts_cost');
    await tryQuery(client, `ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS labor_cost numeric(12,2) DEFAULT 0;`, 'work_orders.labor_cost');
    await tryQuery(client, `ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS total_cost numeric(12,2) DEFAULT 0;`, 'work_orders.total_cost');
    await tryQuery(client, `CREATE SEQUENCE IF NOT EXISTS public.work_order_seq;`, 'SEQUENCE work_order_seq');
    await tryQuery(client, `CREATE UNIQUE INDEX IF NOT EXISTS work_orders_wo_number_uidx ON public.work_orders (wo_number);`, 'UNIQUE work_orders.wo_number');

    // 7. Colunas extras work_order_events
    console.log('\n-- 7. Colunas extras work_order_events --');
    await tryQuery(client, `ALTER TABLE public.work_order_events ADD COLUMN IF NOT EXISTS justification text;`, 'work_order_events.justification');

    // 8. Colunas extras maintenance_plans
    console.log('\n-- 8. Colunas extras maintenance_plans --');
    await tryQuery(client, `ALTER TABLE public.maintenance_plans ADD COLUMN IF NOT EXISTS code_tag varchar(50);`, 'maintenance_plans.code_tag');
    await tryQuery(client, `ALTER TABLE public.maintenance_plans ADD COLUMN IF NOT EXISTS last_executed_at timestamptz;`, 'maintenance_plans.last_executed_at');
    await tryQuery(client, `ALTER TABLE public.maintenance_plans ADD COLUMN IF NOT EXISTS last_executed_meter bigint;`, 'maintenance_plans.last_executed_meter');
    await tryQuery(client, `ALTER TABLE public.maintenance_plans ADD COLUMN IF NOT EXISTS next_due_date date;`, 'maintenance_plans.next_due_date');

    // 9. Colunas extras maintenance_notifications
    console.log('\n-- 9. Colunas extras maintenance_notifications --');
    await tryQuery(client, `ALTER TABLE public.maintenance_notifications ALTER COLUMN attachment_urls TYPE text[] USING attachment_urls::text[];`, 'maintenance_notifications.attachment_urls -> text[]');
    await tryQuery(client, `ALTER TABLE public.maintenance_notifications ALTER COLUMN occurrence_date TYPE timestamp WITHOUT TIME ZONE USING occurrence_date::timestamp;`, 'maintenance_notifications.occurrence_date -> timestamp');
    await tryQuery(client, `ALTER TABLE public.maintenance_notifications ADD COLUMN IF NOT EXISTS registration_plate varchar(50);`, 'maintenance_notifications.registration_plate');
    await tryQuery(client, `ALTER TABLE public.maintenance_notifications ADD COLUMN IF NOT EXISTS rejection_reason text;`, 'maintenance_notifications.rejection_reason');
    await tryQuery(client, `CREATE SEQUENCE IF NOT EXISTS public.maintenance_notification_seq;`, 'SEQUENCE maintenance_notification_seq');

    // 10. Colunas extras fuel_price_settings
    console.log('\n-- 10. Colunas extras fuel_price_settings --');
    await tryQuery(client, `ALTER TABLE public.fuel_price_settings ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.app_users(id);`, 'fuel_price_settings.updated_by');

    // 11. Triggers e funções
    console.log('\n-- 11. Triggers e funções --');
    await tryQuery(client, `CREATE OR REPLACE FUNCTION public.trg_apply_work_order_part() RETURNS trigger AS $$
      BEGIN
        UPDATE public.parts SET current_stock = current_stock - NEW.quantity, updated_at = NOW()
        WHERE id = NEW.part_id AND tenant_id = NEW.tenant_id AND current_stock >= NEW.quantity;
        IF NOT FOUND THEN RAISE EXCEPTION 'Stock insuficiente para a peça %', NEW.part_id; END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql;`, 'FUNCTION trg_apply_work_order_part');
    await tryQuery(client, `DROP TRIGGER IF EXISTS trg_work_order_parts_consumption ON public.work_order_parts;`, 'DROP TRIGGER trg_work_order_parts_consumption');
    await tryQuery(client, `CREATE TRIGGER trg_work_order_parts_consumption AFTER INSERT ON public.work_order_parts FOR EACH ROW EXECUTE FUNCTION public.trg_apply_work_order_part();`, 'CREATE TRIGGER trg_work_order_parts_consumption');

    await tryQuery(client, `CREATE OR REPLACE FUNCTION public.trg_update_asset_meter_after_fuel() RETURNS trigger AS $$
      BEGIN
        UPDATE public.assets SET current_meter = NEW.current_meter, updated_at = NOW()
        WHERE id = NEW.asset_id AND tenant_id = NEW.tenant_id;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql;`, 'FUNCTION trg_update_asset_meter_after_fuel');
    await tryQuery(client, `DROP TRIGGER IF EXISTS trigger_update_asset_meter ON public.fuel_logs;`, 'DROP TRIGGER trigger_update_asset_meter');
    await tryQuery(client, `CREATE TRIGGER trigger_update_asset_meter AFTER INSERT ON public.fuel_logs FOR EACH ROW EXECUTE FUNCTION public.trg_update_asset_meter_after_fuel();`, 'CREATE TRIGGER trigger_update_asset_meter');

    await tryQuery(client, `CREATE OR REPLACE FUNCTION public.fn_audit_asset_changes() RETURNS trigger AS $$
      BEGIN
        INSERT INTO public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_data, new_data, created_at)
        VALUES (NEW.tenant_id, NEW.uploaded_by, 'asset_change', 'asset', NEW.id, to_jsonb(OLD), to_jsonb(NEW), NOW());
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql;`, 'FUNCTION fn_audit_asset_changes');
    await tryQuery(client, `DROP TRIGGER IF EXISTS trg_audit_assets ON public.assets;`, 'DROP TRIGGER trg_audit_assets');
    await tryQuery(client, `CREATE TRIGGER trg_audit_assets AFTER INSERT OR UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.fn_audit_asset_changes();`, 'CREATE TRIGGER trg_audit_assets');

    await tryQuery(client, `CREATE OR REPLACE FUNCTION public.fn_generate_notification_number() RETURNS trigger AS $$
      BEGIN
        NEW.notification_number := 'MN-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(nextval('public.maintenance_notification_seq')::text, 5, '0');
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql;`, 'FUNCTION fn_generate_notification_number');
    await tryQuery(client, `DROP TRIGGER IF EXISTS trg_set_notification_number ON public.maintenance_notifications;`, 'DROP TRIGGER trg_set_notification_number');
    await tryQuery(client, `CREATE TRIGGER trg_set_notification_number BEFORE INSERT ON public.maintenance_notifications FOR EACH ROW EXECUTE FUNCTION public.fn_generate_notification_number();`, 'CREATE TRIGGER trg_set_notification_number');

    await tryQuery(client, `CREATE OR REPLACE FUNCTION public.fn_sync_app_user_to_technician() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO public.technicians (tenant_id, name, email, phone, user_id, domain, operational_scope, status)
          VALUES (NEW.tenant_id, NEW.full_name, NEW.email, NEW.phone, NEW.id, COALESCE(NEW.operational_scope,'fleet'), COALESCE(NEW.operational_scope,'fleet'), 'active')
          ON CONFLICT (tenant_id, user_id) DO NOTHING;
          RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
          UPDATE public.technicians SET name = NEW.full_name, email = NEW.email, phone = NEW.phone, operational_scope = COALESCE(NEW.operational_scope,'fleet')
          WHERE user_id = NEW.id AND tenant_id = NEW.tenant_id;
          RETURN NEW;
        END IF;
        RETURN NULL;
      END;
    $$ LANGUAGE plpgsql;`, 'FUNCTION fn_sync_app_user_to_technician');
    await tryQuery(client, `DROP TRIGGER IF EXISTS trg_sync_app_user_to_technician ON public.app_users;`, 'DROP TRIGGER trg_sync_app_user_to_technician');
    await tryQuery(client, `CREATE TRIGGER trg_sync_app_user_to_technician AFTER INSERT OR UPDATE ON public.app_users FOR EACH ROW EXECUTE FUNCTION public.fn_sync_app_user_to_technician();`, 'CREATE TRIGGER trg_sync_app_user_to_technician');

    await tryQuery(client, `CREATE OR REPLACE FUNCTION public.fn_sync_asset_status_on_wo_change() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'under_maintenance' OR NEW.status = 'completed' THEN
          UPDATE public.assets SET status = CASE WHEN NEW.status = 'under_maintenance' THEN 'under_maintenance' ELSE 'operational' END, updated_at = NOW()
          WHERE id = NEW.asset_id AND tenant_id = NEW.tenant_id;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql;`, 'FUNCTION fn_sync_asset_status_on_wo_change');
    await tryQuery(client, `DROP TRIGGER IF EXISTS trg_sync_asset_status ON public.work_orders;`, 'DROP TRIGGER trg_sync_asset_status');
    await tryQuery(client, `CREATE TRIGGER trg_sync_asset_status AFTER INSERT OR UPDATE ON public.work_orders FOR EACH ROW EXECUTE FUNCTION public.fn_sync_asset_status_on_wo_change();`, 'CREATE TRIGGER trg_sync_asset_status');

    console.log('\n=== MIGRAÇÃO CONCLUÍDA ===');
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
})();