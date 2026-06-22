const path = require('path');
const fs = require('fs');
const { initDb, saveDb } = require('../db/init');

const SOURCE_DIR = path.join('C:', 'Users', 'Projets', 'Desktop', 'Doc Claude1');
const DOCS_DIR = path.join(__dirname, '..', '..', 'documents');

const CATEGORIES = [
  { nom: 'Bulletins techniques AMCQ', description: 'Bulletins techniques publiés par l\'Association des Maîtres Couvreurs du Québec' },
  { nom: 'Devis AMCQ', description: 'Devis types et divisions de l\'AMCQ pour les travaux de couverture' },
  { nom: 'Manuels et guides', description: 'Manuels d\'entretien, guides techniques et manuels de référence' },
  { nom: 'Codes et règlements', description: 'Codes du bâtiment du Québec et du Canada, règlements de construction' },
  { nom: 'Manuel technique AERMQ', description: 'Manuel technique de l\'Association des Entrepreneurs en Revêtement Métallique du Québec' },
  { nom: 'Devis types', description: 'Devis types et spécifications techniques standardisées' },
  { nom: 'Listes et références', description: 'Listes d\'architectes, de matériaux, contacts et références' },
  { nom: 'Bordereaux et formulaires', description: 'Formulaires de transmission, bordereaux techniques et fiches' },
  { nom: 'Tarifs et prix', description: 'Grilles tarifaires, listes de prix fournisseurs (Soprema, etc.)' },
];

