CREATE SEQUENCE IF NOT EXISTS public.maintenance_plan_code_seq;

ALTER TABLE public.maintenance_plans
  ADD COLUMN IF NOT EXISTS plan_code varchar(32);

UPDATE public.maintenance_plans
SET plan_code = 'PLN-' || to_char(nextval('public.maintenance_plan_code_seq'), 'FM000')
WHERE plan_code IS NULL;

ALTER TABLE public.maintenance_plans
  ALTER COLUMN plan_code SET DEFAULT (
    'PLN-' || to_char(nextval('public.maintenance_plan_code_seq'), 'FM000')
  ),
  ALTER COLUMN plan_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS maintenance_plans_tenant_plan_code_uidx
  ON public.maintenance_plans (tenant_id, plan_code);
