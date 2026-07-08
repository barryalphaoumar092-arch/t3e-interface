const { createTursoClient } = require('./turso-client');

const url = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/^["']|["']$/g, '');

let db;

if (url && url.startsWith('libsql://')) {
  db = createTursoClient(url, authToken);
  console.log('Mode: Turso cloud');
} else {
  // Fallback SQLite local (dev uniquement) : le fichier vit dans data/, qui
  // doit exister avant l'ouverture de la connexion.
  const fs = require('fs');
  const path = require('path');
  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const { createClient } = require('@libsql/client');
  db = createClient({ url: url || 'file:./data/t3e.db', authToken });
  console.log('Mode: Local SQLite');
}

async function initDb() {
  const r = await db.execute('SELECT COUNT(*) as c FROM categories');
  console.log(`Base de donnees connectee (${r.rows[0].c} categories)`);

  const migrations = [
    'ALTER TABLE bordereaux ADD COLUMN devis_fichier TEXT',
    'ALTER TABLE bordereaux ADD COLUMN devis_texte TEXT',
    'ALTER TABLE bordereaux ADD COLUMN template_fichier TEXT',
    'ALTER TABLE bordereaux ADD COLUMN template_texte TEXT',
    'ALTER TABLE bordereaux ADD COLUMN template_chemin TEXT',
    'ALTER TABLE bordereaux ADD COLUMN fiches_selectionnees TEXT',
    'ALTER TABLE bordereaux ADD COLUMN template_data TEXT',
    'ALTER TABLE bordereaux ADD COLUMN session_actif INTEGER DEFAULT 0',
    `CREATE TABLE IF NOT EXISTS soumissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT UNIQUE,
      client_nom TEXT NOT NULL,
      client_adresse TEXT,
      client_ville TEXT,
      client_province TEXT DEFAULT 'QC',
      client_code_postal TEXT,
      client_contact TEXT,
      client_telephone TEXT,
      client_courriel TEXT,
      projet_nom TEXT,
      projet_adresse TEXT,
      systeme_toiture TEXT NOT NULL,
      type_travaux TEXT NOT NULL,
      langue TEXT DEFAULT 'FR',
      type_soumission TEXT DEFAULT 'prive',
      superficie_pc REAL,
      pontage TEXT,
      epaisseur_isolant TEXT,
      pente_isolant TEXT,
      nb_drains INTEGER,
      nb_manchons_events INTEGER,
      nb_manchons_etancheite INTEGER,
      nb_cols_cygne INTEGER,
      ventilateur_max TEXT,
      cout_remplacement_cp TEXT,
      cout_remplacement_isolant TEXT,
      prix_total REAL,
      garantie_t3e TEXT DEFAULT '5 ans',
      garantie_manufacturier TEXT DEFAULT '10 ans',
      exclusions_specifiques TEXT,
      documents_recus TEXT,
      notes TEXT,
      template_utilise TEXT,
      fichier_genere TEXT,
      statut TEXT DEFAULT 'brouillon' CHECK(statut IN ('brouillon','genere','revise','approuve','envoye')),
      cree_par TEXT,
      approuve_par TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS manuels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_dossier TEXT,
      titre TEXT NOT NULL,
      contenu JSON,
      statut TEXT DEFAULT 'brouillon' CHECK(statut IN ('brouillon', 'revise', 'approuve', 'session', 'genere')),
      cree_par TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_manuels_dossier ON manuels(numero_dossier)',
    `CREATE TABLE IF NOT EXISTS appels_offres_seao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_seao TEXT UNIQUE NOT NULL,
      titre TEXT NOT NULL,
      donneur_ouvrage TEXT,
      lieu_travaux TEXT,
      date_publication TEXT,
      date_fermeture TEXT,
      date_visite_obligatoire TEXT,
      type_projet TEXT,
      mots_cles_matches TEXT,
      url_seao TEXT,
      statut_interne TEXT DEFAULT 'a_analyser' CHECK(statut_interne IN ('a_analyser','interessant','a_soumissionner','refuse','depose','perdu','gagne')),
      donnees_brutes JSON,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_appels_offres_fermeture ON appels_offres_seao(date_fermeture)',
    'CREATE INDEX IF NOT EXISTS idx_appels_offres_statut ON appels_offres_seao(statut_interne)',
    `CREATE TABLE IF NOT EXISTS appels_offres_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appel_offre_id INTEGER NOT NULL,
      categorie TEXT NOT NULL,
      cle_storage TEXT,
      nom_fichier TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (appel_offre_id) REFERENCES appels_offres_seao(id)
    )`,
    `CREATE TABLE IF NOT EXISTS configuration (
      cle TEXT PRIMARY KEY,
      valeur JSON,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS appels_offres_formulaires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appel_offre_id INTEGER NOT NULL,
      cle_storage_original TEXT NOT NULL,
      cle_storage_rempli TEXT,
      format TEXT,
      champs_detectes JSON,
      champs_non_places JSON,
      statut TEXT DEFAULT 'a_remplir' CHECK(statut IN ('a_remplir','pre_rempli','valide','genere')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (appel_offre_id) REFERENCES appels_offres_seao(id)
    )`,
  ];

  const alterMigrations = [
    'ALTER TABLE soumissions ADD COLUMN type_isolant TEXT',
    'ALTER TABLE soumissions ADD COLUMN type_releves TEXT',
    'ALTER TABLE soumissions ADD COLUMN bassins TEXT',
    'ALTER TABLE soumissions ADD COLUMN sections_devis TEXT',
    'ALTER TABLE soumissions ADD COLUMN methode_adhesion TEXT',
    'ALTER TABLE soumissions ADD COLUMN type_gravier TEXT',
    'ALTER TABLE soumissions ADD COLUMN nb_plis TEXT',
    'ALTER TABLE soumissions ADD COLUMN epaisseur_fibre_bois TEXT',
    'ALTER TABLE soumissions ADD COLUMN type_fibre TEXT',
    'ALTER TABLE soumissions ADD COLUMN materiau_solins TEXT',
    'ALTER TABLE soumissions ADD COLUMN cols_cygne_type TEXT',
    // Positions x/y/page (%) placees manuellement par l'utilisateur sur le PDF
    // du formulaire SEAO (editeur visuel type "glisser-deposer"), en JSON :
    // { NEQ: {x,y,page,size}, RBQ: {...}, ... }. Absente/vide tant que
    // l'utilisateur n'a pas encore utilise l'editeur pour ce formulaire.
    'ALTER TABLE appels_offres_formulaires ADD COLUMN positions JSON',
  ];

  for (const sql of migrations) {
    try { await db.execute(sql); } catch (e) { /* table deja existante */ }
  }
  for (const sql of alterMigrations) {
    try { await db.execute(sql); } catch (e) { /* colonne deja existante */ }
  }
}

function getDb() {
  return db;
}

module.exports = { getDb, initDb, db };
