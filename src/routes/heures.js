const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { downloadBuffer, uploadBuffer, createSignedUrl, removeFile, BUCKETS } = require('../services/storage');
const { lireClasseurBrut, corrigerDepot } = require('../services/heures-excel-writer');
const { MASTER_KEY, ajouterSemaineDansMaitre } = require('../services/heures-maitre-writer');
const { ajouterSemaineDansSuivi } = require('../services/heures-suivi-writer');
const { envoyerNotificationEtape, envoyerDocumentFinal, DESTINATAIRES_FINAL_POSSIBLES } = require('../services/heures-email');

const SUIVI_KEY = 'ABCD-COPIE.xlsx';

// DIAGNOSTIC TEMPORAIRE — tente un vrai envoi Resend et RENVOIE l'erreur
// exacte. A retirer une fois le diagnostic termine.
router.get('/admin/diagnostic-resend', async (req, res) => {
  if (!process.env.RESEND_API_KEY) return res.json({ ok: false, erreur: 'RESEND_API_KEY manquante' });
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'T3E Interface <onboarding@resend.dev>',
        to: ['projets@toiturestroisetoiles.com'],
        subject: 'T3E Interface — Test diagnostic Resend',
        text: 'Ceci est un test de diagnostic. Si vous recevez ce message, la configuration Resend fonctionne.',
      }),
    });
    const corps = await resp.text();
    res.json({ ok: resp.ok, status: resp.status, corps });
  } catch (e) {
    res.json({ ok: false, erreur: e.message });
  }
});

