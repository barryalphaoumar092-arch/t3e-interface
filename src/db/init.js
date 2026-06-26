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

async function runNamedMigration(name, fn) {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
    const r = await db.execute({ sql: 'SELECT name FROM _migrations WHERE name = ?', args: [name] });
    if (r.rows.length > 0) return;
    await fn();
    await db.execute({ sql: 'INSERT OR IGNORE INTO _migrations (name) VALUES (?)', args: [name] });
    console.log('Migration appliquée:', name);
  } catch (e) {
    console.error('Erreur migration', name, e.message);
  }
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
  for (const sql of migrations) {
    try { await db.execute(sql); } catch (e) { /* colonne deja existante */ }
  }

  // Recréer bordereaux avec le bon CHECK (session + genere autorisés)
  await runNamedMigration('fix-bordereaux-statut-v2', async () => {
    await db.execute(`DROP TABLE IF EXISTS bordereaux_v2`);
    await db.execute(`CREATE TABLE bordereaux_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_projet TEXT,
      titre TEXT NOT NULL,
      contenu JSON,
      document_source_id INTEGER,
      statut TEXT DEFAULT 'brouillon' CHECK(statut IN ('brouillon','revise','approuve','session','genere')),
      cree_par TEXT,
      modifie_par TEXT,
      approuve_par TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      devis_fichier TEXT,
      devis_texte TEXT,
      template_fichier TEXT,
      template_texte TEXT,
      template_chemin TEXT,
      fiches_selectionnees TEXT,
      template_data TEXT,
      FOREIGN KEY (document_source_id) REFERENCES documents(id)
    )`);
    await db.execute(`INSERT INTO bordereaux_v2
      SELECT id, numero_projet, titre, contenu, document_source_id, statut,
             cree_par, modifie_par, approuve_par, created_at, updated_at,
             devis_fichier, devis_texte, template_fichier, template_texte,
             template_chemin, fiches_selectionnees, template_data
      FROM bordereaux`);
    await db.execute(`DROP TABLE bordereaux`);
    await db.execute(`ALTER TABLE bordereaux_v2 RENAME TO bordereaux`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_bordereaux_statut ON bordereaux(statut)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_bordereaux_projet ON bordereaux(numero_projet)`);
  });
}

function getDb() {
  return db;
}

module.exports = { getDb, initDb, db };
