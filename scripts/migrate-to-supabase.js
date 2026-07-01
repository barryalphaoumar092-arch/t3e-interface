// Migration one-off : upload de documents/FT, documents/templates-soumission
// et des fichiers isoles de documents/ vers les buckets Supabase Storage.
// Usage : node scripts/migrate-to-supabase.js
require('../src/load-env');
const fs = require('fs');
const path = require('path');
const { ensureBucket, uploadBuffer, sanitizeKey, BUCKETS } = require('../src/services/storage');

const DOCUMENTS_DIR = path.join(__dirname, '..', 'documents');
const FT_DIR = path.join(DOCUMENTS_DIR, 'FT');
const TEMPLATES_DIR = path.join(DOCUMENTS_DIR, 'templates-soumission');

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function contentTypeFor(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

async function uploadTree(localDir, bucket, label) {
  if (!fs.existsSync(localDir)) {
    console.log(`[skip] ${label} : dossier introuvable (${localDir})`);
    return;
  }
  const files = walkFiles(localDir);
  console.log(`[${label}] ${files.length} fichier(s) a uploader vers bucket "${bucket}"`);
  let done = 0;
  for (const filePath of files) {
    const rawKey = path.relative(localDir, filePath).split(path.sep).join('/');
    const key = sanitizeKey(rawKey);
    const buffer = fs.readFileSync(filePath);
    await uploadBuffer(bucket, key, buffer, contentTypeFor(filePath));
    done++;
    if (done % 10 === 0 || done === files.length) {
      console.log(`  [${label}] ${done}/${files.length} : ${key}`);
    }
  }
}

async function uploadLooseDocuments() {
  const bucket = BUCKETS.DOCUMENTS;
  const entries = fs.readdirSync(DOCUMENTS_DIR, { withFileTypes: true })
    .filter(e => e.isFile());
  console.log(`[documents] ${entries.length} fichier(s) isole(s) a uploader vers bucket "${bucket}"`);
  let done = 0;
  for (const entry of entries) {
    const filePath = path.join(DOCUMENTS_DIR, entry.name);
    const key = sanitizeKey(entry.name);
    const buffer = fs.readFileSync(filePath);
    await uploadBuffer(bucket, key, buffer, contentTypeFor(filePath));
    done++;
    console.log(`  [documents] ${done}/${entries.length} : ${entry.name} -> ${key}`);
  }
}

async function main() {
  console.log('Creation des buckets (si absents)...');
  await ensureBucket(BUCKETS.DOCUMENTS);
  await ensureBucket(BUCKETS.FICHES_TECHNIQUES);
  await ensureBucket(BUCKETS.TEMPLATES_SOUMISSION);
  await ensureBucket(BUCKETS.SOUMISSIONS_GENEREES);

  await uploadTree(FT_DIR, BUCKETS.FICHES_TECHNIQUES, 'FT');
  await uploadTree(TEMPLATES_DIR, BUCKETS.TEMPLATES_SOUMISSION, 'templates-soumission');
  await uploadLooseDocuments();

  console.log('Migration terminee.');
}

main().catch(err => {
  console.error('Erreur migration:', err);
  process.exit(1);
});
