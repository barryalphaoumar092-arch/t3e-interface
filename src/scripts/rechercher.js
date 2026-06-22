const { getDb } = require('../db/init');

function escape(str) {
  return str.replace(/'/g, "''");
}

async function rechercher(terme) {
  const db = await getDb();
  const t = escape(terme);

  console.log(`\nRecherche: "${terme}"\n`);

  // 1. Documents
  const docs = db.exec(`
    SELECT d.id, d.titre, c.nom as categorie, d.description, d.source, d.annee, d.nom_fichier
    FROM documents d
    JOIN categories c ON d.categorie_id = c.id
    WHERE d.titre LIKE '%${t}%'
       OR d.description LIKE '%${t}%'
       OR d.mots_cles LIKE '%${t}%'
       OR c.nom LIKE '%${t}%'
       OR d.source LIKE '%${t}%'
    ORDER BY c.nom, d.titre
  `);

  if (docs.length > 0 && docs[0].values.length > 0) {
    console.log(`=== DOCUMENTS (${docs[0].values.length}) ===\n`);
    for (const row of docs[0].values) {
      const annee = row[5] ? ` (${row[5]})` : '';
      console.log(`  #${row[0]} - ${row[1]}${annee}`);
      console.log(`    Catégorie: ${row[2]} | Source: ${row[4]}`);
      console.log(`    ${row[3]}`);
      console.log(`    Fichier: ${row[6]}\n`);
    }
  }

  // 2. Matériaux
  const mats = db.exec(`
    SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, lien_fiche_technique, lien_fiche_securite
    FROM materiaux
    WHERE nom LIKE '%${t}%'
       OR fabricant LIKE '%${t}%'
       OR type_produit LIKE '%${t}%'
       OR type_systeme LIKE '%${t}%'
       OR fournisseur LIKE '%${t}%'
    ORDER BY type_produit, fabricant, nom
  `);

  if (mats.length > 0 && mats[0].values.length > 0) {
    console.log(`=== MATÉRIAUX (${mats[0].values.length}) ===\n`);
    for (const row of mats[0].values) {
      console.log(`  #${row[0]} - ${row[1]}`);
      console.log(`    ${row[3]} | ${row[4]} | Fab: ${row[2]} | Fourn: ${row[5]}`);
      if (row[6]) console.log(`    Dimension: ${row[6]}`);
      if (row[7]) console.log(`    Fiche technique: ${row[7]}`);
      if (row[8]) console.log(`    Fiche SDS: ${row[8]}`);
      console.log('');
    }
  }

  // 3. Architectes
  const archs = db.exec(`
    SELECT id, firme, ville, telephone, email, contact, adresse, site_web
    FROM architectes
    WHERE firme LIKE '%${t}%'
       OR ville LIKE '%${t}%'
       OR email LIKE '%${t}%'
       OR contact LIKE '%${t}%'
    ORDER BY firme
  `);

  if (archs.length > 0 && archs[0].values.length > 0) {
    console.log(`=== ARCHITECTES (${archs[0].values.length}) ===\n`);
    for (const row of archs[0].values) {
      console.log(`  #${row[0]} - ${row[1]}`);
      if (row[2]) console.log(`    Ville: ${row[2]}`);
      if (row[3]) console.log(`    Tél: ${row[3]}`);
      if (row[4]) console.log(`    Email: ${row[4]}`);
      if (row[5]) console.log(`    Contact: ${row[5]}`);
      if (row[6]) console.log(`    Adresse: ${row[6]}`);
      if (row[7]) console.log(`    Web: ${row[7]}`);
      console.log('');
    }
  }

  // Résumé
  const totalDocs = docs.length > 0 ? docs[0].values.length : 0;
  const totalMats = mats.length > 0 ? mats[0].values.length : 0;
  const totalArchs = archs.length > 0 ? archs[0].values.length : 0;
  const total = totalDocs + totalMats + totalArchs;

  if (total === 0) {
    console.log('Aucun résultat trouvé.');
  } else {
    console.log(`--- Total: ${total} résultat(s) (${totalDocs} documents, ${totalMats} matériaux, ${totalArchs} architectes) ---`);
  }

  db.close();
}

const terme = process.argv[2] || '';
if (!terme) {
  console.log('Usage: node rechercher.js <terme de recherche>');
  console.log('Exemples:');
  console.log('  node rechercher.js "Soprema"');
  console.log('  node rechercher.js "membrane"');
  console.log('  node rechercher.js "NBL"');
  process.exit(1);
}
rechercher(terme).catch(console.error);
