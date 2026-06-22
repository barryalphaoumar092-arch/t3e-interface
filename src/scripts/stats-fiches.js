const { getDb } = require('../db/init');

async function stats() {
  const db = await getDb();

  const totalMat = db.exec('SELECT COUNT(*) FROM materiaux');
  const avecFT = db.exec("SELECT COUNT(*) FROM materiaux WHERE lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL");
  const avecSDS = db.exec("SELECT COUNT(*) FROM materiaux WHERE lien_fiche_securite != '' AND lien_fiche_securite IS NOT NULL");
  const avecAuMoinsUn = db.exec("SELECT COUNT(*) FROM materiaux WHERE (lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL) OR (lien_fiche_securite != '' AND lien_fiche_securite IS NOT NULL)");
  const avecLesDeux = db.exec("SELECT COUNT(*) FROM materiaux WHERE (lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL) AND (lien_fiche_securite != '' AND lien_fiche_securite IS NOT NULL)");
  const sansFiche = db.exec("SELECT COUNT(*) FROM materiaux WHERE (lien_fiche_technique = '' OR lien_fiche_technique IS NULL) AND (lien_fiche_securite = '' OR lien_fiche_securite IS NULL)");
  const totalDocs = db.exec('SELECT COUNT(*) FROM documents');

  console.log('=== STATISTIQUES DES FICHES TECHNIQUES ===\n');
  console.log(`Matériaux total              : ${totalMat[0].values[0][0]}`);
  console.log(`Avec fiche technique (FT)    : ${avecFT[0].values[0][0]}`);
  console.log(`Avec fiche de sécurité (SDS) : ${avecSDS[0].values[0][0]}`);
  console.log(`Avec FT + SDS (les deux)     : ${avecLesDeux[0].values[0][0]}`);
  console.log(`Avec au moins un lien        : ${avecAuMoinsUn[0].values[0][0]}`);
  console.log(`Sans aucun lien              : ${sansFiche[0].values[0][0]}`);
  console.log(`Documents (PDF/Excel/Doc)    : ${totalDocs[0].values[0][0]}`);
  console.log(`\nTOTAL FICHES ACCESSIBLES     : ${parseInt(avecFT[0].values[0][0]) + parseInt(avecSDS[0].values[0][0])} liens`);

  // Par fabricant
  console.log('\n--- Fiches techniques par fabricant ---');
  const parFab = db.exec(`
    SELECT fabricant, COUNT(*) as total,
      SUM(CASE WHEN lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL THEN 1 ELSE 0 END) as ft,
      SUM(CASE WHEN lien_fiche_securite != '' AND lien_fiche_securite IS NOT NULL THEN 1 ELSE 0 END) as sds
    FROM materiaux
    WHERE fabricant != ''
    GROUP BY fabricant
    ORDER BY total DESC
  `);
  if (parFab.length > 0) {
    for (const row of parFab[0].values) {
      console.log(`  ${row[0]}: ${row[1]} produits | ${row[2]} FT | ${row[3]} SDS`);
    }
  }

  db.close();
}

stats().catch(console.error);
