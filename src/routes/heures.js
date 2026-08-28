const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { downloadBuffer, uploadBuffer, createSignedUrl, removeFile, BUCKETS } = require('../services/storage');
const { lireClasseurBrut, corrigerDepot } = require('../services/heures-excel-writer');
const { MASTER_KEY, ajouterSemaineDansMaitre } = require('../services/heures-maitre-writer');
const { ajouterSemaineDansSuivi } = require('../services/heures-suivi-writer');
const { envoyerNotificationEtape, envoyerDocumentFinal } = require('../services/heures-email');

const SUIVI_KEY = 'ABCD-COPIE.xlsx';

// Cles generees exclusivement par /api/upload-url (dest=temp) : jamais de
// separateur de chemin — meme garde que soumissions.js/bordereaux.js.
function cleTempValide(key) {
  return typeof key === 'string' && key.length > 0 && !key.includes('/') && !key.includes('..');
}

router.get('/', async (req, res) => {
  const db = req.db;
  const r = await db.execute(`SELECT * FROM feuilles_temps ORDER BY created_at DESC`);
  const enAttenteRevision = r.rows.filter(f => f.statut === 'a_valider').length;
  res.render('heures', { feuilles: r.rows, enAttenteRevision });
});

// Etape 1a : l'utilisateur vient de deposer le fichier brut (dest=temp) et la
// page a besoin de connaitre les onglets pour afficher un selecteur de
// semaine (calendrier) par onglet, AVANT de lancer la correction.
router.post('/apercu-onglets', async (req, res) => {
  const { fichier_key } = req.body || {};
  if (!cleTempValide(fichier_key)) return res.status(400).json({ error: 'fichier_key invalide' });
  const buffer = await downloadBuffer(BUCKETS.UPLOADS_TEMP, fichier_key);
  if (!buffer) return res.status(404).json({ error: 'fichier introuvable' });
  const onglets = lireClasseurBrut(buffer);
  res.json({ onglets: onglets.map(o => ({ nom: o.nomOnglet, nbLignes: o.lignes.length })) });
});

