// Client Supabase Storage — remplace le stockage disque local (ephemere sur
// Vercel) pour tous les fichiers persistants : FT, templates Word, documents
// de connaissances, soumissions generees.
const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getClient() {
  if (_client) return _client;
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes.');
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

const BUCKETS = {
  DOCUMENTS: 'documents',
  FICHES_TECHNIQUES: 'fiches-techniques',
  TEMPLATES_SOUMISSION: 'templates-soumission',
  SOUMISSIONS_GENEREES: 'soumissions-generees',
};

// Supabase Storage rejette les cles avec accents/caracteres speciaux.
// On les normalise a l'upload ET a la lecture (matching insensible aux accents)
// pour que les deux cotes retrouvent toujours le meme fichier.
function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function sanitizeKey(key) {
  return String(key || '')
    .split('/')
    .map(seg => stripAccents(seg).replace(/[^A-Za-z0-9 ._-]/g, '_'))
    .join('/');
}

async function ensureBucket(bucket) {
  const supabase = getClient();
  const { data, error } = await supabase.storage.getBucket(bucket);
  if (data) return;
  if (error && !/not found/i.test(error.message || '')) throw error;
  const { error: createErr } = await supabase.storage.createBucket(bucket, { public: false });
  if (createErr && !/already exists/i.test(createErr.message || '')) throw createErr;
}

async function uploadBuffer(bucket, key, buffer, contentType) {
  const supabase = getClient();
  const { error } = await supabase.storage.from(bucket).upload(key, buffer, {
    contentType: contentType || 'application/octet-stream',
    upsert: true,
  });
  if (error) throw error;
}

async function downloadBuffer(bucket, key) {
  const supabase = getClient();
  const { data, error } = await supabase.storage.from(bucket).download(key);
  if (error) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function removeFile(bucket, key) {
  const supabase = getClient();
  const { error } = await supabase.storage.from(bucket).remove([key]);
  if (error) throw error;
}

// Liste les entrees a un niveau de "dossier" donne (prefix). Les sous-dossiers
// simules par Supabase Storage apparaissent avec id === null.
async function listFiles(bucket, prefix = '') {
  const supabase = getClient();
  const { data, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) throw error;
  return data || [];
}

module.exports = { getClient, BUCKETS, ensureBucket, uploadBuffer, downloadBuffer, removeFile, listFiles, sanitizeKey, stripAccents };
