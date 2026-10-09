CREATE TABLE IF NOT EXISTS public.technicians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid REFERENCES public.app_users(id),
  name varchar(255) NOT NULL,
  specialty varchar(255),
  phone varchar(100),
  email varchar(320),
  hourly_rate numeric CHECK (hourly_rate IS NULL OR hourly_rate >= 0),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS technicians_tenant_user_uidx
  ON public.technicians (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS technicians_tenant_active_name_idx
  ON public.technicians (tenant_id, name)
  WHERE deleted_at IS NULL AND status = 'active';

ALTER TABLE public.technicians ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'technicians'
      AND policyname = 'technicians_tenant_isolation'
  ) THEN
    CREATE POLICY technicians_tenant_isolation
      ON public.technicians
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

CREATE TABLE IF NOT EXISTS public.work_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id),
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  event_type varchar(20) NOT NULL
    CHECK (event_type IN ('start', 'pause', 'resume', 'interrupt', 'complete')),
  reason text,
  justification text,
  meter_at_service numeric CHECK (
    meter_at_service IS NULL OR meter_at_service >= 0
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    event_type NOT IN ('pause', 'interrupt')
    OR (
      nullif(trim(reason), '') IS NOT NULL
      AND nullif(trim(justification), '') IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS work_order_events_tenant_order_created_idx
  ON public.work_order_events (tenant_id, work_order_id, created_at, id);

ALTER TABLE public.work_order_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'work_order_events'
      AND policyname = 'work_order_events_tenant_isolation'
  ) THEN
    CREATE POLICY work_order_events_tenant_isolation
      ON public.work_order_events
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

DO $$
DECLARE
  status_attnum smallint;
  status_constraint record;
BEGIN
  SELECT attnum
  INTO status_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.work_orders'::regclass
    AND attname = 'status'
    AND NOT attisdropped;

  FOR status_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.work_orders'::regclass
      AND contype = 'c'
      AND status_attnum = ANY (conkey)
  LOOP
    EXECUTE format(
      'ALTER TABLE public.work_orders DROP CONSTRAINT %I',
      status_constraint.conname
    );
  END LOOP;

  ALTER TABLE public.work_orders
    ADD CONSTRAINT work_orders_status_check
    CHECK (status IN (
      'open', 'assigned', 'in_progress', 'waiting_parts', 'blocked', 'completed', 'cancelled'
    ));
END
$$;
