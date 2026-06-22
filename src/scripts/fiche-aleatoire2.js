const { getDb } = require('../db/init');

async function main() {
  const db = await getDb();
  const r = db.exec(`
    SELECT id, nom, fabricant, type_produit, type_systeme, dimension, lien_fiche_technique
    FROM materiaux
    WHERE lien_fiche_technique LIKE 'https%'
    ORDER BY RANDOM() LIMIT 1
  `);
  const row = r[0].values[0];
  console.log(`Produit: ${row[1]}`);
  console.log(`Fabricant: ${row[2]}`);
  console.log(`Type: ${row[3]} - ${row[4]}`);
  console.log(`Dimension: ${row[5]}`);
  console.log(`URL: ${row[6]}`);
  db.close();
}

main().catch(console.error);
