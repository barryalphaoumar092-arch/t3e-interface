// Client Supabase Storage — remplace le stockage disque local (ephemere sur
// Vercel) pour tous les fichiers persistants : FT, templates Word, documents
// de connaissances, soumissions generees.
const { createClient } = require('@supabase/supabase-js');

let _client = null;

// Nettoie une valeur d'env var copiee-collee depuis un tableau de bord :
// guillemets/apostrophes/backticks entourant accidentellement la valeur
// (erreur frequente en collant depuis certaines interfaces), et slash final
// (storage-js construit ses URLs avec un "/" -- un double "//" en resultant
// peut faire echouer la validation de chemin cote Supabase avec l'erreur
// generique "Invalid path specified in request URL").
function nettoyerValeurEnv(v) {
  return String(v || '').trim().replace(/^['"`]+|['"`]+$/g, '').replace(/\/+$/, '');
}

function getClient() {
  if (_client) return _client;
  const url = nettoyerValeurEnv(process.env.SUPABASE_URL);
  const key = nettoyerValeurEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes.');
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// Diagnostic (non sensible : l'URL du projet Supabase est publique, la cle
// n'est jamais exposee) -- utilise par /api/admin/reparer-buckets pour
// afficher la valeur EXACTE reellement utilisee par le serveur, notamment sa
// longueur et sa forme JSON (revele espaces/guillemets invisibles a l'oeil).
function diagnosticUrl() {
  const brut = process.env.SUPABASE_URL || '';
  const nettoye = nettoyerValeurEnv(brut);
  return { brut: JSON.stringify(brut), nettoye: JSON.stringify(nettoye), longueurBrute: brut.length };
}

const BUCKETS = {
  DOCUMENTS: 'documents',
  FICHES_TECHNIQUES: 'fiches-techniques',
  TEMPLATES_SOUMISSION: 'templates-soumission',
  SOUMISSIONS_GENEREES: 'soumissions-generees',
  UPLOADS_TEMP: 'uploads-temp',
  MANUELS: 'manuels-fin-chantier',
  SEAO: 'appels-offres-seao',
  BORDEREAUX_FT_PROJET: 'bordereaux-fiches-projet',
  BORDEREAUX_GENERES: 'bordereaux-generes',
  PLANS_ASBUILT: 'plans-asbuilt',
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

// Genere une URL d'upload signee : le navigateur envoie le fichier DIRECTEMENT
// a Supabase Storage, sans passer par la fonction serverless Vercel (limitee
// a 4.5 Mo de corps de requete).
async function createSignedUploadUrl(bucket, key) {
  const supabase = getClient();
  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(key);
  if (error) throw error;
  return data; // { signedUrl, token, path }
}

// Genere une URL de telechargement signee : le navigateur recoit le fichier
// DIRECTEMENT depuis Supabase Storage, sans passer par le corps de reponse de
// la fonction serverless Vercel (meme limite de 4.5 Mo que pour l'upload —
// voir createSignedUploadUrl). Indispensable pour les PDF fusionnes volumineux
// (ex: manuel de fin de chantier avec de nombreuses fiches techniques).
async function createSignedUrl(bucket, key, expiresIn = 300, nomTelechargement) {
  const supabase = getClient();
  const options = nomTelechargement ? { download: nomTelechargement } : undefined;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(key, expiresIn, options);
  if (error) throw error;
  return data.signedUrl;
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

// chemin_fichier (table `documents`) est normalement "documents/{fichier}"
// (bucket "documents", a plat) -- mais pour certains documents de la base de
// connaissances (ex : fiches techniques stockees dans le bucket
// "fiches-techniques", sous des sous-dossiers par fabricant) le premier
// segment peut designer un AUTRE bucket connu. On ne retombe sur le
// comportement historique (bucket "documents", cle = basename) que si ce
// premier segment n'est pas un bucket reconnu, pour ne rien casser sur les
// documents deja corrects. Utilise par connaissances.js ET seao-annexes.js
// (meme piege rencontre dans les deux : deviner une cle a plat plutot que
// resoudre le vrai chemin fait echouer silencieusement le telechargement
// d'un document pourtant bien present et trouve par titre).
const BUCKETS_CONNUS = new Set(Object.values(BUCKETS));
function resoudreBucketEtCle(cheminFichier, nomFichier) {
  const brut = cheminFichier || nomFichier || '';
  const segments = brut.split('/');
  if (segments.length > 1 && BUCKETS_CONNUS.has(segments[0])) {
    return { bucket: segments[0], key: sanitizeKey(segments.slice(1).join('/')) };
  }
  const path = require('path');
  return { bucket: BUCKETS.DOCUMENTS, key: sanitizeKey(path.basename(brut)) };
}

module.exports = { getClient, BUCKETS, ensureBucket, uploadBuffer, downloadBuffer, createSignedUploadUrl, createSignedUrl, removeFile, listFiles, sanitizeKey, stripAccents, resoudreBucketEtCle, diagnosticUrl };
