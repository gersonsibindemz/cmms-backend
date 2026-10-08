CREATE TABLE IF NOT EXISTS public.asset_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  asset_id uuid NOT NULL REFERENCES public.assets(id),
  document_type varchar(50) NOT NULL CHECK (
    document_type IN ('tech_sheet', 'manual', 'diagram', 'inspection_certificate', 'insurance', 'asset_photo')
  ),
  title varchar(255) NOT NULL,
  file_url text NOT NULL,
  file_name varchar(255) NOT NULL,
  storage_path text,
  mime_type varchar(100) NOT NULL CHECK (
    mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 20971520),
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.asset_documents
  ADD COLUMN IF NOT EXISTS storage_path text;

CREATE UNIQUE INDEX IF NOT EXISTS asset_documents_storage_path_uidx
  ON public.asset_documents (storage_path)
  WHERE storage_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS asset_documents_tenant_asset_created_idx
  ON public.asset_documents (tenant_id, asset_id, created_at DESC);

ALTER TABLE public.asset_documents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'asset_documents'
      AND policyname = 'asset_documents_tenant_isolation'
  ) THEN
    CREATE POLICY asset_documents_tenant_isolation
      ON public.asset_documents
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
