const express = require('express');
const router = express.Router();
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { synchroniser } = require('../services/seao-sync');
const { obtenirInfosEntreprise } = require('../services/seao-autofill');
const {
  remplirFormulaireDocx, remplirFormulairePdfAcroForm, remplirFormulairePdfPlat,
  aplatirInfosEntreprise, NOMS_LISIBLES, genererPageNotePreparation,
  ZONES, construireDetailChamps,
} = require('../services/seao-formulaire');
const { fillTemplatePdf } = require('../services/pdf-filler');
const { joindreAnnexesReelles } = require('../services/seao-annexes');
const { analyserExigences } = require('../services/seao-exigences');
const { downloadBuffer, uploadBuffer, removeFile, createSignedUrl, sanitizeKey, BUCKETS } = require('../services/storage');
const { listerRepresentants, obtenirRepresentant, champsRepresentant } = require('../services/representants');

const STATUTS = ['a_analyser', 'interessant', 'a_soumissionner', 'refuse', 'depose', 'perdu', 'gagne'];
const LABELS_STATUT = {
  a_analyser: 'À analyser', interessant: 'Intéressant', a_soumissionner: 'À soumissionner',
  refuse: 'Refusé', depose: 'Déposé', perdu: 'Perdu', gagne: 'Gagné',
};
const CATEGORIES_DOCUMENTS = ['devis', 'plans', 'addenda', 'formulaire_soumission', 'documents_administratifs'];

// Cles generees exclusivement par /api/upload-url (voir bordereaux.js/manuels.js) : jamais de separateur de chemin.
function cleTempValide(key) {
  return typeof key === 'string' && key.length > 0 && !key.includes('/') && !key.includes('..');
}

// Historique (priorite #5 du plan d'optimisation) — trace qui a fait quoi et
// quand sur un appel d'offres, meme principe que historique_bordereaux.
// Jamais bloquant : une erreur d'insertion n'empeche pas l'action principale.
async function enregistrerHistorique(db, appelOffreId, action, details, effectuePar) {
  try {
    await db.execute({
      sql: 'INSERT INTO historique_appels_offres (appel_offre_id, action, details, effectue_par) VALUES (?, ?, ?, ?)',
      args: [appelOffreId, action, details || null, effectuePar || null],
    });
  } catch (e) {
    console.error('[appels-offres] Historique non enregistré:', e.message);
  }
}

