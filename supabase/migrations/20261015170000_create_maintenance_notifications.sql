CREATE SEQUENCE IF NOT EXISTS public.maintenance_notification_number_seq;

CREATE OR REPLACE FUNCTION public.generate_maintenance_notification_number()
RETURNS varchar
LANGUAGE sql
VOLATILE
AS $$
  SELECT (
    'MN-' || EXTRACT(YEAR FROM CURRENT_DATE)::integer || '-' ||
    LPAD(number::text, GREATEST(5, length(number::text)), '0')
  )::varchar
  FROM (
    SELECT nextval('public.maintenance_notification_number_seq') AS number
  ) AS generated
$$;

CREATE TABLE IF NOT EXISTS public.maintenance_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_number varchar(32) NOT NULL
    DEFAULT public.generate_maintenance_notification_number() UNIQUE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  asset_id uuid NOT NULL REFERENCES public.assets(id),
  asset_code varchar(255) NOT NULL,
  asset_registration varchar(255),
  asset_sector varchar(255),
  domain varchar(10) NOT NULL CHECK (domain IN ('fleet', 'plant')),
  area_process text,
  occurrence_location text,
  occurrence_date date,
  requester_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  requester_name varchar(255) NOT NULL,
  operator_name varchar(255),
  priority varchar(20) NOT NULL
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  maintenance_type varchar(20) NOT NULL
    CHECK (maintenance_type IN ('corrective', 'preventive', 'inspection')),
  meter_reading numeric CHECK (meter_reading IS NULL OR meter_reading >= 0),
  operational_status text,
  problem_description text NOT NULL,
  attachment_urls jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachment_urls) = 'array'),
  status varchar(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_triage', 'converted_to_wo')),
  work_order_id uuid REFERENCES public.work_orders(id),
  triaged_by uuid REFERENCES public.app_users(id),
  triaged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS maintenance_notifications_tenant_domain_created_idx
  ON public.maintenance_notifications (tenant_id, domain, created_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_notifications_tenant_status_idx
  ON public.maintenance_notifications (tenant_id, domain, status, created_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_notifications_tenant_asset_idx
  ON public.maintenance_notifications (tenant_id, asset_id, created_at DESC);

ALTER TABLE public.maintenance_notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'maintenance_notifications'
      AND policyname = 'maintenance_notifications_tenant_isolation'
  ) THEN
    CREATE POLICY maintenance_notifications_tenant_isolation
      ON public.maintenance_notifications
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

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS estimated_hours numeric
    CHECK (estimated_hours IS NULL OR estimated_hours >= 0),
  ADD COLUMN IF NOT EXISTS planned_date date,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS reported_by uuid REFERENCES public.app_users(id);
