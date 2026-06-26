const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  nom_fichier TEXT NOT NULL,
  chemin_fichier TEXT NOT NULL,
  categorie_id INTEGER NOT NULL,
  type_fichier TEXT NOT NULL,
  taille_octets INTEGER,
  description TEXT,
  source TEXT,
  annee TEXT,
  version TEXT,
  mots_cles TEXT,
  statut TEXT DEFAULT 'actif' CHECK(statut IN ('actif', 'archive', 'supprime')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (categorie_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS bordereaux (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_projet TEXT,
  titre TEXT NOT NULL,
  contenu JSON,
  document_source_id INTEGER,
  statut TEXT DEFAULT 'brouillon' CHECK(statut IN ('brouillon', 'revise', 'approuve', 'session', 'genere')),
  cree_par TEXT,
  modifie_par TEXT,
  approuve_par TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (document_source_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS historique_bordereaux (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bordereau_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  ancien_statut TEXT,
  nouveau_statut TEXT,
  commentaire TEXT,
  effectue_par TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (bordereau_id) REFERENCES bordereaux(id)
);

CREATE TABLE IF NOT EXISTS projets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  nom TEXT NOT NULL,
  client TEXT,
  adresse TEXT,
  description TEXT,
  date_debut TEXT,
  date_fin TEXT,
  statut TEXT DEFAULT 'en_cours',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projet_documents (
  projet_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  PRIMARY KEY (projet_id, document_id),
  FOREIGN KEY (projet_id) REFERENCES projets(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS materiaux (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  fabricant TEXT,
  categorie TEXT,
  numero_produit TEXT,
  description TEXT,
  fiche_sds_url TEXT,
  document_id INTEGER,
  type_produit TEXT,
  type_systeme TEXT,
  fournisseur TEXT,
  dimension TEXT,
  unite TEXT,
  superficie_couvrante TEXT,
  lien_fiche_technique TEXT,
  lien_fiche_securite TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

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

CREATE INDEX IF NOT EXISTS idx_documents_categorie ON documents(categorie_id);
CREATE INDEX IF NOT EXISTS idx_documents_statut ON documents(statut);
CREATE INDEX IF NOT EXISTS idx_documents_titre ON documents(titre);
CREATE INDEX IF NOT EXISTS idx_bordereaux_statut ON bordereaux(statut);
CREATE INDEX IF NOT EXISTS idx_bordereaux_projet ON bordereaux(numero_projet);
CREATE INDEX IF NOT EXISTS idx_materiaux_nom ON materiaux(nom);
CREATE INDEX IF NOT EXISTS idx_materiaux_fabricant ON materiaux(fabricant);
`;

module.exports = SCHEMA;
