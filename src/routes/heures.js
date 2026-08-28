const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { downloadBuffer, uploadBuffer, createSignedUrl, removeFile, BUCKETS } = require('../services/storage');
const { lireClasseurBrut, corrigerDepot } = require('../services/heures-excel-writer');
const { envoyerNotificationEtape } = require('../services/heures-email');

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

// Delegue le traitement (lecture du brut, correction, ecriture du fichier
// cible) au service Render t3e-interface-jfxe — meme mecanique que
// declencherGenerationDistanteSoumission (soumissions.js) : Render est
// persistant (pas de plafond 60s), utile des que le fichier brut est gros ou
// contient plusieurs semaines.
async function declencherGenerationDistanteHeures(id) {
  const url = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!url || !secret) throw new Error('service distant non configuré (CONVERT_SERVICE_URL/SECRET manquant)');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/internal/generer-heures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-convert-secret': secret },
      body: JSON.stringify({ feuilleTempsId: id }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const corps = await resp.text().catch(() => '');
      throw new Error(`service distant a répondu ${resp.status}: ${corps.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Traitement complet de l'etape 1 pour UNE ligne (= un onglet/semaine deja
// associe) : retelecharge le fichier brut, corrige SEULEMENT l'onglet
// concerne, sauvegarde le resultat. Appelable en synchrone ou depuis
// /internal/generer-heures (server.js, declenche a distance depuis Vercel).
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
    const [resultat] = await corrigerDepot(buffer, mapping);
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
    if (process.env.VERCEL) {
      try { await declencherGenerationDistanteHeures(id); continue; } catch (e) {
        console.error('[heures] delegation Render echouee, fallback synchrone:', e.message);
      }
    }
    await genererEtSauvegarderHeures(db, id);
  }

  res.redirect('/heures');
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
  res.redirect('/heures/' + row.id);
});

module.exports = router;
module.exports.genererEtSauvegarderHeures = genererEtSauvegarderHeures;
