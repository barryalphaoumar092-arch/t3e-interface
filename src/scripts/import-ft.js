const fs = require('fs');
const path = require('path');
const { createTursoClient } = require('../db/turso-client');

const db = createTursoClient(
  process.env.TURSO_DATABASE_URL,
  process.env.TURSO_AUTH_TOKEN
);

const FT_DIR = path.join(__dirname, '..', '..', 'documents', 'FT');

async function importFT() {
  console.log('=== Import des fiches techniques (FT) ===\n');

  const catResult = await db.execute("SELECT id FROM categories WHERE nom = 'Fiches techniques'");
  let catId;
  if (catResult.rows.length === 0) {
    const ins = await db.execute({
      sql: "INSERT INTO categories (nom, description) VALUES (?, ?)",
      args: ['Fiches techniques', 'Fiches techniques et dessins d\'atelier des fournisseurs']
    });
    catId = ins.lastInsertRowid;
    console.log('Categorie "Fiches techniques" creee (id=' + catId + ')');
  } else {
    catId = catResult.rows[0].id;
    console.log('Categorie "Fiches techniques" existante (id=' + catId + ')');
  }

  function scanDir(dir, relativePath) {
    const entries = [];
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const rel = relativePath ? relativePath + '/' + item : item;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        entries.push(...scanDir(full, rel));
      } else {
        entries.push({ name: item, path: rel, fullPath: full, size: stat.size });
      }
    }
    return entries;
  }

  const files = scanDir(FT_DIR, '');
  console.log(`${files.length} fichiers trouves\n`);

  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase().replace('.', '');
    if (!['pdf', 'docx', 'doc'].includes(ext)) {
      skipped++;
      continue;
    }

    const parts = file.path.split('/');
    const fournisseur = parts.length > 1 ? parts[0] : 'Divers';
    const titre = path.basename(file.name, path.extname(file.name))
      .replace(/[-_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const existing = await db.execute({
      sql: "SELECT id FROM documents WHERE nom_fichier = ?",
      args: [file.name]
    });
    if (existing.rows.length > 0) {
      skipped++;
      continue;
    }

    await db.execute({
      sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, mots_cles)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        titre,
        file.name,
        'documents/FT/' + file.path,
        catId,
        ext,
        file.size,
        'Fiche technique - ' + fournisseur,
        fournisseur,
        fournisseur.toLowerCase() + ', fiche technique, ' + ext
      ]
    });
    imported++;
    console.log(`  [OK] ${fournisseur} / ${file.name}`);
  }

  console.log(`\n=== Resultat ===`);
  console.log(`Importes: ${imported}`);
  console.log(`Ignores: ${skipped} (deja existants ou format non supporte)`);

  const total = await db.execute('SELECT COUNT(*) as c FROM documents');
  console.log(`Total documents en base: ${total.rows[0].c}`);
}

importFT().catch(err => {
  console.error('Erreur:', err);
  process.exit(1);
});
