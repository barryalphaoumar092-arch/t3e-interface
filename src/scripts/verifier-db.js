const { getDb } = require('../db/init');

async function verifier() {
  const db = await getDb();

  console.log('=== VÉRIFICATION DE LA BASE DE DONNÉES T3E ===\n');

  // 1. Statistiques générales
  const stats = db.exec(`
    SELECT
      (SELECT COUNT(*) FROM documents) as total_docs,
      (SELECT COUNT(*) FROM categories) as total_cats,
      (SELECT COUNT(*) FROM documents WHERE statut = 'actif') as docs_actifs,
      (SELECT ROUND(SUM(taille_octets) / 1048576.0, 2) FROM documents) as taille_totale_mb
  `);
  const [totalDocs, totalCats, docsActifs, tailleMb] = stats[0].values[0];
  console.log('--- Statistiques générales ---');
  console.log(`  Documents total : ${totalDocs}`);
  console.log(`  Catégories      : ${totalCats}`);
  console.log(`  Documents actifs: ${docsActifs}`);
  console.log(`  Taille totale   : ${tailleMb} Mo\n`);

  // 2. Documents par catégorie
  console.log('--- Documents par catégorie ---');
  const parCat = db.exec(`
    SELECT c.nom, COUNT(d.id) as nb, ROUND(SUM(d.taille_octets) / 1048576.0, 2) as taille_mb
    FROM categories c
    LEFT JOIN documents d ON d.categorie_id = c.id
    GROUP BY c.id ORDER BY nb DESC
  `);
  if (parCat.length > 0) {
    for (const row of parCat[0].values) {
      console.log(`  ${row[0]}: ${row[1]} doc(s) - ${row[2] || 0} Mo`);
    }
  }

  // 3. Types de fichiers
  console.log('\n--- Types de fichiers ---');
  const types = db.exec(`
    SELECT type_fichier, COUNT(*) as nb FROM documents GROUP BY type_fichier ORDER BY nb DESC
  `);
  if (types.length > 0) {
    for (const row of types[0].values) {
      console.log(`  .${row[0]}: ${row[1]} fichier(s)`);
    }
  }

  // 4. Liste complète des documents
  console.log('\n--- Liste complète des documents ---');
  const docs = db.exec(`
    SELECT d.id, d.titre, c.nom as categorie, d.type_fichier, d.source, d.annee
    FROM documents d
    JOIN categories c ON d.categorie_id = c.id
    ORDER BY c.nom, d.titre
  `);
  if (docs.length > 0) {
    let currentCat = '';
    for (const row of docs[0].values) {
      if (row[2] !== currentCat) {
        currentCat = row[2];
        console.log(`\n  [${currentCat}]`);
      }
      const annee = row[5] ? ` (${row[5]})` : '';
      console.log(`    #${row[0]} - ${row[1]}${annee} [${row[4] || 'N/A'}]`);
    }
  }

  // 5. Vérification de l'intégrité
  console.log('\n\n--- Vérification d\'intégrité ---');
  const fs = require('fs');
  const docsCheck = db.exec('SELECT id, titre, chemin_fichier FROM documents');
  let ok = 0, missing = 0;
  if (docsCheck.length > 0) {
    for (const row of docsCheck[0].values) {
      if (fs.existsSync(row[2])) {
        ok++;
      } else {
        console.log(`  [MANQUANT] #${row[0]} - ${row[1]}: ${row[2]}`);
        missing++;
      }
    }
  }
  console.log(`  Fichiers présents : ${ok}/${totalDocs}`);
  console.log(`  Fichiers manquants: ${missing}`);

  // 6. Structure des tables
  console.log('\n--- Structure de la base de données ---');
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  if (tables.length > 0) {
    for (const row of tables[0].values) {
      console.log(`  Table: ${row[0]}`);
    }
  }

  console.log('\n=== VÉRIFICATION TERMINÉE ===');
  db.close();
}

verifier().catch(console.error);