// Jours restants avant le delai de depot (priorite #5 du plan d'optimisation) —
// null si aucune date de fermeture connue. Sert au tri "urgence" ET au badge
// couleur (rouge <3j, orange <7j) sur la liste.
function joursRestants(dateFermeture) {
  if (!dateFermeture) return null;
  const fermeture = new Date(dateFermeture.replace(' ', 'T'));
  if (isNaN(fermeture.getTime())) return null;
  return Math.ceil((fermeture.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

router.get('/', async (req, res) => {
  const db = req.db;
  const filtre = req.query.filtre || '14j';
  // "urgence" (delai de depot le plus proche en premier) est le tri par
  // defaut desormais — bien plus utile au quotidien qu'un tri par pertinence
  // de mots-cles quand des dates de fermeture existent.
  const tri = req.query.tri || 'urgence';

  // Toujours plafonne a 14 jours (voir demande initiale), le filtre affine dans cette fenetre.
  let intervalle = '-14 day';
  if (filtre === 'aujourdhui') intervalle = '0 day';
  else if (filtre === '24h') intervalle = '-1 day';
  else if (filtre === '7j') intervalle = '-7 day';

  let sql = `SELECT a.*,
      (SELECT COUNT(*) FROM appels_offres_formulaires f WHERE f.appel_offre_id = a.id) as nb_formulaires
      FROM appels_offres_seao a WHERE a.date_publication >= datetime('now', ?)`;
  const args = [intervalle];
  if (req.query.visite === '1') sql += ` AND a.date_visite_obligatoire IS NOT NULL AND a.date_visite_obligatoire != ''`;
  sql += tri === 'pertinence'
    ? ` ORDER BY LENGTH(a.mots_cles_matches) - LENGTH(REPLACE(a.mots_cles_matches, ',', '')) DESC, a.date_publication DESC`
    // "urgence" et l'ancien "fermeture" (compat) partagent le meme tri : date
    // de fermeture la plus proche en premier, NULL (aucune date) en dernier.
    : ` ORDER BY (a.date_fermeture IS NULL OR a.date_fermeture = ''), a.date_fermeture ASC`;

  const r = await db.execute({ sql, args });
  const appels = r.rows.map((a) => ({ ...a, joursRestants: joursRestants(a.date_fermeture) }));
  const derniereSync = await db.execute(`SELECT MAX(updated_at) as t FROM appels_offres_seao`);

  // Statistiques simples (priorite #5 du plan) — visibilite rapide de la
  // valeur de l'outil, calculees sur TOUS les appels d'offres (pas juste la
  // fenetre de 14 jours affichee), par statut interne.
  const statsR = await db.execute(`SELECT statut_interne, COUNT(*) as n FROM appels_offres_seao GROUP BY statut_interne`);
  const stats = {};
  statsR.rows.forEach((s) => { stats[s.statut_interne] = s.n; });

  res.render('appels-offres', {
    appels, filtre, tri, stats,
    derniereSync: derniereSync.rows[0] ? derniereSync.rows[0].t : null,
    syncMsg: req.query.sync || '', syncMatches: req.query.matches || '', syncErreur: req.query.msg || '',
  });
});

router.get('/importer', (req, res) => {
  res.render('appel-offre-importer', { erreur: '' });
});

// Point d'entree UNIQUE pour importer un appel d'offres trouve manuellement
// (remplace les anciens /nouveau [metadonnees seules] et /rapide [un seul
// formulaire] — priorite #5 du plan d'optimisation : un seul parcours,
// metadonnees ET documents (devis/plans/addenda/formulaire/administratifs)
// au meme endroit, tout optionnel sauf au moins UNE information utile).
router.post('/importer', async (req, res) => {
  const db = req.db;
  const { numero_seao, titre, donneur_ouvrage, lieu_travaux, date_fermeture, date_visite_obligatoire, url_seao } = req.body;

  // Fichiers optionnels par categorie : chacun est soit absent, soit une cle
  // temp unique, soit un tableau de cles (categories "multiple", voir vue).
  const fichiers = {};
  for (const cat of CATEGORIES_DOCUMENTS) {
    const cles = [].concat(req.body[cat + '_key'] || []).filter(cleTempValide);
    const noms = [].concat(req.body[cat + '_name'] || []);
    if (cles.length > 0) fichiers[cat] = cles.map((cle, i) => ({ cle, nom: noms[i] || cat }));
  }
  const nbFichiers = Object.values(fichiers).reduce((s, arr) => s + arr.length, 0);

  if (!titre && !numero_seao && nbFichiers === 0) {
    return res.render('appel-offre-importer', { erreur: 'Donnez au moins un titre, un numéro SEAO, ou un document à importer.' });
  }

  const numeroFinal = (numero_seao || '').trim() || ('MANUEL-' + Date.now());
  const titreFinal = (titre || '').trim() || 'Appel d\'offres importé manuellement';

  let appelId;
  try {
    const r = await db.execute({
      sql: `INSERT INTO appels_offres_seao (numero_seao, titre, donneur_ouvrage, lieu_travaux, date_publication, date_fermeture, date_visite_obligatoire, url_seao, mots_cles_matches)
            VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, 'import manuel')`,
      args: [numeroFinal, titreFinal, donneur_ouvrage || null, lieu_travaux || null, date_fermeture || null, date_visite_obligatoire || null, url_seao || null],
    });
    appelId = r.lastInsertRowid;
  } catch (e) {
    return res.render('appel-offre-importer', { erreur: e.message.includes('UNIQUE') ? 'Ce numéro SEAO existe déjà.' : e.message });
  }
  await enregistrerHistorique(db, appelId, 'importe', `Importé manuellement (${nbFichiers} document(s))`);

  let premierFormulaireId = null;
  for (const [categorie, entrees] of Object.entries(fichiers)) {
    for (const { cle, nom } of entrees) {
      const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, cle);
      if (!buf) continue;
      const cleFinale = sanitizeKey(`${appelId}/${categorie}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${nom}`);
      await uploadBuffer(BUCKETS.SEAO, cleFinale, buf);
      await removeFile(BUCKETS.UPLOADS_TEMP, cle).catch(() => {});
      await db.execute({
        sql: 'INSERT INTO appels_offres_documents (appel_offre_id, categorie, cle_storage, nom_fichier) VALUES (?, ?, ?, ?)',
        args: [appelId, categorie, cleFinale, nom],
      });
      if (categorie === 'formulaire_soumission') {
        const ext = path.extname(nom).toLowerCase().replace('.', '');
        const rForm = await db.execute({
          sql: `INSERT INTO appels_offres_formulaires (appel_offre_id, cle_storage_original, format, statut) VALUES (?, ?, ?, 'a_remplir')`,
          args: [appelId, cleFinale, ext],
        });
        if (!premierFormulaireId) premierFormulaireId = rForm.lastInsertRowid;
      }
    }
  }

  // Si un (seul) formulaire vient d'etre importe, aller directement dessus
  // (meme UX rapide que l'ancien /rapide) ; sinon, la page de detail.
  res.redirect(premierFormulaireId
    ? `/appels-offres/${appelId}/formulaire/${premierFormulaireId}`
    : `/appels-offres/${appelId}`);
});

router.post('/actualiser', async (req, res) => {
  try {
    const resultat = await synchroniser(req.db);
    res.redirect(`/appels-offres?sync=ok&matches=${resultat.matches}`);
  } catch (e) {
    res.redirect(`/appels-offres?sync=erreur&msg=${encodeURIComponent(e.message)}`);
  }
});

// Import DIRECT depuis SEAO (URL de l'avis ou numéro) — contrairement à
// /importer (dépôt manuel de fichiers), celui-ci se connecte à SEAO avec la
// session de l'entreprise et récupère lui-même les métadonnées ET tous les
// documents (voir seao-scraper.js). Traitement délégué au service Render
// (seul endroit avec Chromium) : on crée/marque la fiche "en_cours" tout de
// suite, puis on revient sur la page de détail qui se rafraîchira une fois le
// travail terminé (statut_import passe à 'succes' ou 'erreur').
router.post('/importer-direct', async (req, res) => {
  const db = req.db;
  const url = (req.body.url_seao || '').trim();
  const numeroAvis = (req.body.numero_avis || '').trim();
  if (!url && !numeroAvis) {
    return res.render('appel-offre-importer', { erreur: "Donnez l'URL de l'avis SEAO ou son numéro." });
  }

  const numeroFinal = numeroAvis || ('EN_ATTENTE-' + Date.now());
  let appelId;
  try {
    const r = await db.execute({
      sql: `INSERT INTO appels_offres_seao (numero_seao, titre, url_seao, statut_import)
            VALUES (?, ?, ?, 'en_cours')
            ON CONFLICT(numero_seao) DO UPDATE SET statut_import = 'en_cours', updated_at = datetime('now')`,
      args: [numeroFinal, 'Importation SEAO en cours...', url || null],
    });
    appelId = r.lastInsertRowid
      ? Number(r.lastInsertRowid)
      : (await db.execute({ sql: 'SELECT id FROM appels_offres_seao WHERE numero_seao = ?', args: [numeroFinal] })).rows[0].id;
  } catch (e) {
    return res.render('appel-offre-importer', { erreur: e.message });
  }

  await enregistrerHistorique(db, appelId, 'import_seao_lance', url || numeroAvis);
  const { lancerImportSeaoDistant } = require('../services/seao-import-distant');
  const declenchement = await lancerImportSeaoDistant({ appelOffreId: appelId, url: url || null, numeroAvis: numeroAvis || null });
  if (!declenchement.ok) {
    await db.execute({ sql: `UPDATE appels_offres_seao SET statut_import = 'erreur', erreur_import = ? WHERE id = ?`, args: [declenchement.error, appelId] });
  }

  res.redirect(`/appels-offres/${appelId}`);
});

// Relance l'import direct pour un appel d'offres existant (nouveaux
// addendas publiés, ou premier essai échoué) — réutilise son url_seao/numero_seao.
router.post('/:id/actualiser-seao', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.redirect('/appels-offres');
  const r = await db.execute({ sql: 'SELECT numero_seao, url_seao FROM appels_offres_seao WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres');

  await db.execute({ sql: `UPDATE appels_offres_seao SET statut_import = 'en_cours' WHERE id = ?`, args: [id] });
  await enregistrerHistorique(db, id, 'import_seao_relance');
  const { lancerImportSeaoDistant } = require('../services/seao-import-distant');
  const declenchement = await lancerImportSeaoDistant({
    appelOffreId: id,
    url: r.rows[0].url_seao && !r.rows[0].url_seao.startsWith('http') ? null : r.rows[0].url_seao,
    numeroAvis: r.rows[0].numero_seao && !r.rows[0].numero_seao.startsWith('EN_ATTENTE') ? r.rows[0].numero_seao : null,
  });
  if (!declenchement.ok) {
    await db.execute({ sql: `UPDATE appels_offres_seao SET statut_import = 'erreur', erreur_import = ? WHERE id = ?`, args: [declenchement.error, id] });
  }
  res.redirect(`/appels-offres/${id}`);
});

router.get('/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  // Route "attrape-tout" (:id) — un id non numerique (ex. vieux lien vers
  // /nouveau ou /rapide, retires) doit rediriger proprement plutot que de
  // faire echouer la requete SQL (NaN comme parametre).
  if (isNaN(id)) return res.redirect('/appels-offres');
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_seao WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres');

  const documents = await db.execute({ sql: 'SELECT * FROM appels_offres_documents WHERE appel_offre_id = ?', args: [id] });
  const formulaires = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE appel_offre_id = ?', args: [id] });
  const historique = await db.execute({ sql: 'SELECT * FROM historique_appels_offres WHERE appel_offre_id = ? ORDER BY created_at DESC, id DESC', args: [id] });

  let donneesBrutes = {};
  try { donneesBrutes = JSON.parse(r.rows[0].donnees_brutes || '{}'); } catch (_) {}

  // Checklist de depot (priorite #5 du plan) — calculee a la volee a partir
  // des donnees reelles plutot que stockee a part, pour ne jamais desynchroniser
  // de la realite (ex: un document supprime met a jour la checklist tout seul).
  const addendas = documents.rows.filter((d) => d.categorie === 'addenda');
  const checklist = [
    { label: 'Devis importé', ok: documents.rows.some((d) => d.categorie === 'devis'), obligatoire: true },
    { label: 'Formulaire de soumission rempli et validé', ok: formulaires.rows.some((f) => f.statut === 'valide'), obligatoire: true },
    {
      label: addendas.length > 0 ? `Tous les addendas accusés (${addendas.filter((d) => d.accuse).length}/${addendas.length})` : 'Aucun addenda à ce jour',
      ok: addendas.every((d) => d.accuse),
      obligatoire: addendas.length > 0,
    },
  ];
  const pretADeposer = checklist.filter((c) => c.obligatoire).every((c) => c.ok);

  const exigencesRes = await db.execute({ sql: 'SELECT * FROM exigences WHERE appel_offre_id = ? ORDER BY id', args: [id] });

  res.render('appel-offre-detail', {
    appel: r.rows[0], documents: documents.rows, formulaires: formulaires.rows, historique: historique.rows,
    donneesBrutes, statuts: STATUTS, labelsStatut: LABELS_STATUT, checklist, pretADeposer,
    joursRestants: joursRestants(r.rows[0].date_fermeture),
    exigences: exigencesRes.rows,
  });
});

// Lance/relance l'analyse IA des exigences (dates travaux, methode de depot,
// cautionnements, lettre d'engagement, lettre d'assureur, autres documents) —
// ne touche jamais aux lignes deja validees manuellement.
router.post('/:id/exigences/analyser', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.redirect('/appels-offres');

  const resultat = await analyserExigences(db, id);
  if (resultat.error) {
    await enregistrerHistorique(db, id, 'exigences_analyse_echouee', resultat.error);
  } else {
    await enregistrerHistorique(db, id, 'exigences_analysees', `${resultat.inserees} exigence(s) mise(s) à jour à partir de ${resultat.documentsLus.length} document(s)${resultat.documentsIgnores.length ? ` — ${resultat.documentsIgnores.length} document(s) ignoré(s) (budget dépassé)` : ''}`);
  }
  res.redirect('/appels-offres/' + id + '#exigences');
});