const DOCUMENTS = [
  // --- Bulletins techniques AMCQ ---
  {
    titre: 'Bulletin 01 - La normalisation au Canada',
    nom_fichier: 'bulletin_01-la-normalisation-au-canada.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Normalisation et normes applicables au Canada pour les travaux de couverture',
    mots_cles: 'normalisation, normes, Canada, couverture',
  },
  {
    titre: 'Bulletin 02 - Isolants de couverture',
    nom_fichier: 'bulletin_02-isolants-de-couverture.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Guide sur les isolants utilisés en couverture de toiture',
    mots_cles: 'isolants, couverture, toiture, thermique',
  },
  {
    titre: 'Bulletin 03 - Parapets ventilés',
    nom_fichier: 'bulletin_03-parapets-ventiles.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Conception et installation des parapets ventilés',
    mots_cles: 'parapets, ventilation, conception',
  },
  {
    titre: 'Bulletin 04 - Guide pour la réfection des couvertures',
    nom_fichier: 'bulletin-4-guide-pour-la-rfection-des-couvertures-rv-2023-05-29.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    annee: '2023',
    description: 'Guide complet pour la réfection des couvertures - révisé mai 2023',
    mots_cles: 'réfection, couverture, guide, rénovation',
  },
  {
    titre: 'Bulletin 05 - Ventilation des vides sous toits',
    nom_fichier: 'bulletin_05-ventilation-vides-sous-toits-v.-2023-11-21.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    annee: '2023',
    description: 'Ventilation des vides sous toits - révisé novembre 2023',
    mots_cles: 'ventilation, vides sous toits, entretoit',
  },
  {
    titre: 'Bulletin 06 - Inspection des travaux de couvertures',
    nom_fichier: 'bulletin_06-inspection-des-travaux-de-couvertures.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Procédures d\'inspection des travaux de couverture',
    mots_cles: 'inspection, travaux, couverture, contrôle qualité',
  },
  {
    titre: 'Bulletin 07 - Attaches mécaniques',
    nom_fichier: 'bulletin_07-attaches-mecaniques.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Guide sur les attaches mécaniques pour toitures',
    mots_cles: 'attaches, mécaniques, fixation, toiture',
  },
  {
    titre: 'Bulletin 08 - Membrane de bitume modifié au SBS',
    nom_fichier: 'bulletin_08-membrane-de-bitume-modifie-au-sbs.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Spécifications et installation des membranes de bitume modifié au SBS',
    mots_cles: 'membrane, bitume, SBS, étanchéité',
  },
  {
    titre: 'Bulletin 09 - Adhésifs pour toitures',
    nom_fichier: 'Bulletin-9-Adhesifs-pour-toitures.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Guide sur les adhésifs utilisés pour les travaux de toiture',
    mots_cles: 'adhésifs, collage, toiture, pose',
  },
  {
    titre: 'Bulletin 10 - Matériaux composites',
    nom_fichier: 'bulletin_10-materiaux-composites.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Matériaux composites utilisés en couverture',
    mots_cles: 'matériaux, composites, couverture',
  },
  {
    titre: 'Bulletin 11 - Toits végétalisés',
    nom_fichier: 'Bulletin-11-Toits-vegetalises.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Conception et installation des toits végétalisés (toits verts)',
    mots_cles: 'toits verts, végétalisation, écologique',
  },
  {
    titre: 'Bulletin 13 - Bulletin technique',
    nom_fichier: 'bulletin-technique-13-2025-01-08.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Bulletin technique numéro 13 - janvier 2025',
    mots_cles: 'bulletin technique, AMCQ',
  },
  {
    titre: 'Bulletin 14 - Final',
    nom_fichier: 'Bulletin-14-final.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Bulletin technique numéro 14',
    mots_cles: 'bulletin technique, AMCQ',
  },
  {
    titre: 'Bulletin 15 - Trop-pleins et dalots d\'urgence',
    nom_fichier: 'Bulletin-15-Trop-pleins-et-dalots-durgence-1.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Conception et installation des trop-pleins et dalots d\'urgence',
    mots_cles: 'trop-pleins, dalots, urgence, drainage',
  },
  {
    titre: 'Bulletin 16 - Efficacité énergétique',
    nom_fichier: 'Bulletin_16_efficacite_energetique_final-1.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    description: 'Efficacité énergétique des systèmes de couverture',
    mots_cles: 'efficacité énergétique, isolation, performance',
  },
  {
    titre: 'Bulletin 17 - Gestion des eaux',
    nom_fichier: 'Bulletin_17_2021_10_27_Gestion_eaux-1.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    annee: '2021',
    description: 'Gestion des eaux pluviales en toiture - octobre 2021',
    mots_cles: 'gestion eaux, pluviales, drainage, toiture',
  },
  {
    titre: 'Bulletin 18 - Couvertures, entretien, réfection et code de construction',
    nom_fichier: '2024-09-19-bulletin-18-couvertures-entretien-refection-et-code-de-construction_v3.pdf',
    categorie: 'Bulletins techniques AMCQ',
    source: 'AMCQ',
    annee: '2024',
    description: 'Couvertures, entretien, réfection et conformité au code de construction - v3 sept 2024',
    mots_cles: 'entretien, réfection, code construction, conformité',
  },

  // --- Devis AMCQ ---
  {
    titre: 'AMCQ - Introduction 2025',
    nom_fichier: 'amcq_intro_2025_protege.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Introduction aux devis types AMCQ - édition 2025',
    mots_cles: 'devis, AMCQ, introduction, 2025',
  },
  {
    titre: 'AMCQ - Division 1 (novembre 2026)',
    nom_fichier: 'amcq_division1-nov2026.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2026',
    description: 'Devis type AMCQ Division 1 - Exigences générales - novembre 2026',
    mots_cles: 'devis, division 1, exigences générales',
  },
  {
    titre: 'AMCQ - Division 2 (2025)',
    nom_fichier: 'amcq_division-2_2025.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Devis type AMCQ Division 2 - 2025',
    mots_cles: 'devis, division 2, AMCQ',
  },
  {
    titre: 'AMCQ - Division 3 (2025)',
    nom_fichier: 'amcq_division-3_2025.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Devis type AMCQ Division 3 - 2025',
    mots_cles: 'devis, division 3, AMCQ',
  },
  {
    titre: 'AMCQ - Division 4 (2025)',
    nom_fichier: 'amcq_division-4_2025.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Devis type AMCQ Division 4 - 2025',
    mots_cles: 'devis, division 4, AMCQ',
  },
  {
    titre: 'AMCQ - Division 5A (2025)',
    nom_fichier: 'amcq_division-5a_2025_protege.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Devis type AMCQ Division 5A - 2025',
    mots_cles: 'devis, division 5A, AMCQ',
  },
  {
    titre: 'AMCQ - Division 5B (2025)',
    nom_fichier: 'amcq_division-5b_2025_protege.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Devis type AMCQ Division 5B - 2025',
    mots_cles: 'devis, division 5B, AMCQ',
  },
  {
    titre: 'AMCQ - Division 6 (2025)',
    nom_fichier: 'amcq_division-6_2025_protege.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Devis type AMCQ Division 6 - 2025',
    mots_cles: 'devis, division 6, AMCQ',
  },
  {
    titre: 'AMCQ - Division 8 (2025)',
    nom_fichier: 'amcq_division-8_2025_protege.pdf',
    categorie: 'Devis AMCQ',
    source: 'AMCQ',
    annee: '2025',
    description: 'Devis type AMCQ Division 8 - 2025',
    mots_cles: 'devis, division 8, AMCQ',
  },

  // --- Manuels et guides ---
  {
    titre: 'AMCQ - Manuel d\'entretien (2019)',
    nom_fichier: '2019-AMCQ-Manuel-dentretien.pdf',
    categorie: 'Manuels et guides',
    source: 'AMCQ',
    annee: '2019',
    description: 'Manuel d\'entretien des toitures publié par l\'AMCQ',
    mots_cles: 'entretien, maintenance, toiture, manuel',
  },

  // --- Codes et règlements ---
  {
    titre: 'Règlement de construction B-1.1, R.2',
    nom_fichier: 'B-1.1, R. 2.pdf',
    categorie: 'Codes et règlements',
    source: 'Gouvernement du Québec',
    description: 'Code de construction du Québec - Chapitre I, Bâtiment, et Code national du bâtiment',
    mots_cles: 'code construction, règlement, Québec, bâtiment, B-1.1',
  },
  {
    titre: 'Code national du bâtiment NR24-28-2020',
    nom_fichier: 'NR24-28-2020-fra.pdf',
    categorie: 'Codes et règlements',
    source: 'Conseil national de recherches Canada (CNRC)',
    annee: '2020',
    description: 'Code national du bâtiment du Canada 2020 - version française',
    mots_cles: 'code national, bâtiment, CNRC, Canada, 2020',
  },

  // --- Manuel technique AERMQ ---
  {
    titre: 'AERMQ - Manuel technique 2024',
    nom_fichier: 'AERMQ-MANUEL-TECHNIQUE-2024-V.25.06.30.pdf',
    categorie: 'Manuel technique AERMQ',
    source: 'AERMQ',
    annee: '2024',
    version: 'V.25.06.30',
    description: 'Manuel technique de l\'Association des Entrepreneurs en Revêtement Métallique du Québec - murs et revêtements',
    mots_cles: 'AERMQ, revêtement métallique, murs, manuel technique',
  },

  // --- Devis types ---
  {
    titre: 'Division VII - Devis type',
    nom_fichier: 'DIVISION_VII.pdf',
    categorie: 'Devis types',
    source: 'ACEC / Industrie',
    description: 'Devis type Division VII - spécifications techniques pour travaux de couverture',
    mots_cles: 'devis, division VII, spécifications, couverture',
  },

  // --- Listes et références ---
  {
    titre: 'Liste des architectes',
    nom_fichier: 'Liste ARCHITECTES.xlsx',
    categorie: 'Listes et références',
    source: 'T3E',
    description: 'Liste des architectes partenaires et contacts',
    mots_cles: 'architectes, contacts, partenaires',
  },
  {
    titre: 'Liste des matériaux avec fiches SDS',
    nom_fichier: 'Liste des matériaux avec sds.xlsx',
    categorie: 'Listes et références',
    source: 'T3E',
    description: 'Liste complète des matériaux utilisés avec liens vers les fiches de données de sécurité (SDS)',
    mots_cles: 'matériaux, SDS, fiches sécurité, produits',
  },

  // --- Bordereaux et formulaires ---
  {
    titre: 'Bordereau de transmission de fiche technique',
    nom_fichier: 'Bordereau de transmission de fiche technique.doc',
    categorie: 'Bordereaux et formulaires',
    source: 'T3E',
    description: 'Formulaire de bordereau pour la transmission des fiches techniques',
    mots_cles: 'bordereau, transmission, fiche technique, formulaire',
  },

  // --- Tarifs et prix ---
  {
    titre: 'Tarifs Couvreurs Québec 2026',
    nom_fichier: '2026-04-20_QC_COUVREURS_v20260420 (1)(1).pdf',
    categorie: 'Tarifs et prix',
    source: 'Soprema / CCQ',
    annee: '2026',
    description: 'Grille tarifaire des couvreurs du Québec - avril 2026',
    mots_cles: 'tarifs, prix, couvreurs, Québec, CCQ, Soprema',
  },
];

