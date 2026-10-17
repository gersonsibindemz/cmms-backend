ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS equipment_code text,
  ADD COLUMN IF NOT EXISTS department text,
  ADD COLUMN IF NOT EXISTS criticality text,
  ADD COLUMN IF NOT EXISTS operator_name text,
  ADD COLUMN IF NOT EXISTS manufacturer text,
  ADD COLUMN IF NOT EXISTS model_version text,
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS chassis_number text,
  ADD COLUMN IF NOT EXISTS color_config text,
  ADD COLUMN IF NOT EXISTS initial_km numeric CHECK (initial_km IS NULL OR initial_km >= 0),
  ADD COLUMN IF NOT EXISTS initial_hour_meter numeric
    CHECK (initial_hour_meter IS NULL OR initial_hour_meter >= 0),
  ADD COLUMN IF NOT EXISTS measurement_unit text,
  ADD COLUMN IF NOT EXISTS operational_shift text,
  ADD COLUMN IF NOT EXISTS acquisition_date date,
  ADD COLUMN IF NOT EXISTS operation_start_date date,
  ADD COLUMN IF NOT EXISTS acquisition_value numeric
    CHECK (acquisition_value IS NULL OR acquisition_value >= 0),
  ADD COLUMN IF NOT EXISTS currency varchar(3),
  ADD COLUMN IF NOT EXISTS vendor_supplier text,
  ADD COLUMN IF NOT EXISTS warranty_until date,
  ADD COLUMN IF NOT EXISTS next_inspection_date date,
  ADD COLUMN IF NOT EXISTS maintenance_plan_id uuid,
  ADD COLUMN IF NOT EXISTS maintenance_type text,
  ADD COLUMN IF NOT EXISTS safety_checks jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safety_checks) = 'object');