// Correction manuelle d'une exigence — conserve la valeur extraite (colonne
// `valeur`) et enregistre la correction a part (`valeur_corrigee`), jamais
// ecrasee par une reanalyse ulterieure (valide_manuellement=1).
router.post('/:id/exigences/:exigenceId/corriger', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const exigenceId = parseInt(req.params.exigenceId);
  const valeurCorrigee = (req.body.valeur_corrigee || '').trim();
  const responsable = (req.body.responsable || '').trim();
  const dateEcheance = (req.body.date_echeance || '').trim();

  await db.execute({
    sql: `UPDATE exigences SET
      valeur_corrigee = ?, valide_manuellement = 1, corrige_par = ?, corrige_le = datetime('now'),
      responsable = ?, date_echeance = ?, updated_at = datetime('now')
      WHERE id = ? AND appel_offre_id = ?`,
    args: [valeurCorrigee || null, req.body.corrige_par || null, responsable || null, dateEcheance || null, exigenceId, id],
  });
  await enregistrerHistorique(db, id, 'exigence_corrigee', `Exigence #${exigenceId} corrigée manuellement`);
  res.redirect('/appels-offres/' + id + '#exigences');
});

router.post('/:id/statut', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const statut = STATUTS.includes(req.body.statut) ? req.body.statut : 'a_analyser';
  await db.execute({
    sql: `UPDATE appels_offres_seao SET statut_interne = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [statut, id],
  });
  await enregistrerHistorique(db, id, 'statut_change', `Nouveau statut : ${LABELS_STATUT[statut] || statut}`);
  res.redirect('/appels-offres/' + id);
});

// Ajoute un document (devis/plans/addenda/formulaire de soumission) — le
// fichier est deja uploade dans uploads-temp par le navigateur (meme flux
// direct-upload.js que manuels/bordereaux), cette route le deplace vers le
// stockage permanent et cree la ligne DB.
router.post('/:id/documents', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const categorie = CATEGORIES_DOCUMENTS.includes(req.body.categorie) ? req.body.categorie : 'devis';
  const tempKey = req.body.fichier_key;
  const nomOriginal = req.body.fichier_name || 'document';
  if (!cleTempValide(tempKey)) return res.redirect('/appels-offres/' + id);

  const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, tempKey);
  if (buf) {
    const cleFinale = sanitizeKey(`${id}/${categorie}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${nomOriginal}`);
    await uploadBuffer(BUCKETS.SEAO, cleFinale, buf);
    await removeFile(BUCKETS.UPLOADS_TEMP, tempKey).catch(() => {});
    await db.execute({
      sql: 'INSERT INTO appels_offres_documents (appel_offre_id, categorie, cle_storage, nom_fichier) VALUES (?, ?, ?, ?)',
      args: [id, categorie, cleFinale, nomOriginal],
    });
    if (categorie === 'formulaire_soumission') {
      const ext = path.extname(nomOriginal).toLowerCase().replace('.', '');
      await db.execute({
        sql: `INSERT INTO appels_offres_formulaires (appel_offre_id, cle_storage_original, format, statut) VALUES (?, ?, ?, 'a_remplir')`,
        args: [id, cleFinale, ext],
      });
    }
    await enregistrerHistorique(db, id, 'document_ajoute', `${categorie} — ${nomOriginal}`);
  }
  res.redirect('/appels-offres/' + id);
});

// Supprime un document (et le formulaire lie, le cas echeant, avec son
// eventuel fichier rempli) — necessaire pour retirer un fichier importe par
// erreur sans devoir passer par la base de donnees directement.
router.post('/:id/documents/:docId/supprimer', async (req, res) => {
  const db = req.db;
  const { id, docId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_documents WHERE id = ? AND appel_offre_id = ?', args: [docId, id] });
  if (r.rows.length > 0) {
    const doc = r.rows[0];
    await removeFile(BUCKETS.SEAO, doc.cle_storage).catch(() => {});
    const formulairesLies = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE appel_offre_id = ? AND cle_storage_original = ?', args: [id, doc.cle_storage] });
    for (const f of formulairesLies.rows) {
      if (f.cle_storage_rempli) await removeFile(BUCKETS.SEAO, f.cle_storage_rempli).catch(() => {});
      await db.execute({ sql: 'DELETE FROM appels_offres_formulaires WHERE id = ?', args: [f.id] });
    }
    await db.execute({ sql: 'DELETE FROM appels_offres_documents WHERE id = ?', args: [docId] });
  }
  res.redirect('/appels-offres/' + id);
});

// Accuse de reception d'un addenda (checklist de depot, priorite #5) — bascule
// simple, jamais automatique : chaque addenda importe doit etre confirme
// individuellement par l'utilisateur avant que la checklist soit complete.
router.post('/:id/documents/:docId/accuser', async (req, res) => {
  const db = req.db;
  const { id, docId } = req.params;
  const r = await db.execute({ sql: 'SELECT accuse, nom_fichier FROM appels_offres_documents WHERE id = ? AND appel_offre_id = ? AND categorie = ?', args: [docId, id, 'addenda'] });
  if (r.rows.length > 0) {
    const nouvelEtat = r.rows[0].accuse ? 0 : 1;
    await db.execute({ sql: 'UPDATE appels_offres_documents SET accuse = ? WHERE id = ?', args: [nouvelEtat, docId] });
    await enregistrerHistorique(db, id, 'addenda_accuse', `${r.rows[0].nom_fichier} — ${nouvelEtat ? 'accusé reçu' : 'accusé retiré'}`);
  }
  res.redirect('/appels-offres/' + id);
});

router.get('/:id/formulaire/:formId', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres/' + id);
  const appelR = await db.execute({ sql: 'SELECT * FROM appels_offres_seao WHERE id = ?', args: [id] });
  if (appelR.rows.length === 0) return res.redirect('/appels-offres');

  let champsDetectes = [], champsNonPlaces = [], champsDetail = [];
  try { champsDetectes = JSON.parse(r.rows[0].champs_detectes || '[]'); } catch (_) {}
  try { champsNonPlaces = JSON.parse(r.rows[0].champs_non_places || '[]'); } catch (_) {}
  try { champsDetail = JSON.parse(r.rows[0].champs_detail || '[]'); } catch (_) {}

  // Grouper par zone (priorite #5) pour l'affichage, dans un ordre fixe et
  // lisible plutot que l'ordre d'insertion (place/non-place melanges).
  const zonesAvecChamps = {};
  for (const c of champsDetail) {
    if (!zonesAvecChamps[c.zone]) zonesAvecChamps[c.zone] = [];
    zonesAvecChamps[c.zone].push(c);
  }

  res.render('appel-offre-formulaire', {
    appel: appelR.rows[0], formulaire: r.rows[0], champsDetectes, champsNonPlaces,
    zonesAvecChamps, ZONES, representants: listerRepresentants(),
    erreur: req.query.erreur || '',
  });
});

// Sert le PDF ORIGINAL (vierge) — utilise par PDF.js dans l'editeur visuel
// pour l'afficher en canvas (voir /editeur ci-dessous). Jamais le fichier
// rempli : l'editeur sert a POSITIONNER les champs sur le formulaire vide.
router.get('/:id/formulaire/:formId/fichier', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT cle_storage_original FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.status(404).send('Formulaire introuvable.');
  const buf = await downloadBuffer(BUCKETS.SEAO, r.rows[0].cle_storage_original);
  if (!buf) return res.status(404).send('Fichier introuvable dans le stockage.');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(buf);
});

// Editeur visuel : meme principe que l'editeur drag-and-drop des bordereaux
// (PDF affiche en canvas via PDF.js, l'utilisateur positionne chaque champ
// lui-meme) — plus fiable que le placement devine par l'IA sur un formulaire
// SEAO typique (lignes a blanc repetees, ex. "Nom du representant :" a
// plusieurs endroits differents du document). Les valeurs sont deja connues
// (base de connaissances) ; l'utilisateur ne fait que choisir OU les ecrire.
router.get('/:id/formulaire/:formId/editeur', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres/' + id);
  const formulaire = r.rows[0];

  if ((formulaire.format || '').toLowerCase() === 'docx') {
    // L'editeur visuel ne s'applique qu'aux PDF (le .docx a deja son propre
    // pipeline fiable par libelle exact + IA, voir remplirFormulaireDocx).
    return res.redirect(`/appels-offres/${id}/formulaire/${formId}?erreur=${encodeURIComponent("L'éditeur visuel ne s'applique qu'aux formulaires PDF.")}`);
  }

  const appelR = await db.execute({ sql: 'SELECT * FROM appels_offres_seao WHERE id = ?', args: [id] });
  if (appelR.rows.length === 0) return res.redirect('/appels-offres');

  let infos = {};
  try {
    infos = await obtenirInfosEntreprise(db);
  } catch (e) {
    console.error('[appels-offres] obtenirInfosEntreprise échoué (éditeur):', e.message);
    infos = { error: e.message };
  }
  const valeursConnues = infos.error ? {} : aplatirInfosEntreprise(infos);

  let positions = {};
  try { positions = JSON.parse(formulaire.positions || '{}'); } catch (_) {}

  res.render('appel-offre-formulaire-editeur', {
    appel: appelR.rows[0], formulaire,
    champsDisponibles: Object.keys(NOMS_LISIBLES).map((cle) => ({ cle, label: NOMS_LISIBLES[cle], valeur: valeursConnues[cle] || '' })),
    positions,
  });
});

// Sauvegarde les positions choisies par l'utilisateur (appel fetch JSON
// depuis l'editeur, pas un formulaire classique).
router.post('/:id/formulaire/:formId/positions', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const positions = req.body && typeof req.body === 'object' ? req.body : {};
  await db.execute({
    sql: `UPDATE appels_offres_formulaires SET positions = ? WHERE id = ? AND appel_offre_id = ?`,
    args: [JSON.stringify(positions), formId, id],
  });
  res.json({ ok: true });
});

// Pre-remplit le formulaire avec les infos d'entreprise de la base de
// connaissances. Si des positions ont ete placees manuellement via l'editeur
// visuel, elles priment TOUJOURS (bien plus fiable) — sinon, retombe sur la
// detection automatique (.docx / PDF AcroForm / PDF plat par IA).
router.post('/:id/formulaire/:formId/remplir', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.redirect('/appels-offres/' + id);
  const formulaire = r.rows[0];

  try {
    const buf = await downloadBuffer(BUCKETS.SEAO, formulaire.cle_storage_original);
    if (!buf) throw new Error('Fichier original introuvable dans le stockage.');

    // ?recalculer=1 permet de forcer une nouvelle analyse IA sans attendre
    // l'expiration du cache de 30 jours (utile juste apres un ajout/retrait
    // de document dans la base de connaissances).
    const infos = await obtenirInfosEntreprise(db, { forcerRecalcul: req.query.recalculer === '1' });
    if (infos.error) throw new Error(infos.error);

    // Représentant désigné pour CE dossier (choisi par l'utilisateur avant de
    // lancer le remplissage) — écrase toujours ce que l'IA aurait pu deviner
    // depuis les documents génériques de l'entreprise : une sélection humaine
    // explicite pour un dossier précis est plus fiable qu'une extraction.
    const representant = obtenirRepresentant(req.body && req.body.representant_id);
    if (representant) {
      // champsRepresentant() fixe aussi SIGNATAIRE_AUTORISE au nom de CE
      // représentant — T3E n'a pas de signataire par défaut distinct, c'est
      // toujours le représentant désigné pour ce dossier qui signe. Un
      // signataire fixe ici avait auparavant fait apparaître le président à
      // tort à la place du représentant sélectionné (bug corrigé deux fois :
      // d'abord en supprimant le SIGNATAIRE_AUTORISE devine par l'IA, puis en
      // retirant la constante fixe qui le remplaçait silencieusement).
      Object.assign(infos, champsRepresentant(representant));
    } else {
      // Aucun représentant sélectionné : ne pas laisser un signataire deviné
      // par l'IA (ou une valeur fixe) apparaître sans confirmation humaine.
      delete infos.SIGNATAIRE_AUTORISE;
    }

    const ext = (formulaire.format || '').toLowerCase();
    let positionsSauvegardees = {};
    try { positionsSauvegardees = JSON.parse(formulaire.positions || '{}'); } catch (_) {}

    let resultat, formatDetecte;
    if (ext !== 'docx' && Object.keys(positionsSauvegardees).length > 0) {
      // Positionnement manuel (editeur visuel) : le plus fiable, toujours prioritaire.
      const valeursConnues = aplatirInfosEntreprise(infos);
      const positionsAvecValeurs = {};
      const champsPlaces = [], champsNonPlaces = [];
      for (const cle of Object.keys(positionsSauvegardees)) {
        const valeur = valeursConnues[cle];
        if (!valeur) { champsNonPlaces.push(NOMS_LISIBLES[cle] || cle); continue; }
        // Un meme champ peut etre place a plusieurs endroits (ex. nom de
        // l'entreprise repete en page couverture ET en page d'identification
        // d'un vrai formulaire SEAO) — positions[cle] est toujours un tableau.
        const placements = Array.isArray(positionsSauvegardees[cle]) ? positionsSauvegardees[cle] : [positionsSauvegardees[cle]];
        placements.forEach((p, i) => { positionsAvecValeurs[`${cle}#${i}`] = { ...p, val: valeur }; });
        champsPlaces.push(NOMS_LISIBLES[cle] || cle);
      }
      const pdfDoc = await fillTemplatePdf(buf, positionsAvecValeurs);
      resultat = { buffer: Buffer.from(await pdfDoc.save()), champsPlaces, champsNonPlaces };
      formatDetecte = 'pdf_positions_manuelles';
    } else if (ext === 'docx') {
      resultat = await remplirFormulaireDocx(buf, infos);
      formatDetecte = 'docx';
    } else {
      const pdfDoc = await PDFDocument.load(buf);
      const nbChamps = pdfDoc.getForm().getFields().length;
      if (nbChamps > 0) {
        resultat = await remplirFormulairePdfAcroForm(buf, infos);
        formatDetecte = 'pdf_acroform';
      } else {
        resultat = await remplirFormulairePdfPlat(buf, infos);
        formatDetecte = 'pdf_plat';
      }
    }

    // Traçabilité par zone (priorité #5) : chaque champ réellement détecté
    // (placé ou non) est classé dans l'une des 8 zones du formulaire pour le
    // tableau de validation — jamais bloquant, "Autre" en repli.
    const champDetail = construireDetailChamps(resultat.champsPlaces, resultat.champsNonPlaces, aplatirInfosEntreprise(infos));

    // Annexes reelles a joindre (CNESST, ISO, francisation, AMP...) + mises
    // en garde de l'IA (donnee trouvee pour une entite differente,
    // attestation manquante...) — les annexes sont fusionnees directement
    // dans le PDF, les avertissements + champs manquants regroupes sur UNE
    // page ajoutee en tete (marquee BROUILLON tant qu'il manque des champs)
    // plutot que d'annoter le formulaire officiel lui-meme.
    if (formatDetecte !== 'docx') {
      try {
        const pdfFinal = await PDFDocument.load(resultat.buffer);
        const { annexesJointes, annexesNonTrouvees } = await joindreAnnexesReelles(db, pdfFinal);
        // infos.AVERTISSEMENTS (ex. "certificat pour l'entite X non utilise")
        // n'est plus affiche ici sur demande de l'utilisateur : une donnee
        // ecartee a tort (entite differente, etc.) doit simplement ne pas
        // etre utilisee, sans qu'il soit necessaire de le signaler a chaque
        // formulaire genere. On garde seulement les avertissements
        // actionnables (annexe non trouvee, a joindre manuellement).
        const avertissements = [];
        annexesNonTrouvees.forEach((lib) => avertissements.push(
          `Aucun document trouvé dans la base de connaissances pour joindre à l'annexe « ${lib} » — à ajouter manuellement.`
        ));
        await genererPageNotePreparation(pdfFinal, avertissements, resultat.champsNonPlaces, aplatirInfosEntreprise(infos));
        resultat.buffer = Buffer.from(await pdfFinal.save());
        if (annexesJointes.length > 0) console.log('[appels-offres] Annexes jointes automatiquement:', annexesJointes.join(', '));
      } catch (e) {
        console.error('[appels-offres] Fusion annexes/note échouée:', e.message);
      }
    }

    const cleRempli = formulaire.cle_storage_original.replace(/(\.[a-z0-9]+)$/i, '-rempli$1');
    await uploadBuffer(BUCKETS.SEAO, cleRempli, resultat.buffer);

    // "pre_rempli" reste le statut tant que l'utilisateur n'a pas confirmé
    // explicitement (voir POST .../valider) — même si tous les champs sont
    // déjà remplis, la confirmation manuelle reste requise.
    await db.execute({
      sql: `UPDATE appels_offres_formulaires SET cle_storage_rempli = ?, format = ?, champs_detectes = ?, champs_non_places = ?, champs_detail = ?, statut = 'pre_rempli' WHERE id = ?`,
      args: [cleRempli, formatDetecte, JSON.stringify(resultat.champsPlaces), JSON.stringify(resultat.champsNonPlaces), JSON.stringify(champDetail), formId],
    });
    await enregistrerHistorique(db, id, 'formulaire_rempli', `${resultat.champsPlaces.length} champ(s) rempli(s), ${resultat.champsNonPlaces.length} manquant(s)`);
  } catch (e) {
    console.error('[appels-offres] Remplissage formulaire échoué:', e.message);
    return res.redirect(`/appels-offres/${id}/formulaire/${formId}?erreur=${encodeURIComponent(e.message)}`);
  }
  res.redirect(`/appels-offres/${id}/formulaire/${formId}`);
});

