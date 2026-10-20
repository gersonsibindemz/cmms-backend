-- Fix technicians table constraints and sync trigger
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'technicians_tenant_user_unique'
  ) THEN
    ALTER TABLE public.technicians ADD CONSTRAINT technicians_tenant_user_unique UNIQUE (tenant_id, user_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_technicians_tenant_user_not_null
ON public.technicians (tenant_id, user_id) WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_sync_app_user_to_technician()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'technician' AND NEW.tenant_id IS NOT NULL THEN
      INSERT INTO public.technicians (
        tenant_id, name, email, phone, user_id, domain, operational_scope, status
      )
      VALUES (
        NEW.tenant_id, NEW.full_name, NEW.email, NEW.phone, NEW.id,
        COALESCE(NEW.operational_scope, 'fleet'), COALESCE(NEW.operational_scope, 'fleet'), 'active'
      )
      ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET name = EXCLUDED.name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            domain = EXCLUDED.domain,
            operational_scope = EXCLUDED.operational_scope,
            status = 'active',
            deleted_at = NULL,
            updated_at = NOW();
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.role = 'technician' AND NEW.tenant_id IS NOT NULL THEN
      INSERT INTO public.technicians (
        tenant_id, name, email, phone, user_id, domain, operational_scope, status
      )
      VALUES (
        NEW.tenant_id, NEW.full_name, NEW.email, NEW.phone, NEW.id,
        COALESCE(NEW.operational_scope, 'fleet'), COALESCE(NEW.operational_scope, 'fleet'), 'active'
      )
      ON CONFLICT (tenant_id, user_id) DO UPDATE
        SET name = EXCLUDED.name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            domain = EXCLUDED.domain,
            operational_scope = EXCLUDED.operational_scope,
            status = CASE WHEN NEW.is_active THEN 'active' ELSE 'inactive' END,
            deleted_at = CASE WHEN NEW.deleted_at IS NOT NULL THEN NEW.deleted_at ELSE NULL END,
            updated_at = NOW();
    ELSE
      UPDATE public.technicians
         SET status = 'inactive',
             updated_at = NOW()
       WHERE user_id = NEW.id AND tenant_id = NEW.tenant_id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
