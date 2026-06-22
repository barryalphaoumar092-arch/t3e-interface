const { getDb } = require('../db/init');

async function ficheAleatoire() {
  const db = await getDb();

  const result = db.exec(`
    SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, unite, lien_fiche_technique, lien_fiche_securite
    FROM materiaux
    WHERE lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL
  `);

  if (!result.length || !result[0].values.length) {
    console.log('Aucune fiche technique trouvée.');
    db.close();
    return;
  }

  const all = result[0].values;
  const idx = Math.floor(Math.random() * all.length);
  const row = all[idx];

  console.log(JSON.stringify({
    id: row[0],
    nom: row[1],
    fabricant: row[2],
    type_produit: row[3],
    type_systeme: row[4],
    fournisseur: row[5],
    dimension: row[6],
    unite: row[7],
    lien_fiche_technique: row[8],
    lien_fiche_securite: row[9],
  }));

  db.close();
}

ficheAleatoire().catch(console.error);