// Traitement complet de l'etape 1 pour UNE ligne (= un onglet/semaine deja
// associe) : retelecharge le fichier brut, corrige SEULEMENT l'onglet
// concerne, sauvegarde le resultat. Toujours execute en synchrone (pas de
// delegation Render pour ce module — decision explicite : Render n'est pas
// fiable actuellement, voir diagnostic de suspension plus tot en session).
async function genererEtSauvegarderHeures(db, id) {
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Feuille de temps introuvable' };
  const row = r.rows[0];

  async function marquerErreur(message) {
    console.error('[heures] Echec correction', id, ':', message);
    try {
      await db.execute({
        sql: `UPDATE feuilles_temps SET statut = 'erreur', generation_statut = 'erreur', generation_erreur = ? WHERE id = ?`,
        args: [message, id],
      });
    } catch (_) {}
    return { ok: false, erreur: message };
  }

  try {
    const buffer = await downloadBuffer(BUCKETS.UPLOADS_TEMP, row.fichier_source_key);
    if (!buffer) return marquerErreur('fichier source introuvable dans le stockage temporaire (a peut-etre expire)');

    const mapping = { [row.onglet_source]: { debut: row.semaine_debut, fin: row.semaine_fin } };
    const resultats = await corrigerDepot(buffer, mapping);
    const resultat = resultats.find(r => r.nomOnglet === row.onglet_source);
    if (!resultat || resultat.erreur) return marquerErreur((resultat && resultat.erreur) || 'correction impossible');

    const cle = `${id}-${resultat.labelSemaine.replace(/[^A-Za-z0-9-]/g, '_')}.xlsx`;
    await uploadBuffer(BUCKETS.HEURES_CORRIGEES, cle, resultat.fichier, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await db.execute({
      sql: `UPDATE feuilles_temps SET
        statut = 'a_valider',
        fichier_corrige_key = ?,
        lignes_corrigees = ?,
        lignes_ignorees = ?,
        codes_a_confirmer = ?,
        generation_statut = 'termine', generation_erreur = NULL,
        updated_at = datetime('now')
        WHERE id = ?`,
      args: [cle, JSON.stringify({ nbLignes: resultat.nbLignes }), JSON.stringify(resultat.lignesExclues), JSON.stringify(resultat.codesAConfirmer), id],
    });

    try { await envoyerNotificationEtape(1, [row]); } catch (e) { console.error('[heures] notification etape 1 echouee (non bloquant):', e.message); }

    return { ok: true };
  } catch (e) {
    return marquerErreur(e.message);
  }
}

// Bootstrap (une seule fois) : importe la copie actuelle de "Feuilles
// Maître heures - 2026.xlsx" sur Supabase (bucket HEURES_MAITRES) — elle
// devient ensuite LE fichier de reference que la plateforme met a jour elle-
// meme (voir plan : "le resultat final sera sur la plateforme"). A refaire
// seulement si on veut resynchroniser manuellement depuis OneDrive.
router.post('/admin/importer-maitre', async (req, res) => {
  const { fichier_key } = req.body || {};
  if (!cleTempValide(fichier_key)) return res.status(400).send('Fichier invalide.');
  const buffer = await downloadBuffer(BUCKETS.UPLOADS_TEMP, fichier_key);
  if (!buffer) return res.status(404).send('Fichier introuvable.');
  await uploadBuffer(BUCKETS.HEURES_MAITRES, MASTER_KEY, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.redirect('/heures');
});

// Etape 2 : ajoute la semaine (validee a l'etape 1) dans le fichier maitre.
// Toujours synchrone (pas de Render pour ce module). Le fichier maitre etant
// gros (~9000 lignes), on accepte le cout en temps sur la fonction Vercel —
// a surveiller si ca approche les 60s en usage reel.
async function appliquerEtape2(db, id) {
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Feuille de temps introuvable' };
  const row = r.rows[0];

  async function marquerErreur(message) {
    console.error('[heures] Echec etape 2', id, ':', message);
    try {
      await db.execute({ sql: `UPDATE feuilles_temps SET statut = 'erreur', generation_erreur = ? WHERE id = ?`, args: [message, id] });
    } catch (_) {}
    return { ok: false, erreur: message };
  }

  try {
    const bufferCorrige = await downloadBuffer(BUCKETS.HEURES_CORRIGEES, row.fichier_corrige_key);
    if (!bufferCorrige) return marquerErreur('fichier corrigé introuvable');
    const bufferMaitre = await downloadBuffer(BUCKETS.HEURES_MAITRES, MASTER_KEY);
    if (!bufferMaitre) return marquerErreur(`fichier maître non initialisé — utiliser /heures/admin/importer-maitre (clé attendue: ${MASTER_KEY})`);

    const { buffer, nbLignesAjoutees } = await ajouterSemaineDansMaitre(bufferMaitre, bufferCorrige, { debut: row.semaine_debut, fin: row.semaine_fin });
    await uploadBuffer(BUCKETS.HEURES_MAITRES, MASTER_KEY, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await db.execute({
      sql: `UPDATE feuilles_temps SET etape = 2, statut = 'ajoute_maitre', updated_at = datetime('now') WHERE id = ?`,
      args: [id],
    });
    console.log(`[heures] etape 2 OK pour ${id} : ${nbLignesAjoutees} ligne(s) ajoutee(s) au fichier maitre`);

    try { await envoyerNotificationEtape(2, [row]); } catch (e) { console.error('[heures] notification etape 2 echouee (non bloquant):', e.message); }
    return { ok: true, nbLignesAjoutees };
  } catch (e) {
    return marquerErreur(e.message);
  }
}

router.get('/:id/telecharger-maitre', async (req, res) => {
  const url = await createSignedUrl(BUCKETS.HEURES_MAITRES, MASTER_KEY, 300, MASTER_KEY);
  res.redirect(url);
});

// Bootstrap (une seule fois) pour ABCD-COPIE.xlsx — meme principe que
// /admin/importer-maitre.
router.post('/admin/importer-suivi', async (req, res) => {
  const { fichier_key } = req.body || {};
  if (!cleTempValide(fichier_key)) return res.status(400).send('Fichier invalide.');
  const buffer = await downloadBuffer(BUCKETS.UPLOADS_TEMP, fichier_key);
  if (!buffer) return res.status(404).send('Fichier introuvable.');
  await uploadBuffer(BUCKETS.HEURES_MAITRES, SUIVI_KEY, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.redirect('/heures');
});

// Etape 3 : ajoute la semaine dans ABCD-COPIE.xlsx (repartition par metier
// via categorie_employe) + controle de coherence obligatoire (le total
// ecrit doit correspondre au total brut classifiable de la semaine — jamais
// de publication silencieuse en cas d'ecart, voir plan).
async function appliquerEtape3(db, id) {
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Feuille de temps introuvable' };
  const row = r.rows[0];

  async function marquerErreur(message) {
    console.error('[heures] Echec etape 3', id, ':', message);
    try {
      await db.execute({ sql: `UPDATE feuilles_temps SET statut = 'erreur', generation_erreur = ? WHERE id = ?`, args: [message, id] });
    } catch (_) {}
    return { ok: false, erreur: message };
  }

  try {
    const bufferCorrige = await downloadBuffer(BUCKETS.HEURES_CORRIGEES, row.fichier_corrige_key);
    if (!bufferCorrige) return marquerErreur('fichier corrigé introuvable');
    const bufferSuivi = await downloadBuffer(BUCKETS.HEURES_MAITRES, SUIVI_KEY);
    if (!bufferSuivi) return marquerErreur(`fichier de suivi non initialisé — utiliser /heures/admin/importer-suivi (clé attendue: ${SUIVI_KEY})`);

    const { buffer, totalEcrit, totalAClasser, totalNonClasse } = await ajouterSemaineDansSuivi(bufferSuivi, bufferCorrige, { debut: row.semaine_debut, fin: row.semaine_fin });

    const ecart = Math.round((totalEcrit - totalAClasser) * 100) / 100;
    if (Math.abs(ecart) > 0.1) {
      return marquerErreur(`Écart de cohérence détecté : ${totalEcrit}h écrites dans ABCD-COPIE.xlsx vs ${totalAClasser}h attendues (${row.semaine_debut} au ${row.semaine_fin}) — écriture annulée, rien n'a été publié.`);
    }

    await uploadBuffer(BUCKETS.HEURES_MAITRES, SUIVI_KEY, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const note = totalNonClasse > 0.1
      ? `${totalNonClasse}h non classées par métier (catégorie employé non reconnue) — non incluses dans ABCD-COPIE, à vérifier manuellement.`
      : null;

    await db.execute({
      sql: `UPDATE feuilles_temps SET etape = 3, statut = 'ajoute_suivi', generation_erreur = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [note, id],
    });
    return { ok: true };
  } catch (e) {
    return marquerErreur(e.message);
  }
}

router.get('/:id/telecharger-suivi', async (req, res) => {
  const url = await createSignedUrl(BUCKETS.HEURES_MAITRES, SUIVI_KEY, 300, SUIVI_KEY);
  res.redirect(url);
});

router.post('/:id/valider-etape2', async (req, res) => {
  const db = req.db;
  await db.execute({
    sql: `UPDATE feuilles_temps SET statut = 'valide_etape2', valide_etape2_par = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [req.session && req.session.utilisateur || '', req.params.id],
  });

  const resultat = await appliquerEtape3(db, req.params.id);
  if (!resultat.ok) console.error('[heures] etape 3 non declenchee automatiquement pour', req.params.id, ':', resultat.erreur);

  res.redirect('/heures/' + req.params.id);
});

// Confirmation finale (etape 3) : envoie le document final a jchoiniere et
// clot le cycle pour cette semaine — la plateforme redevient "rien a faire"
// jusqu'au prochain depot de Josiane (voir plan).
router.post('/:id/valider-etape3', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  if (r.rows.length === 0) return res.status(404).send('Introuvable');
  const row = r.rows[0];

  const lien = await createSignedUrl(BUCKETS.HEURES_MAITRES, SUIVI_KEY, 300, SUIVI_KEY);
  try { await envoyerDocumentFinal(lien, row); } catch (e) { console.error('[heures] envoi document final echoue (non bloquant):', e.message); }

  await db.execute({
    sql: `UPDATE feuilles_temps SET statut = 'termine', valide_etape3_par = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [req.session && req.session.utilisateur || '', row.id],
  });
  res.redirect('/heures/' + row.id);
});

// Etape 1b : Josiane a associe une semaine (debut/fin, format YYYY-MM-DD) a
// chaque onglet retenu — cree UNE ligne par onglet et lance la correction.
router.post('/deposer', async (req, res) => {
  const db = req.db;
  const { fichier_key, fichier_nom, mapping } = req.body || {};
  if (!cleTempValide(fichier_key)) return res.status(400).send('Fichier invalide.');
  let semaines;
  try { semaines = JSON.parse(mapping); } catch (_) { return res.status(400).send('Association des semaines invalide.'); }

  const idsCreees = [];
  for (const [onglet, semaine] of Object.entries(semaines || {})) {
    if (!semaine || !semaine.debut || !semaine.fin) continue;
    const ins = await db.execute({
      sql: `INSERT INTO feuilles_temps (semaine_debut, semaine_fin, fichier_source_key, fichier_source_nom, onglet_source, etape, statut, depose_par)
            VALUES (?, ?, ?, ?, ?, 1, 'en_cours', ?)`,
      args: [semaine.debut, semaine.fin, fichier_key, fichier_nom || '', onglet, req.session && req.session.utilisateur || ''],
    });
    idsCreees.push(ins.lastInsertRowid);
  }

  for (const id of idsCreees) {
    await genererEtSauvegarderHeures(db, id);
  }

  res.redirect('/heures');
});

// Relance apres une erreur (ex: bug corrige entre-temps) — sans re-upload,
// reutilise le meme fichier source deja en stockage temporaire.
router.post('/:id/relancer', async (req, res) => {
  const db = req.db;
  await db.execute({ sql: `UPDATE feuilles_temps SET statut = 'en_cours', generation_erreur = NULL WHERE id = ?`, args: [req.params.id] });
  const resultat = await genererEtSauvegarderHeures(db, req.params.id);
  if (!resultat.ok) console.error('[heures] relance echouee pour', req.params.id, ':', resultat.erreur);
  res.redirect('/heures/' + req.params.id);
});

router.get('/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  if (r.rows.length === 0) return res.status(404).send('Introuvable');
  res.render('heures-detail', { f: r.rows[0] });
});

router.get('/:id/telecharger', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  if (r.rows.length === 0 || !r.rows[0].fichier_corrige_key) return res.status(404).send('Fichier corrigé non disponible.');
  const url = await createSignedUrl(BUCKETS.HEURES_CORRIGEES, r.rows[0].fichier_corrige_key, 300, `${r.rows[0].semaine_debut}_au_${r.rows[0].semaine_fin}.xlsx`);
  res.redirect(url);
});

// L'utilisateur re-uploade la version corrigee a la main (dest=temp) puis
// valide : remplace le fichier corrige stocke et passe a l'etape suivante —
// jamais d'ecriture directe dans les fichiers maitres avant cette validation
// humaine explicite (voir plan, decision "telecharger/modifier/re-uploader").
router.post('/:id/valider-etape1', async (req, res) => {
  const db = req.db;
  const { fichier_key } = req.body || {};
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  if (r.rows.length === 0) return res.status(404).send('Introuvable');
  const row = r.rows[0];

  if (fichier_key && cleTempValide(fichier_key)) {
    const buffer = await downloadBuffer(BUCKETS.UPLOADS_TEMP, fichier_key);
    if (buffer) await uploadBuffer(BUCKETS.HEURES_CORRIGEES, row.fichier_corrige_key, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  await db.execute({
    sql: `UPDATE feuilles_temps SET statut = 'valide_etape1', valide_etape1_par = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [req.session && req.session.utilisateur || '', row.id],
  });

  const resultat = await appliquerEtape2(db, row.id);
  if (!resultat.ok) console.error('[heures] etape 2 non declenchee automatiquement pour', row.id, ':', resultat.erreur);

  res.redirect('/heures/' + row.id);
});

module.exports = router;
module.exports.genererEtSauvegarderHeures = genererEtSauvegarderHeures;