// UNE SEULE sauvegarde par fichier — l'etat d'ORIGINE, tel qu'il etait
// avant que la plateforme ne commence a le modifier. Jamais de nouvelle
// copie a chaque semaine (ca polluerait le stockage) : la copie
// "sauvegardes/original-{cle}" n'est creee que la toute premiere fois
// (si elle n'existe pas deja), puis conservee telle quelle indefiniment —
// le fichier de travail (MASTER_KEY/SUIVI_KEY), lui, evolue normalement
// chaque semaine.
async function sauvegarderOriginalSiAbsent(cle, buffer) {
  const cleBackup = `sauvegardes/original-${cle}`;
  try {
    const dejaPresent = await downloadBuffer(BUCKETS.HEURES_MAITRES, cleBackup);
    if (dejaPresent) return;
    await uploadBuffer(BUCKETS.HEURES_MAITRES, cleBackup, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  } catch (e) {
    console.error('[heures] sauvegarde de l\'original echouee (non bloquant):', e.message);
  }
}

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
async function appliquerEtape2(db, id, options) {
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Feuille de temps introuvable' };
  const row = r.rows[0];

  async function marquerErreur(message, doublon) {
    console.error('[heures] Echec etape 2', id, ':', message);
    try {
      await db.execute({ sql: `UPDATE feuilles_temps SET statut = 'erreur', generation_erreur = ? WHERE id = ?`, args: [message, id] });
    } catch (_) {}
    return { ok: false, erreur: message, doublon: !!doublon };
  }

  try {
    const bufferCorrige = await downloadBuffer(BUCKETS.HEURES_CORRIGEES, row.fichier_corrige_key);
    if (!bufferCorrige) return marquerErreur('fichier corrigé introuvable');
    const bufferMaitre = await downloadBuffer(BUCKETS.HEURES_MAITRES, MASTER_KEY);
    if (!bufferMaitre) return marquerErreur(`fichier maître non initialisé — utiliser /heures/admin/importer-maitre (clé attendue: ${MASTER_KEY})`);

    const { buffer, nbLignesAjoutees } = await ajouterSemaineDansMaitre(bufferMaitre, bufferCorrige, { debut: row.semaine_debut, fin: row.semaine_fin }, options);
    // On ne remplace le fichier de reference qu'apres avoir construit AVEC
    // SUCCES la nouvelle version en memoire (bufferMaitre original jamais
    // modifie en place — ajouterSemaineDansMaitre travaille sur sa propre
    // copie JSZip) — et on sauvegarde la version actuelle juste avant, au
    // cas ou.
    await sauvegarderOriginalSiAbsent(MASTER_KEY, bufferMaitre);
    await uploadBuffer(BUCKETS.HEURES_MAITRES, MASTER_KEY, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await db.execute({
      sql: `UPDATE feuilles_temps SET etape = 2, statut = 'ajoute_maitre', updated_at = datetime('now') WHERE id = ?`,
      args: [id],
    });
    console.log(`[heures] etape 2 OK pour ${id} : ${nbLignesAjoutees} ligne(s) ajoutee(s) au fichier maitre`);

    try { await envoyerNotificationEtape(2, [row]); } catch (e) { console.error('[heures] notification etape 2 echouee (non bloquant):', e.message); }
    return { ok: true, nbLignesAjoutees };
  } catch (e) {
    return marquerErreur(e.message, e.doublon);
  }
}

// Relance l'etape 2 — avec confirmation="1" pour forcer malgre un doublon
// deja detecte (ex : semaine de test deja ajoutee manuellement — cas
// legitime confirme par l'utilisateur apres avoir consulte le fichier).
router.post('/:id/relancer-etape2', async (req, res) => {
  const db = req.db;
  const options = req.body && req.body.confirmer === '1' ? { ignorerDoublon: true } : undefined;
  const resultat = await appliquerEtape2(db, req.params.id, options);
  if (!resultat.ok) console.error('[heures] relance etape 2 echouee pour', req.params.id, ':', resultat.erreur);
  res.redirect('/heures/' + req.params.id);
});

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
async function appliquerEtape3(db, id, options) {
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Feuille de temps introuvable' };
  const row = r.rows[0];

  async function marquerErreur(message, doublon) {
    console.error('[heures] Echec etape 3', id, ':', message);
    try {
      await db.execute({ sql: `UPDATE feuilles_temps SET statut = 'erreur', generation_erreur = ? WHERE id = ?`, args: [message, id] });
    } catch (_) {}
    return { ok: false, erreur: message, doublon: !!doublon };
  }

  // Passer sans ecrire (semaine deja presente, confirme par l'utilisateur
  // apres avoir consulte le fichier) : contrairement a la Feuille Maitre,
  // il est IMPOSSIBLE de "forcer" une ecriture ici sans corrompre le
  // Tableau (deux colonnes de meme nom) — on marque simplement l'etape
  // comme deja couverte, sans toucher au fichier.
  if (options && options.ignorerDoublon) {
    await db.execute({
      sql: `UPDATE feuilles_temps SET etape = 3, statut = 'ajoute_suivi', generation_erreur = ? WHERE id = ?`,
      args: [`Semaine déjà présente dans ABCD-COPIE.xlsx — passage à la révision sans nouvelle écriture (confirmé manuellement).`, id],
    });
    return { ok: true, ignoree: true };
  }

  try {
    const bufferCorrige = await downloadBuffer(BUCKETS.HEURES_CORRIGEES, row.fichier_corrige_key);
    if (!bufferCorrige) return marquerErreur('fichier corrigé introuvable');
    const bufferSuivi = await downloadBuffer(BUCKETS.HEURES_MAITRES, SUIVI_KEY);
    if (!bufferSuivi) return marquerErreur(`fichier de suivi non initialisé — utiliser /heures/admin/importer-suivi (clé attendue: ${SUIVI_KEY})`);

    const { buffer, totalEcrit, totalAClasser, totalNonClasse, projetsNonTrouves } = await ajouterSemaineDansSuivi(bufferSuivi, bufferCorrige, { debut: row.semaine_debut, fin: row.semaine_fin });

    const ecart = Math.round((totalEcrit - totalAClasser) * 100) / 100;
    if (Math.abs(ecart) > 0.1) {
      const detailProjets = projetsNonTrouves && projetsNonTrouves.length
        ? ` Projet(s) absent(s) de ABCD-COPIE.xlsx (à ajouter manuellement si besoin) : ${projetsNonTrouves.join(', ')}.`
        : '';
      return marquerErreur(`Écart de cohérence détecté : ${totalEcrit}h écrites dans ABCD-COPIE.xlsx vs ${totalAClasser}h attendues (${row.semaine_debut} au ${row.semaine_fin}) — écriture annulée, rien n'a été publié.${detailProjets}`);
    }

    await sauvegarderOriginalSiAbsent(SUIVI_KEY, bufferSuivi);
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
    return marquerErreur(e.message, e.doublon);
  }
}

// Relance l'etape 3 (ex: apres avoir ajoute manuellement dans Excel un
// projet manquant signale par le controle de coherence, ou confirmer="1"
// pour passer sans ecrire malgre un doublon deja detecte).
router.post('/:id/relancer-etape3', async (req, res) => {
  const db = req.db;
  const options = req.body && req.body.confirmer === '1' ? { ignorerDoublon: true } : undefined;
  const resultat = await appliquerEtape3(db, req.params.id, options);
  if (!resultat.ok) console.error('[heures] relance etape 3 echouee pour', req.params.id, ':', resultat.erreur);
  res.redirect('/heures/' + req.params.id);
});

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
// jusqu'au prochain depot d'une feuille de temps (voir plan).
router.post('/:id/valider-etape3', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  if (r.rows.length === 0) return res.status(404).send('Introuvable');
  const row = r.rows[0];

  // Destinataires CHOISIS par Joel/projets sur le formulaire (demande
  // utilisateur — jamais d'envoi automatique a une liste fixe) — au moins
  // un destinataire valide requis, sinon on bloque plutot que de "confirmer"
  // silencieusement sans jamais avoir prevenu personne.
  const brut = req.body && req.body.destinataires;
  const cles = (Array.isArray(brut) ? brut : (brut ? [brut] : [])).filter(c => DESTINATAIRES_FINAL_POSSIBLES[c]);
  if (cles.length === 0) {
    return res.status(400).send('Veuillez sélectionner au moins un destinataire avant de confirmer. <a href="javascript:history.back()">Retour</a>');
  }

  const lien = await createSignedUrl(BUCKETS.HEURES_MAITRES, SUIVI_KEY, 300, SUIVI_KEY);
  // L'echec de l'envoi ne bloque PAS la confirmation (le fichier/la
  // decision restent valides independamment du courriel) — mais l'erreur
  // est desormais VISIBLE dans l'interface plutot qu'avalee silencieusement
  // (constate en test reel : un envoi echoue sans exception visible avait
  // laisse croire que le courriel etait parti alors que non).
  let erreurEnvoi = null;
  try { await envoyerDocumentFinal(lien, row, cles); } catch (e) {
    console.error('[heures] envoi document final echoue:', e.message);
    erreurEnvoi = `Le document est confirmé, mais l'envoi du courriel a échoué : ${e.message}`;
  }

  await db.execute({
    sql: `UPDATE feuilles_temps SET statut = 'termine', valide_etape3_par = ?, generation_erreur = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [req.session && req.session.utilisateur || '', erreurEnvoi, row.id],
  });
  res.redirect('/heures/' + row.id);
});

// Etape 1b : une semaine (debut/fin, format YYYY-MM-DD) a ete associee a
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

// Supprime un depot errone (ex: mauvaise correction, test) — retire la ligne
// et le fichier corrige associe (le fichier source brut, dans le bucket
// temporaire, reste — potentiellement partage avec d'autres semaines du
// meme depot). N'affecte JAMAIS la Feuille Maitre / le Suivi des heures :
// seules les lignes deja ecrites la-bas (etape >= 2) y restent, supprimer
// ici ne fait que retirer le suivi/brouillon de cette semaine sur la
// plateforme.
router.post('/:id/supprimer', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  if (r.rows.length > 0 && r.rows[0].fichier_corrige_key) {
    try { await removeFile(BUCKETS.HEURES_CORRIGEES, r.rows[0].fichier_corrige_key); } catch (_) {}
  }
  await db.execute({ sql: 'DELETE FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  res.redirect('/heures');
});

router.get('/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM feuilles_temps WHERE id = ?', args: [req.params.id] });
  if (r.rows.length === 0) return res.status(404).send('Introuvable');
  res.render('heures-detail', { f: r.rows[0], DESTINATAIRES_FINAL_POSSIBLES });
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
