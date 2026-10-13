CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  domain varchar(10) NOT NULL CHECK (domain IN ('fleet', 'plant')),
  user_id uuid,
  target_role varchar(50),
  title text NOT NULL,
  message text NOT NULL,
  link text,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_tenant_domain_created_idx
  ON public.notifications (tenant_id, domain, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications (tenant_id, domain, user_id, created_at DESC)
  WHERE is_read = false;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notifications'
      AND policyname = 'notifications_tenant_isolation'
  ) THEN
    CREATE POLICY notifications_tenant_isolation
      ON public.notifications
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
