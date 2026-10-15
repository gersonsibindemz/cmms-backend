CREATE TABLE IF NOT EXISTS public.compliance_notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  asset_id uuid NOT NULL REFERENCES public.assets(id),
  compliance_type varchar(50) NOT NULL
    CHECK (compliance_type IN ('inatro_inspection', 'insurance')),
  notification_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_id, compliance_type, notification_date)
);

CREATE INDEX IF NOT EXISTS compliance_notification_logs_tenant_date_idx
  ON public.compliance_notification_logs (tenant_id, notification_date DESC);

ALTER TABLE public.compliance_notification_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'compliance_notification_logs'
      AND policyname = 'compliance_notification_logs_tenant_isolation'
  ) THEN
    CREATE POLICY compliance_notification_logs_tenant_isolation
      ON public.compliance_notification_logs
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