router.get('/:id/formulaire/:formId/telecharger', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT * FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0 || !r.rows[0].cle_storage_rempli) return res.status(404).send('Formulaire pas encore pré-rempli.');
  try {
    // Tant que le formulaire n'a pas ete valide explicitement (priorite #5),
    // le nom du fichier telecharge le rappelle clairement.
    const prefixe = r.rows[0].statut === 'valide' ? '' : 'BROUILLON-';
    const nomFichier = prefixe + 'formulaire-rempli' + path.extname(r.rows[0].cle_storage_rempli);
    const url = await createSignedUrl(BUCKETS.SEAO, r.rows[0].cle_storage_rempli, 300, nomFichier);
    res.redirect(url);
  } catch (e) {
    res.status(404).send('Fichier introuvable dans le stockage.');
  }
});

// Confirmation manuelle (priorité #5) : le formulaire ne devient "valide"
// (retire le marquage brouillon) que si tous les champs détectés ont une
// valeur — jamais automatique, jamais si des champs manquent encore.
router.post('/:id/formulaire/:formId/valider', async (req, res) => {
  const db = req.db;
  const { id, formId } = req.params;
  const r = await db.execute({ sql: 'SELECT champs_non_places FROM appels_offres_formulaires WHERE id = ? AND appel_offre_id = ?', args: [formId, id] });
  if (r.rows.length === 0) return res.redirect(`/appels-offres/${id}`);
  let manquants = [];
  try { manquants = JSON.parse(r.rows[0].champs_non_places || '[]'); } catch (_) {}
  if (manquants.length > 0) {
    return res.redirect(`/appels-offres/${id}/formulaire/${formId}?erreur=${encodeURIComponent('Impossible de valider : ' + manquants.length + ' champ(s) encore manquant(s).')}`);
  }
  await db.execute({ sql: `UPDATE appels_offres_formulaires SET statut = 'valide' WHERE id = ?`, args: [formId] });
  await enregistrerHistorique(db, id, 'formulaire_valide', `Formulaire #${formId} validé — plus aucun champ manquant`, (req.body && req.body.valide_par) || null);
  res.redirect(`/appels-offres/${id}/formulaire/${formId}`);
});

module.exports = router;
