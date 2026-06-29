const { createTursoClient } = require('./turso-client');

const url = (process.env.TURSO_DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim().replace(/^["']|["']$/g, '');

let db;

if (url && url.startsWith('libsql://')) {
  db = createTursoClient(url, authToken);
  console.log('Mode: Turso cloud');
} else {
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
  ];

  const alterMigrations = [
    'ALTER TABLE soumissions ADD COLUMN type_isolant TEXT',
    'ALTER TABLE soumissions ADD COLUMN type_releves TEXT',
    'ALTER TABLE soumissions ADD COLUMN bassins TEXT',
    'ALTER TABLE soumissions ADD COLUMN sections_devis TEXT',
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
