import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const BUCKET_NAME = 'asset-documents';
const USER_AVATARS_BUCKET_NAME = 'user-avatars';
const FILE_EXTENSIONS_BY_MIME_TYPE = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);
const AVATAR_EXTENSIONS_BY_MIME_TYPE = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

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

export async function uploadAssetFile(tenantId, assetId, fileBuffer, _fileName, mimeType) {
  const fileExtension = FILE_EXTENSIONS_BY_MIME_TYPE.get(mimeType);
  if (!fileExtension) {
    throw new Error('Tipo MIME não permitido para o upload de documentos.');
  }

  const storagePath = `${tenantId}/${assetId}/${Date.now()}-${randomUUID()}${fileExtension}`;
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

export async function uploadUserAvatar(userId, fileBuffer, mimeType) {
  const fileExtension = AVATAR_EXTENSIONS_BY_MIME_TYPE.get(mimeType);
  if (!fileExtension) {
    throw new Error('Tipo MIME não permitido para a foto de perfil.');
  }

  const storagePath = `${userId}/user-${userId}-${randomUUID()}${fileExtension}`;
  const storage = getSupabaseClient().storage.from(USER_AVATARS_BUCKET_NAME);
  const { error } = await storage.upload(storagePath, fileBuffer, {
    contentType: mimeType,
    upsert: false,
  });

  if (error) throw error;
  const { data } = storage.getPublicUrl(storagePath);
  return { storagePath, publicUrl: data.publicUrl };
}

export async function removeUserAvatar(filePath) {
  const { error } = await getSupabaseClient()
    .storage
    .from(USER_AVATARS_BUCKET_NAME)
    .remove([filePath]);

  if (error) throw error;
}
