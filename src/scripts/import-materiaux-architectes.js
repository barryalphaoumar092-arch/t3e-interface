const XLSX = require('xlsx');
const path = require('path');
const { getDb, saveDb } = require('../db/init');

const DOC_DIR = path.join('C:', 'Users', 'Projets', 'Desktop', 'Doc Claude1');

async function importAll() {
  const db = await getDb();

  // Ajouter les tables manquantes pour les architectes et les fiches techniques
  db.run(`
    CREATE TABLE IF NOT EXISTS architectes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      firme TEXT NOT NULL,
      ville TEXT,
      adresse TEXT,
      telephone TEXT,
      email TEXT,
      contact TEXT,
      site_web TEXT,
      source TEXT DEFAULT 'Liste ARCHITECTES.xlsx',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_architectes_firme ON architectes(firme);
    CREATE INDEX IF NOT EXISTS idx_architectes_ville ON architectes(ville);
  `);

  // Modifier la table materiaux pour ajouter les colonnes nécessaires
  try { db.run('ALTER TABLE materiaux ADD COLUMN type_produit TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE materiaux ADD COLUMN type_systeme TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE materiaux ADD COLUMN fournisseur TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE materiaux ADD COLUMN dimension TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE materiaux ADD COLUMN unite TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE materiaux ADD COLUMN superficie_couvrante TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE materiaux ADD COLUMN lien_fiche_technique TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE materiaux ADD COLUMN lien_fiche_securite TEXT'); } catch(e) {}

  // ===== IMPORT MATÉRIAUX =====
  console.log('=== IMPORTATION DES MATÉRIAUX ===\n');

  const matFilePath = path.join(DOC_DIR, 'Liste des matériaux avec sds.xlsx');
  const matWb = XLSX.readFile(matFilePath);
  const matWs = matWb.Sheets['Feuil1'];
  const matData = XLSX.utils.sheet_to_json(matWs, { header: 1, defval: '' });

  // Collecter tous les hyperliens indexés par cellule
  const hyperlinks = {};
  for (const cellRef in matWs) {
    if (cellRef[0] === '!') continue;
    const cell = matWs[cellRef];
    if (cell.l && cell.l.Target) {
      hyperlinks[cellRef] = cell.l.Target;
    }
  }

  const insertMat = db.prepare(`
    INSERT INTO materiaux (nom, fabricant, categorie, type_produit, type_systeme, fournisseur, dimension, unite, superficie_couvrante, lien_fiche_technique, lien_fiche_securite, numero_produit, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let matCount = 0;
  let avecFiche = 0;
  let avecSds = 0;
  const fabricants = new Set();
  const typesProds = new Set();

  // Les données commencent à la ligne 9 (index 8 = en-tête, 9+ = données)
  for (let i = 9; i < matData.length; i++) {
    const row = matData[i];
    const typeProduit = (row[0] || '').toString().trim();
    const typeSysteme = (row[1] || '').toString().trim();
    const fabricant = (row[2] || '').toString().trim();
    const fournisseur = (row[3] || '').toString().trim();
    const nomProduit = (row[4] || '').toString().trim();
    const dimension = (row[5] || '').toString().trim();
    const unite = (row[6] || '').toString().trim();
    const superficie = (row[7] || '').toString().trim();

    // Ignorer les lignes vides ou sans nom de produit
    if (!nomProduit) continue;

    // Récupérer les hyperliens pour cette ligne
    // Excel row = i + 2 (offset de 2 car A2 est la première cellule du range)
    const excelRow = i + 2;
    const lienFT = hyperlinks[`I${excelRow}`] || '';
    const lienSDS = hyperlinks[`J${excelRow}`] || '';

    if (lienFT) avecFiche++;
    if (lienSDS) avecSds++;
    if (fabricant) fabricants.add(fabricant);
    if (typeProduit) typesProds.add(typeProduit);

    insertMat.run([
      nomProduit,
      fabricant,
      typeProduit,
      typeProduit,
      typeSysteme,
      fournisseur,
      dimension,
      unite,
      superficie,
      lienFT,
      lienSDS,
      '',
      `${typeProduit} - ${typeSysteme} - ${fabricant}`
    ]);
    matCount++;
  }
  insertMat.free();

  console.log(`Matériaux importés: ${matCount}`);
  console.log(`Avec fiche technique: ${avecFiche}`);
  console.log(`Avec fiche SDS: ${avecSds}`);
  console.log(`Fabricants: ${fabricants.size}`);
  console.log(`Types de produits: ${typesProds.size}`);

  console.log('\n--- Fabricants ---');
  for (const f of [...fabricants].sort()) {
    const res = db.exec(`SELECT COUNT(*) FROM materiaux WHERE fabricant = '${f.replace(/'/g, "''")}'`);
    console.log(`  ${f}: ${res[0].values[0][0]} produit(s)`);
  }

  console.log('\n--- Types de produits ---');
  for (const t of [...typesProds].sort()) {
    const res = db.exec(`SELECT COUNT(*) FROM materiaux WHERE type_produit = '${t.replace(/'/g, "''")}'`);
    console.log(`  ${t}: ${res[0].values[0][0]} produit(s)`);
  }

  // ===== IMPORT ARCHITECTES =====
  console.log('\n\n=== IMPORTATION DES ARCHITECTES ===\n');

  const archFilePath = path.join(DOC_DIR, 'Liste ARCHITECTES.xlsx');
  const archWb = XLSX.readFile(archFilePath);

  // Feuille 1: Contact
  console.log('--- Feuille "Contact" ---');
  const contactWs = archWb.Sheets['Contact'];
  const contactData = XLSX.utils.sheet_to_json(contactWs, { header: 1, defval: '' });

  const insertArch = db.prepare(`
    INSERT INTO architectes (firme, telephone, email, contact, adresse, ville, site_web, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let archCount = 0;

  // Feuille Contact: en-tête en ligne 0, données à partir de ligne 1
  for (let i = 1; i < contactData.length; i++) {
    const row = contactData[i];
    const firme = (row[0] || '').toString().trim();
    const telephone = (row[1] || '').toString().trim();
    const email = (row[2] || '').toString().trim();
    const contact = (row[3] || '').toString().trim();
    const adresse = (row[4] || '').toString().trim();

    if (!firme) continue;

    // Collecter les hyperliens email pour cette ligne
    const excelRow = i + 1;
    let emailLink = '';
    const cellRef = `C${excelRow}`;
    if (contactWs[cellRef] && contactWs[cellRef].l) {
      emailLink = contactWs[cellRef].l.Target || '';
      if (emailLink.startsWith('mailto:')) emailLink = emailLink.substring(7);
    }
    const finalEmail = email || emailLink;

    insertArch.run([firme, telephone, finalEmail, contact, adresse, '', '', 'Contact']);
    archCount++;
  }
  console.log(`  ${archCount} contacts importés.`);

  // Feuille 2: Repertoire Architecte QC
  console.log('\n--- Feuille "Repertoire Architecte QC" ---');
  const repWs = archWb.Sheets['Repertoire Architecte QC'];
  const repData = XLSX.utils.sheet_to_json(repWs, { header: 1, defval: '' });

  let repCount = 0;
  for (let i = 1; i < repData.length; i++) {
    const row = repData[i];
    const cabinet = (row[0] || '').toString().trim();
    const ville = (row[1] || '').toString().trim();
    const adresse = (row[2] || '').toString().trim();
    const telephone = (row[3] || '').toString().trim();
    const email = (row[4] || '').toString().trim();
    const siteWeb = (row[5] || '').toString().trim();

    if (!cabinet) continue;

    insertArch.run([cabinet, telephone, email, '', adresse, ville, siteWeb, 'Repertoire QC']);
    repCount++;
  }
  insertArch.free();
  console.log(`  ${repCount} cabinets importés.`);

  // Sauvegarder
  saveDb(db);

  // Résumé final
  console.log('\n\n=== RÉSUMÉ FINAL ===');
  const totalMat = db.exec('SELECT COUNT(*) FROM materiaux');
  const totalArch = db.exec('SELECT COUNT(*) FROM architectes');
  const totalFT = db.exec("SELECT COUNT(*) FROM materiaux WHERE lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL");
  const totalSDS = db.exec("SELECT COUNT(*) FROM materiaux WHERE lien_fiche_securite != '' AND lien_fiche_securite IS NOT NULL");

  console.log(`Total matériaux dans la BD    : ${totalMat[0].values[0][0]}`);
  console.log(`  → avec fiche technique      : ${totalFT[0].values[0][0]}`);
  console.log(`  → avec fiche de sécurité SDS: ${totalSDS[0].values[0][0]}`);
  console.log(`Total architectes dans la BD  : ${totalArch[0].values[0][0]}`);

  // Exemples de matériaux avec liens
  console.log('\n--- 10 premiers matériaux avec fiches techniques ---');
  const exemples = db.exec(`
    SELECT nom, fabricant, type_systeme, lien_fiche_technique, lien_fiche_securite
    FROM materiaux
    WHERE lien_fiche_technique != '' AND lien_fiche_technique IS NOT NULL
    LIMIT 10
  `);
  if (exemples.length > 0) {
    for (const row of exemples[0].values) {
      console.log(`  ${row[0]} (${row[1]} - ${row[2]})`);
      console.log(`    FT:  ${row[3]}`);
      if (row[4]) console.log(`    SDS: ${row[4]}`);
    }
  }

  db.close();
  console.log('\nImportation terminée avec succès!');
}

importAll().catch(console.error);
