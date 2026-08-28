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
    `CREATE TABLE IF NOT EXISTS historique_appels_offres (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appel_offre_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      effectue_par TEXT,
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
    // ── Module « plans tel que construit » (as-built) ──────────────────────
    // Projet as-built : conteneur des plans/documents et du registre des
    // modifications. disciplines = JSON array (architecture, structure,
    // mecanique, electricite, plomberie, toiture, civil, autre).
    `CREATE TABLE IF NOT EXISTS asbuilt_projets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT,
      nom TEXT NOT NULL,
      client TEXT,
      adresse TEXT,
      description TEXT,
      responsable TEXT,
      disciplines JSON,
      format_plans TEXT,
      notes TEXT,
      statut TEXT DEFAULT 'nouveau' CHECK(statut IN ('nouveau','documents','analyse','revision','annotation','termine')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    // Documents importes (plans initiaux, devis, avenants, directives, ordres
    // de changement, rapports journaliers, DDI, dessins d'atelier, photos,
    // plans annotes, releves, autres). extraction = JSON structure produit
    // par l'analyse IA, TOUJOURS lie a la source (document + pages).
    `CREATE TABLE IF NOT EXISTS asbuilt_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projet_id INTEGER NOT NULL,
      nom TEXT NOT NULL,
      categorie TEXT NOT NULL CHECK(categorie IN ('plan_initial','devis','avenant','directive','ordre_changement','rapport_journalier','demande_information','dessin_atelier','photo','plan_annote','releve_chantier','autre')),
      type_fichier TEXT,
      date_document TEXT,
      version TEXT,
      auteur TEXT,
      statut_analyse TEXT DEFAULT 'en_attente' CHECK(statut_analyse IN ('en_attente','en_cours','analyse','sans_texte','erreur')),
      cle_stockage TEXT NOT NULL,
      taille_octets INTEGER,
      nb_pages INTEGER,
      extraction JSON,
      erreur_analyse TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (projet_id) REFERENCES asbuilt_projets(id)
    )`,
    // Registre central des modifications detectees. Chaque ligne DOIT etre
    // liee a au moins une source (document_id + page + extrait). confiance in
    // [0,1]. Le systeme distingue proposee/approuvee/executee/verifiee via
    // preuve_execution (JSON : {statut, sources:[...]}).
    `CREATE TABLE IF NOT EXISTS asbuilt_modifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projet_id INTEGER NOT NULL,
      titre TEXT NOT NULL,
      description TEXT,
      type TEXT CHECK(type IN ('ajout','suppression','deplacement','dimension','materiau','quantite','equipement','detail','contradiction','info_manquante')),
      discipline TEXT,
      feuille TEXT,
      zone TEXT,
      element TEXT,
      action_proposee TEXT,
      document_id INTEGER,
      page_source INTEGER,
      extrait_source TEXT,
      confiance REAL,
      priorite TEXT DEFAULT 'normale' CHECK(priorite IN ('basse','normale','haute','critique')),
      statut TEXT DEFAULT 'detectee' CHECK(statut IN ('detectee','a_verifier','approuvee','refusee','a_clarifier','annotee','integree')),
      preuve_execution JSON,
      references_connexes JSON,
      commentaire_reviseur TEXT,
      valide_par TEXT,
      valide_le TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (projet_id) REFERENCES asbuilt_projets(id),
      FOREIGN KEY (document_id) REFERENCES asbuilt_documents(id)
    )`,
    // Annotations structurees posees sur un plan (jamais dessinees a plat) :
    // coordonnees en % de la page (meme convention que l'editeur SEAO),
    // liees optionnellement a une modification du registre.
    `CREATE TABLE IF NOT EXISTS asbuilt_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projet_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      modification_id INTEGER,
      page INTEGER DEFAULT 0,
      type TEXT CHECK(type IN ('nuage','fleche','note','barre','ajout','texte')),
      x REAL, y REAL, w REAL, h REAL,
      texte TEXT,
      couleur TEXT,
      statut TEXT,
      auteur TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (projet_id) REFERENCES asbuilt_projets(id),
      FOREIGN KEY (document_id) REFERENCES asbuilt_documents(id),
      FOREIGN KEY (modification_id) REFERENCES asbuilt_modifications(id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_asbuilt_docs_projet ON asbuilt_documents(projet_id)',
    'CREATE INDEX IF NOT EXISTS idx_asbuilt_modifs_projet ON asbuilt_modifications(projet_id)',
    'CREATE INDEX IF NOT EXISTS idx_asbuilt_modifs_statut ON asbuilt_modifications(statut)',
    'CREATE INDEX IF NOT EXISTS idx_asbuilt_annot_document ON asbuilt_annotations(document_id)',
    // Exigences extraites d'un appel d'offres SEAO (dates travaux, methode de
    // depot, cautionnements, lettre d'engagement, lettre d'assureur, autres
    // documents requis). Chaque ligne DOIT porter sa source (document +
    // page + extrait) — jamais une valeur affichee sans preuve. Une ligne
    // validee manuellement (valide_manuellement=1) n'est plus jamais
    // ecrasee par une reanalyse (voir seao-exigences.js:analyserExigences).
    `CREATE TABLE IF NOT EXISTS exigences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appel_offre_id INTEGER NOT NULL,
      categorie TEXT NOT NULL,
      titre TEXT NOT NULL,
      valeur TEXT,
      statut TEXT DEFAULT 'a_verifier' CHECK(statut IN ('confirme','a_verifier','contradictoire','non_trouve')),
      obligatoire INTEGER DEFAULT 1,
      moment_remise TEXT,
      document_source TEXT,
      numero_page TEXT,
      extrait_source TEXT,
      niveau_confiance TEXT DEFAULT 'faible' CHECK(niveau_confiance IN ('eleve','moyen','faible')),
      valide_manuellement INTEGER DEFAULT 0,
      valeur_corrigee TEXT,
      corrige_par TEXT,
      corrige_le TEXT,
      responsable TEXT,
      date_echeance TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (appel_offre_id) REFERENCES appels_offres_seao(id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_exigences_appel ON exigences(appel_offre_id)',
  ];

  const migrationsHeures = [
    // Module « Heures » (feuilles de temps) — voir plan squishy-skipping-cook.
    // Un depot (Josiane) peut contenir plusieurs semaines (onglets) ; chaque
    // semaine devient sa PROPRE ligne des l'etape 1, suivie independamment a
    // travers les 3 etapes (correction -> feuille maitre -> suivi des heures).
    `CREATE TABLE IF NOT EXISTS feuilles_temps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      semaine_debut TEXT NOT NULL,
      semaine_fin TEXT NOT NULL,
      fichier_source_key TEXT,
      fichier_source_nom TEXT,
      onglet_source TEXT,
      etape INTEGER NOT NULL DEFAULT 1 CHECK(etape IN (1,2,3)),
      statut TEXT NOT NULL DEFAULT 'en_cours' CHECK(statut IN (
        'en_cours','a_valider','valide_etape1',
        'ajoute_maitre','valide_etape2',
        'ajoute_suivi','termine','erreur'
      )),
      lignes_corrigees JSON,
      lignes_ignorees JSON,
      codes_a_confirmer JSON,
      fichier_corrige_key TEXT,
      generation_requete JSON,
      generation_statut TEXT,
      generation_erreur TEXT,
      depose_par TEXT,
      valide_etape1_par TEXT,
      valide_etape2_par TEXT,
      valide_etape3_par TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_feuilles_temps_statut ON feuilles_temps(statut)',
  ];
  for (const sql of migrationsHeures) {
    try { await db.execute(sql); } catch (e) { /* table deja existante */ }
  }

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
    // Detail structure par champ pour le tableau de validation par zone
    // (priorite utilisateur #5) : [{ cle, nom, zone, valeur, source, statut }].
    // champs_detectes/champs_non_places (listes de noms) restent inchangees
    // pour compatibilite ; champs_detail les remplace pour l'affichage.
    'ALTER TABLE appels_offres_formulaires ADD COLUMN champs_detail JSON',
    // Accuse de reception d'un addenda (checklist de depot) — pertinent
    // seulement pour categorie='addenda', ignore pour les autres categories.
    'ALTER TABLE appels_offres_documents ADD COLUMN accuse INTEGER DEFAULT 0',
    // Suivi de l'import automatique depuis SEAO (scraper Playwright, voir
    // seao-scraper.js/seao-import-orchestrateur.js) — distinct de
    // statut_interne (jugement de l'utilisateur sur le projet).
    "ALTER TABLE appels_offres_seao ADD COLUMN statut_import TEXT DEFAULT 'jamais_tente'",
    'ALTER TABLE appels_offres_seao ADD COLUMN erreur_import TEXT',
    'ALTER TABLE appels_offres_seao ADD COLUMN derniere_synchronisation_documents TEXT',
    // Nouveau remplisseur de soumissions privees (appel d'offre + plans +
    // addendas uploades directement, sans lien SEAO) : champs_extraits =
    // JSON du rapport d'extraction IA par champ ({valeur, statut,
    // document_source, page_source, extrait_source, niveau_confiance}),
    // documents_sources = JSON des fichiers uploades pour cette generation
    // ([{nom_fichier, categorie, cle_storage}]). Colonnes additives —
    // les anciennes colonnes generateur (type_isolant, methode_adhesion,
    // etc.) restent en place mais ne sont plus utilisees par le nouveau
    // service (voir soumission-filler.js).
    'ALTER TABLE soumissions ADD COLUMN champs_extraits JSON',
    'ALTER TABLE soumissions ADD COLUMN documents_sources JSON',
    // Generation en arriere-plan (meme principe que manuels/bordereaux, voir
    // /internal/generer-soumission dans server.js) : necessaire des que
    // plusieurs documents sont combines (surtout avec un plan, qui declenche
    // l'analyse visuelle) — depasse alors le delai de 60s d'une fonction
    // Vercel. generation_requete = JSON {systeme, langue, fichiers:[{cle,
    // nom, categorie}]} sauvegarde AVANT le traitement lourd (pour que Render
    // puisse le relire) ; generation_statut n'a pas de CHECK (contrairement
    // a `statut`) pour rester simple a etendre : 'en_cours'|'termine'|'erreur'.
    'ALTER TABLE soumissions ADD COLUMN generation_requete JSON',
    'ALTER TABLE soumissions ADD COLUMN generation_statut TEXT',
    'ALTER TABLE soumissions ADD COLUMN generation_erreur TEXT',
    // Estimation de prix indicative (voir estimation-prix.js) — calculee a
    // partir de la superficie/des quantites extraites + des taux de marche
    // generiques (PAS les couts reels T3E). Toujours une SUGGESTION distincte
    // de prix_total, jamais ecrite dans prix_total ni dans le .docx genere —
    // la decision du prix final reste humaine.
    'ALTER TABLE soumissions ADD COLUMN prix_estime_note TEXT',
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
