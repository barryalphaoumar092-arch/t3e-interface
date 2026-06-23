const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/init');

async function run() {
  const db = getDb();

  // Créer les catégories manquantes
  const newCats = [
    'Templates de soumission',
    'Exclusions soumission',
    'Manuel unités exécution (MUE)',
  ];
  for (const nom of newCats) {
    try {
      await db.execute({ sql: 'INSERT INTO categories (nom) VALUES (?)', args: [nom] });
      console.log(`+ Catégorie: ${nom}`);
    } catch (e) { /* existe déjà */ }
  }

  // Récupérer les IDs de catégories
  const cats = (await db.execute('SELECT id, nom FROM categories')).rows;
  const catId = (nom) => {
    const c = cats.find(c => c.nom === nom);
    return c ? c.id : cats[0].id;
  };

  const baseDir = path.join(__dirname, '../../documents');

  // --- Templates de soumission ---
  const templatesDir = path.join(baseDir, 'templates-soumission');
  const templateFiles = fs.readdirSync(templatesDir).filter(f => f.endsWith('.docx'));
  for (const file of templateFiles) {
    const filePath = path.join(templatesDir, file);
    const stat = fs.statSync(filePath);
    const titre = file.replace('.docx', '');
    const lang = file.includes('(FR)') ? 'FR' : file.includes('(EN)') ? 'EN' : '';
    const motsCles = `template,soumission,${lang},toiture`.toLowerCase();

    try {
      await db.execute({
        sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, mots_cles)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [titre, file, filePath, catId('Templates de soumission'), 'docx', stat.size,
               `Template de soumission ${lang} - ${titre}`, 'Serveur T3E', motsCles]
      });
      console.log(`+ Template: ${file}`);
    } catch (e) {
      console.log(`  (existant) ${file}`);
    }
  }

  // --- Exclusions ---
  const exclDir = path.join(templatesDir, 'exclusions');
  if (fs.existsSync(exclDir)) {
    const exclFiles = fs.readdirSync(exclDir).filter(f => f.endsWith('.pdf'));
    for (const file of exclFiles) {
      const filePath = path.join(exclDir, file);
      const stat = fs.statSync(filePath);
      const titre = file.replace('.pdf', '');
      const motsCles = 'exclusion,soumission,conditions';

      try {
        await db.execute({
          sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, mots_cles)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [titre, file, filePath, catId('Exclusions soumission'), 'pdf', stat.size,
                 `Liste d'exclusions - ${titre}`, 'Serveur T3E', motsCles]
        });
        console.log(`+ Exclusion: ${file}`);
      } catch (e) {
        console.log(`  (existant) ${file}`);
      }
    }
  }

  // --- MUE ---
  const muePath = path.join(baseDir, 'MUE-4.2.xlsx');
  if (fs.existsSync(muePath)) {
    const stat = fs.statSync(muePath);
    try {
      await db.execute({
        sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, mots_cles)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ['MUE 4.2 - Manuel unités exécution', 'MUE-4.2.xlsx', muePath,
               catId('Manuel unités exécution (MUE)'), 'xlsx', stat.size,
               'Manuel d\'unités d\'exécution utilisé pour les estimations', 'T3E', 'mue,estimation,unités,exécution']
      });
      console.log('+ MUE 4.2');
    } catch (e) { console.log('  (existant) MUE'); }
  }

  // --- QC Couvreurs ---
  const qcPath = path.join(baseDir, 'QC_COUVREURS_2026.pdf');
  if (fs.existsSync(qcPath)) {
    const stat = fs.statSync(qcPath);
    try {
      await db.execute({
        sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, annee, mots_cles)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: ['Liste de prix QC Couvreurs 2026', 'QC_COUVREURS_2026.pdf', qcPath,
               catId('Tarifs et prix'), 'pdf', stat.size,
               'Liste de prix Soprema / Couvreurs du Québec 2026', 'Couvreurs du Québec', '2026',
               'prix,soprema,couvreurs,matériaux,2026']
      });
      console.log('+ QC Couvreurs 2026');
    } catch (e) { console.log('  (existant) QC Couvreurs'); }
  }

  // --- Fiches techniques déjà dans documents/FT ---
  const ftDir = path.join(baseDir, 'FT');
  if (fs.existsSync(ftDir)) {
    const ftFolders = fs.readdirSync(ftDir, { withFileTypes: true }).filter(d => d.isDirectory());
    let ftCount = 0;
    for (const folder of ftFolders) {
      const folderPath = path.join(ftDir, folder.name);
      const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.pdf') || f.endsWith('.docx'));
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        const stat = fs.statSync(filePath);
        const ext = path.extname(file).toLowerCase().replace('.', '');
        const titre = file.replace(/\.[^.]+$/, '');

        try {
          await db.execute({
            sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, mots_cles)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [titre, file, filePath, catId('Listes et références'), ext, stat.size,
                   `Fiche technique - ${folder.name} - ${titre}`, folder.name,
                   `fiche technique,${folder.name.toLowerCase()},ft`]
          });
          ftCount++;
        } catch (e) { /* existe déjà */ }
      }
    }
    if (ftCount > 0) console.log(`+ ${ftCount} fiches techniques (FT)`);
  }

  // --- Bulletins déjà dans documents/ ---
  const bulletins = fs.readdirSync(baseDir).filter(f => f.startsWith('bulletin') || f.startsWith('Bulletin'));
  let bulCount = 0;
  for (const file of bulletins) {
    const filePath = path.join(baseDir, file);
    const stat = fs.statSync(filePath);
    const ext = path.extname(file).toLowerCase().replace('.', '');
    const titre = file.replace(/\.[^.]+$/, '').replace(/-/g, ' ').replace(/_/g, ' ');

    try {
      await db.execute({
        sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, mots_cles)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [titre, file, filePath, catId('Bulletins techniques AMCQ'), ext, stat.size,
               `Bulletin technique AMCQ - ${titre}`, 'AMCQ', 'bulletin,amcq,technique']
      });
      bulCount++;
    } catch (e) { /* existe déjà */ }
  }
  if (bulCount > 0) console.log(`+ ${bulCount} bulletins techniques`);

  // Résumé
  const total = (await db.execute('SELECT COUNT(*) as c FROM documents')).rows[0].c;
  console.log(`\nTotal documents en base: ${total}`);
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
