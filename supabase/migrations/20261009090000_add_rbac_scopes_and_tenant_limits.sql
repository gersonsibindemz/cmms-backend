ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS max_users_limit integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS operational_scope varchar(10) NOT NULL DEFAULT 'fleet',
  ADD COLUMN IF NOT EXISTS default_operational_scope varchar(10) NOT NULL DEFAULT 'fleet';

ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_max_users_limit_check
    CHECK (max_users_limit >= 0),
  ADD CONSTRAINT tenants_operational_scope_check
    CHECK (operational_scope IN ('fleet', 'plant', 'mixed')),
  ADD CONSTRAINT tenants_default_operational_scope_check
    CHECK (default_operational_scope IN ('fleet', 'plant'));

UPDATE public.tenants
SET default_operational_scope = operational_scope
WHERE operational_scope IN ('fleet', 'plant');

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS operational_scope varchar(10) NOT NULL DEFAULT 'fleet';

UPDATE public.app_users AS users
SET operational_scope = CASE
  WHEN tenants.operational_scope IN ('fleet', 'plant') THEN tenants.operational_scope
  ELSE 'fleet'
END
FROM public.tenants AS tenants
WHERE users.tenant_id = tenants.id
  AND users.role::text IN ('supervisor', 'technician', 'driver_operator');

ALTER TABLE public.app_users
  ADD CONSTRAINT app_users_operational_scope_check
    CHECK (operational_scope IN ('fleet', 'plant'));

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS domain varchar(10) NOT NULL DEFAULT 'fleet';

ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS domain varchar(10) NOT NULL DEFAULT 'fleet';

ALTER TABLE public.technicians
  ADD COLUMN IF NOT EXISTS domain varchar(10) NOT NULL DEFAULT 'fleet';

UPDATE public.assets AS assets
SET domain = tenants.operational_scope
FROM public.tenants AS tenants
WHERE assets.tenant_id = tenants.id
  AND tenants.operational_scope IN ('fleet', 'plant');

UPDATE public.work_orders AS orders
SET domain = assets.domain
FROM public.assets AS assets
WHERE orders.asset_id = assets.id
  AND orders.tenant_id = assets.tenant_id;

UPDATE public.technicians AS technicians
SET domain = tenants.default_operational_scope
FROM public.tenants AS tenants
WHERE technicians.tenant_id = tenants.id;

UPDATE public.technicians AS technicians
SET domain = users.operational_scope
FROM public.app_users AS users
WHERE technicians.user_id = users.id
  AND technicians.tenant_id = users.tenant_id
  AND users.operational_scope IN ('fleet', 'plant');

ALTER TABLE public.assets
  ADD CONSTRAINT assets_domain_check CHECK (domain IN ('fleet', 'plant'));

ALTER TABLE public.work_orders
  ADD CONSTRAINT work_orders_domain_check CHECK (domain IN ('fleet', 'plant'));

ALTER TABLE public.technicians
  ADD CONSTRAINT technicians_domain_check CHECK (domain IN ('fleet', 'plant'));