async function importDocuments() {
  console.log('=== Importation des documents Doc Claude1 ===\n');

  const db = await initDb();

  // Inserer les categories
  console.log('1. Insertion des catégories...');
  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (nom, description) VALUES (?, ?)');
  for (const cat of CATEGORIES) {
    insertCat.run([cat.nom, cat.description]);
  }
  insertCat.free();
  console.log(`   ${CATEGORIES.length} catégories insérées.\n`);

  // Recuperer les IDs des categories
  const catMap = {};
  const rows = db.exec('SELECT id, nom FROM categories');
  if (rows.length > 0) {
    for (const row of rows[0].values) {
      catMap[row[1]] = row[0];
    }
  }

  // Copier les fichiers et inserer dans la base
  console.log('2. Importation des documents...');
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

  const insertDoc = db.prepare(`
    INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, annee, version, mots_cles)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let errors = 0;

  for (const doc of DOCUMENTS) {
    const srcPath = path.join(SOURCE_DIR, doc.nom_fichier);
    const ext = path.extname(doc.nom_fichier).toLowerCase();

    if (!fs.existsSync(srcPath)) {
      console.log(`   [ERREUR] Fichier non trouvé: ${doc.nom_fichier}`);
      errors++;
      continue;
    }

    const stats = fs.statSync(srcPath);

    // Copier dans le dossier documents du projet
    const destPath = path.join(DOCS_DIR, doc.nom_fichier);
    fs.copyFileSync(srcPath, destPath);

    const catId = catMap[doc.categorie];
    if (!catId) {
      console.log(`   [ERREUR] Catégorie non trouvée: ${doc.categorie}`);
      errors++;
      continue;
    }

    insertDoc.run([
      doc.titre,
      doc.nom_fichier,
      destPath,
      catId,
      ext.replace('.', ''),
      stats.size,
      doc.description || null,
      doc.source || null,
      doc.annee || null,
      doc.version || null,
      doc.mots_cles || null,
    ]);

    imported++;
    console.log(`   [OK] ${doc.titre}`);
  }
  insertDoc.free();

  // Sauvegarder la base
  saveDb(db);

  console.log(`\n=== Résultat ===`);
  console.log(`Documents importés: ${imported}/${DOCUMENTS.length}`);
  if (errors > 0) console.log(`Erreurs: ${errors}`);

  // Afficher un résumé par catégorie
  console.log('\n=== Résumé par catégorie ===');
  const summary = db.exec(`
    SELECT c.nom, COUNT(d.id) as nb
    FROM categories c
    LEFT JOIN documents d ON d.categorie_id = c.id
    GROUP BY c.id
    ORDER BY nb DESC
  `);
  if (summary.length > 0) {
    for (const row of summary[0].values) {
      console.log(`   ${row[0]}: ${row[1]} document(s)`);
    }
  }

  const total = db.exec('SELECT COUNT(*) FROM documents');
  console.log(`\nTotal: ${total[0].values[0][0]} documents dans la base de données.`);
  console.log(`Base de données sauvegardée: ${path.resolve(path.join(__dirname, '..', '..', 'data', 't3e.db'))}`);

  db.close();
}

importDocuments().catch(console.error);
