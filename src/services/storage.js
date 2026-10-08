import { createClient } from '@supabase/supabase-js';
import { basename } from 'node:path';

const BUCKET_NAME = 'asset-documents';

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

function sanitizeFileName(fileName) {
  return basename(fileName.replaceAll('\\', '/'))
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .slice(0, 200) || 'document';
}

export async function uploadAssetFile(tenantId, assetId, fileBuffer, fileName, mimeType) {
  const storagePath = `${tenantId}/${assetId}/${Date.now()}-${sanitizeFileName(fileName)}`;
  const { error } = await getSupabaseClient()
    .storage
    .from(BUCKET_NAME)
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: false,
    });

  if (error) throw error;
  return storagePath;
}

export async function getSignedFileUrl(filePath, expiresInSeconds = 3600) {
  const { data, error } = await getSupabaseClient()
    .storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, expiresInSeconds);

  if (error) throw error;
  return data.signedUrl;
}

export async function removeAssetFile(filePath) {
  const { error } = await getSupabaseClient()
    .storage
    .from(BUCKET_NAME)
    .remove([filePath]);

  if (error) throw error;
}
