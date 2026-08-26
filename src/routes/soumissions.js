const express = require('express');
const router = express.Router();
const { downloadBuffer, removeFile, createSignedUrl, BUCKETS } = require('../services/storage');
const { construireContexte } = require('../services/soumission-parser');
const { analyserProjetSoumissionPrivee, isConfigured } = require('../services/claude-client');
const { completerAvecVisionPlans } = require('../services/plan-vision');
const { TEMPLATE_MAP, LABELS_SYSTEME, genererSoumissionPrivee } = require('../services/soumission-filler');
const { estimerPrix } = require('../services/estimation-prix');

const CATEGORIES = ['appel_offre', 'devis', 'plans', 'addendas'];

// Cles generees exclusivement par /api/upload-url : jamais de separateur de chemin.
function cleTempValide(key) {
  return typeof key === 'string' && key.length > 0 && !key.includes('/') && !key.includes('..');
}

async function genererNumero(db) {
  const annee = new Date().getFullYear().toString().slice(-2);
  const r = await db.execute({
    sql: `SELECT numero FROM soumissions WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`,
    args: [`T3E-${annee}-%`],
  });
  let seq = 1;
  if (r.rows.length > 0) {
    const m = r.rows[0].numero.match(/-(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `T3E-${annee}-${String(seq).padStart(4, '0')}`;
}

router.get('/', async (req, res) => {
  const db = req.db;
  const { statut, q } = req.query;
  let sql = 'SELECT * FROM soumissions WHERE 1=1';
  const args = [];
  if (statut) { sql += ' AND statut = ?'; args.push(statut); }
  if (q) { sql += ' AND (client_nom LIKE ? OR projet_nom LIKE ? OR numero LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  const r = await db.execute({ sql, args });

  const stats = await db.execute(`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN statut = 'genere' THEN 1 ELSE 0 END) as generes,
    SUM(CASE WHEN statut = 'envoye' THEN 1 ELSE 0 END) as envoyes
    FROM soumissions`);

  res.render('soumissions', {
    soumissions: r.rows, stats: stats.rows[0], filtres: { statut: statut || '', q: q || '' },
  });
});

router.get('/nouveau', (req, res) => {
  res.render('soumission-nouveau', {
    systemes: Object.keys(TEMPLATE_MAP).map(k => ({ cle: k, label: LABELS_SYSTEME[k] || k })),
    iaConfiguree: isConfigured(),
    erreur: '',
  });
});

function rendreErreurNouveau(res, erreur) {
  return res.render('soumission-nouveau', {
    systemes: Object.keys(TEMPLATE_MAP).map(k => ({ cle: k, label: LABELS_SYSTEME[k] || k })),
    iaConfiguree: isConfigured(),
    erreur,
  });
}

// Delegue le traitement lourd (telechargement des documents, IA texte+vision,
// remplissage du gabarit) au service Render t3e-interface-jfxe — meme
// mecanique que declencherGenerationDistanteBordereaux (bordereaux.js) /
// genererEtSauvegarderManuel (manuels) : Render est un service persistant
// (pas une fonction a la demande), donc pas plafonne aux 60s d'une fonction
// Vercel. Necessaire des qu'un plan est fourni (declenche l'analyse
// visuelle) ou que plusieurs documents sont combines — constate en depassant
// systematiquement 60s dans ces cas (voir historique du fix budget/casse du
// marqueur de section).
async function declencherGenerationDistanteSoumission(id) {
  const url = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!url || !secret) throw new Error('service distant non configuré (CONVERT_SERVICE_URL/SECRET manquant)');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/internal/generer-soumission', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-convert-secret': secret },
      body: JSON.stringify({ soumissionId: id }),
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

// Traitement complet : relit la requete sauvegardee par POST /generer (ou
// POST /:id/relancer), telecharge les documents, appelle l'IA (texte puis
// vision si un plan est present), remplit le gabarit, et sauvegarde le
// resultat. Appelable en synchrone (local/Render direct) OU depuis
// /internal/generer-soumission (server.js, declenche a distance depuis
// Vercel) — meme fonction, memes effets de bord, jamais de logique dupliquee.
async function genererEtSauvegarderSoumission(db, id) {
  const r = await db.execute({ sql: 'SELECT * FROM soumissions WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Soumission introuvable' };
  const row = r.rows[0];

  async function marquerErreur(message) {
    console.error('[soumissions] Echec generation', id, ':', message);
    try {
      await db.execute({
        sql: `UPDATE soumissions SET generation_statut = 'erreur', generation_erreur = ? WHERE id = ?`,
        args: [message, id],
      });
    } catch (_) {}
    return { ok: false, erreur: message };
  }

  let requete;
  try { requete = JSON.parse(row.generation_requete || 'null'); } catch (_) { requete = null; }
  if (!requete || !Array.isArray(requete.fichiers) || requete.fichiers.length === 0) {
    return marquerErreur('Requête de génération introuvable (relancez la génération).');
  }
  const { systeme, langue, fichiers } = requete;

  // Telechargement + nettoyage du stockage temporaire (on ne garde que les
  // metadonnees dans documents_sources, pas les fichiers eux-memes).
  const documents = [];
  const documentsSources = [];
  for (const f of fichiers) {
    const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, f.cle);
    await removeFile(BUCKETS.UPLOADS_TEMP, f.cle).catch(() => {});
    if (!buf) continue;
    documents.push({ nom_fichier: f.nom, categorie: f.categorie, buffer: buf });
    documentsSources.push({ nom_fichier: f.nom, categorie: f.categorie });
  }
  if (documents.length === 0) {
    return marquerErreur('Aucun document valide retrouvé (fichiers temporaires déjà consommés — relancez depuis "Nouvelle soumission").');
  }

  const { contexte, documentsVides } = await construireContexte(documents);

  let champs = await analyserProjetSoumissionPrivee(contexte, systeme);
  if (champs.error) return marquerErreur("Erreur d'analyse IA : " + champs.error);

  // Analyse visuelle des plans (Chromium headless -> images -> vision IA) pour
  // combler les champs que le texte seul n'a pas trouves — jamais bloquant,
  // une erreur ici ne doit pas empecher la generation du document.
  const documentsPlans = documents.filter((d) => d.categorie === 'plans');
  if (documentsPlans.length > 0) {
    try {
      champs = await completerAvecVisionPlans(champs, documentsPlans, systeme);
    } catch (e) {
      console.error('[soumissions] Analyse visuelle des plans échouée (non bloquant):', e.message);
    }
  }

  let resultat;
  try {
    resultat = await genererSoumissionPrivee({ systeme, langue, champs, numero: row.numero });
  } catch (e) {
    return marquerErreur('Erreur de génération du document : ' + e.message);
  }

  // Estimation de prix INDICATIVE (taux de marché génériques, pas les coûts
  // T3E) — jamais écrite dans prix_total ni dans le .docx, uniquement une
  // suggestion affichée à part sur la page de la soumission. Non bloquante :
  // sans superficie extraite, estimerPrix() retourne simplement null.
  let estimation = null;
  try {
    estimation = estimerPrix(champs, systeme);
  } catch (e) {
    console.error('[soumissions] Estimation de prix échouée (non bloquant):', e.message);
  }

  await db.execute({
    sql: `UPDATE soumissions SET
      client_nom = ?, projet_nom = ?, statut = 'genere',
      template_utilise = ?, fichier_genere = ?, champs_extraits = ?, documents_sources = ?,
      prix_estime_note = ?,
      generation_statut = 'termine', generation_erreur = NULL, updated_at = datetime('now')
      WHERE id = ?`,
    args: [
      (champs.client_nom && champs.client_nom.valeur) || 'Client sans nom',
      (champs.objet_projet && champs.objet_projet.valeur) || null,
      resultat.templateUsed, resultat.filename,
      JSON.stringify({ rapport: resultat.rapport, documentsVides }),
      JSON.stringify(documentsSources),
      estimation ? estimation.texte : null,
      id,
    ],
  });

  return { ok: true };
}

router.post('/generer', async (req, res) => {
  const db = req.db;
  const systeme = req.body.systeme;
  const langue = req.body.langue || 'FR';

  if (!TEMPLATE_MAP[systeme]) return rendreErreurNouveau(res, 'Système de toiture invalide.');
  if (!isConfigured()) return rendreErreurNouveau(res, "L'extraction automatique nécessite OPENAI_API_KEY (non configurée).");

  // Fichiers par categorie : cle temporaire unique (appel_offre) ou tableau (plans/addendas)
  const fichiersDemandes = [];
  for (const cat of CATEGORIES) {
    const cles = [].concat(req.body[cat + '_key'] || []).filter(cleTempValide);
    const noms = [].concat(req.body[cat + '_name'] || []);
    cles.forEach((cle, i) => fichiersDemandes.push({ cle, nom: noms[i] || cat, categorie: cat }));
  }
  if (fichiersDemandes.length === 0) {
    return rendreErreurNouveau(res, "Déposez au moins un document du projet (appel d'offre, devis, plans ou addenda) avant de générer la soumission.");
  }

  // Cree tout de suite la ligne (statut 'en_cours') pour avoir un id a passer
  // a Render, et pour que la liste/le detail affichent l'etat reel meme si
  // Render n'a pas encore commence ou si la fonction Vercel actuelle se
  // termine avant la fin du traitement.
  const numero = await genererNumero(db);
  const rInsert = await db.execute({
    sql: `INSERT INTO soumissions (numero, client_nom, systeme_toiture, type_travaux, langue, statut, generation_requete, generation_statut)
          VALUES (?, ?, ?, ?, ?, 'brouillon', ?, 'en_cours')`,
    args: [
      numero, 'Génération en cours…', systeme, systeme.includes('PLEUMAGE') ? 'PLEUMAGE' : 'REFECTION', langue,
      JSON.stringify({ systeme, langue, fichiers: fichiersDemandes }),
    ],
  });
  const id = rInsert.lastInsertRowid;

  if (process.env.VERCEL) {
    try {
      await declencherGenerationDistanteSoumission(id);
      return res.redirect('/soumissions/' + id);
    } catch (e) {
      console.error('[soumissions] Délégation Render impossible, tentative en local :', e.message);
      // On continue en synchrone plutot que d'echouer — une soumission avec
      // un seul petit document passe sous les 60s, et l'echec serait sinon
      // silencieux (la ligne resterait 'en_cours' pour rien).
    }
  }

  await genererEtSauvegarderSoumission(db, id);
  res.redirect('/soumissions/' + id);
});

// Relance la generation avec la MEME requete deja sauvegardee (ex: apres une
// erreur, ou un echec de delegation Render) — evite de devoir re-uploader
// les documents, qui ont deja ete consommes/supprimes d'uploads-temp lors
// d'une premiere tentative reussie jusqu'au bout.
router.post('/:id/relancer', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.redirect('/soumissions');

  await db.execute({ sql: `UPDATE soumissions SET generation_statut = 'en_cours', generation_erreur = NULL WHERE id = ?`, args: [id] });

  if (process.env.VERCEL) {
    try {
      await declencherGenerationDistanteSoumission(id);
      return res.redirect('/soumissions/' + id);
    } catch (e) {
      console.error('[soumissions] Délégation Render impossible (relance), tentative en local :', e.message);
    }
  }

  await genererEtSauvegarderSoumission(db, id);
  res.redirect('/soumissions/' + id);
});

router.get('/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.redirect('/soumissions');
  const r = await db.execute({ sql: 'SELECT * FROM soumissions WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.redirect('/soumissions');

  const soumission = r.rows[0];
  let champsExtraits = { rapport: [], documentsVides: [] };
  let documentsSources = [];
  try { champsExtraits = JSON.parse(soumission.champs_extraits || '{}'); } catch (_) {}
  try { documentsSources = JSON.parse(soumission.documents_sources || '[]'); } catch (_) {}

  res.render('soumission-detail', {
    soumission,
    rapport: champsExtraits.rapport || [],
    documentsVides: champsExtraits.documentsVides || [],
    documentsSources,
    labelSysteme: LABELS_SYSTEME[soumission.systeme_toiture] || soumission.systeme_toiture,
  });
});

router.get('/:id/telecharger', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT fichier_genere FROM soumissions WHERE id = ?', args: [id] });
  if (r.rows.length === 0 || !r.rows[0].fichier_genere) return res.redirect('/soumissions');
  const url = await createSignedUrl(BUCKETS.SOUMISSIONS_GENEREES, r.rows[0].fichier_genere, 300, r.rows[0].fichier_genere);
  res.redirect(url);
});

router.post('/:id/supprimer', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT fichier_genere FROM soumissions WHERE id = ?', args: [id] });
  if (r.rows.length > 0 && r.rows[0].fichier_genere) {
    await removeFile(BUCKETS.SOUMISSIONS_GENEREES, r.rows[0].fichier_genere).catch(() => {});
  }
  await db.execute({ sql: 'DELETE FROM soumissions WHERE id = ?', args: [id] });
  res.redirect('/soumissions');
});

module.exports = router;
// Exposée pour l'endpoint interne /internal/generer-soumission (server.js) —
// même mécanique que genererEtSauvegarderBordereaux (bordereaux.js).
module.exports.genererEtSauvegarderSoumission = genererEtSauvegarderSoumission;
