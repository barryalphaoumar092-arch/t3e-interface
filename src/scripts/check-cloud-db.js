const { createTursoClient } = require('../db/turso-client');

const db = createTursoClient(
  process.env.TURSO_DATABASE_URL,
  process.env.TURSO_AUTH_TOKEN
);

(async () => {
  console.log('=== DOCUMENTS ===');
  const docs = await db.execute('SELECT id, titre, nom_fichier FROM documents ORDER BY id');
  docs.rows.forEach(d => console.log(`  ${d.id}. ${d.titre} [${d.nom_fichier}]`));

  console.log('\n=== MATERIAUX AVEC FICHE TECHNIQUE ===');
  const ft = await db.execute("SELECT COUNT(*) as c FROM materiaux WHERE lien_fiche_technique IS NOT NULL AND lien_fiche_technique != ''");
  console.log(`  ${ft.rows[0].c} materiaux ont une fiche technique`);

  const samples = await db.execute("SELECT nom, fabricant, lien_fiche_technique FROM materiaux WHERE lien_fiche_technique IS NOT NULL AND lien_fiche_technique != '' LIMIT 10");
  samples.rows.forEach(m => console.log(`  - ${m.nom} (${m.fabricant}) => ${m.lien_fiche_technique}`));

  console.log('\n=== RECHERCHE LEED ===');
  const leed = await db.execute("SELECT nom, fabricant, type_produit, lien_fiche_technique FROM materiaux WHERE nom LIKE '%LEED%' OR type_produit LIKE '%LEED%' OR lien_fiche_technique LIKE '%LEED%'");
  console.log(`  ${leed.rows.length} resultats LEED`);
  leed.rows.forEach(m => console.log(`  - ${m.nom} (${m.fabricant}) [${m.type_produit}]`));

  console.log('\n=== CATEGORIES ===');
  const cats = await db.execute('SELECT nom FROM categories ORDER BY nom');
  cats.rows.forEach(c => console.log(`  - ${c.nom}`));

  console.log('\n=== COLONNES TABLE MATERIAUX ===');
  const info = await db.execute("PRAGMA table_info(materiaux)");
  info.rows.forEach(c => console.log(`  ${c.name} (${c.type})`));
})();
