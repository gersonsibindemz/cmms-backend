import { createClient } from '@supabase/supabase-js';

const BUCKET_NAME = 'asset-documents';
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60;

let supabaseClient;

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios para usar o storage.');
  }

  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return supabaseClient;
}

export async function uploadAssetDocument(storagePath, file) {
  const { data, error } = await getSupabaseClient()
    .storage
    .from(BUCKET_NAME)
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });

  if (error) throw error;
  return data.path;
}

export async function createAssetDocumentSignedUrl(storagePath) {
  const { data, error } = await getSupabaseClient()
    .storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS);

  if (error) throw error;
  return data.signedUrl;
}

export async function removeAssetDocument(storagePath) {
  const { error } = await getSupabaseClient()
    .storage
    .from(BUCKET_NAME)
    .remove([storagePath]);

  if (error) throw error;
}
