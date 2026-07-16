// Module « plans tel que construit » (as-built) — production semi-automatique
// de plans annotés à partir des documents de chantier. Flux : création de
// projet → import classé des documents → analyse IA (extractions TOUJOURS
// liées à leur source) → registre des modifications proposées → validation
// humaine obligatoire → annotation des plans → rapport final.
// AUCUN plan n'est déclaré « tel que construit final » sans validation humaine.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const router = express.Router();
const {
  BUCKETS, ensureBucket, uploadBuffer, downloadBuffer, removeFile,
  createSignedUrl, sanitizeKey,
} = require('../services/storage');

// ── Référentiels du module ───────────────────────────────────────────────────
const CATEGORIES = {
  plan_initial: 'Plan initial',
  devis: 'Devis',
  avenant: 'Avenant',
  directive: 'Directive de chantier',
  ordre_changement: 'Ordre de changement',
  rapport_journalier: 'Rapport journalier',
  demande_information: "Demande d'information (DDI/RFI)",
  dessin_atelier: "Dessin d'atelier",
  photo: 'Photo de chantier',
  plan_annote: 'Plan annoté',
  releve_chantier: 'Relevé de chantier',
  autre: 'Autre',
};

const DISCIPLINES = ['architecture', 'structure', 'mécanique', 'électricité', 'plomberie', 'toiture', 'civil', 'autre'];

const STATUTS_PROJET = {
  nouveau: { label: 'Nouveau', badge: 'secondary' },
  documents: { label: 'Documents à importer', badge: 'info' },
  analyse: { label: 'Analyse en cours', badge: 'primary' },
  revision: { label: 'Révision requise', badge: 'warning text-dark' },
  annotation: { label: 'Prêt pour annotation', badge: 'success' },
  termine: { label: 'Terminé', badge: 'dark' },
};

const STATUTS_MODIFICATION = {
  detectee: { label: 'Détectée', badge: 'secondary' },
  a_verifier: { label: 'À vérifier', badge: 'warning text-dark' },
  approuvee: { label: 'Approuvée', badge: 'success' },
  refusee: { label: 'Refusée', badge: 'danger' },
  a_clarifier: { label: 'À clarifier', badge: 'info' },
  annotee: { label: 'Annotée', badge: 'primary' },
  integree: { label: 'Intégrée au plan final', badge: 'dark' },
};

const TYPES_MODIFICATION = {
  ajout: 'Ajout',
  suppression: 'Suppression',
  deplacement: 'Déplacement',
  dimension: 'Changement de dimension',
  materiau: 'Changement de matériau',
  quantite: 'Changement de quantité',
  equipement: "Changement d'équipement",
  detail: 'Changement de détail',
  contradiction: 'Information contradictoire',
  info_manquante: 'Information manquante',
};

function parseJson(valeur, defaut) {
  try { const v = JSON.parse(valeur); return v === null || v === undefined ? defaut : v; } catch (_) { return defaut; }
}

async function chargerProjet(db, id) {
  const r = await db.execute({ sql: 'SELECT * FROM asbuilt_projets WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return null;
  const p = r.rows[0];
  p.disciplines_liste = parseJson(p.disciplines, []);
  return p;
}

// Persistance uploads-temp → bucket plans-asbuilt (même patron que
// persisterCategorie des manuels : la clé temp n'a jamais de séparateur).
function cleTempValide(key) {
  return typeof key === 'string' && key.length > 0 && !key.includes('/') && !key.includes('..');
}

async function persisterFichier(projetId, categorie, tempKey, nomOriginal) {
  if (!cleTempValide(tempKey)) return null;
  const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, tempKey);
  if (!buf) return null;
  const nom = nomOriginal || tempKey;
  const key = sanitizeKey(`${projetId}/${categorie}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${path.basename(nom)}`);
  await ensureBucket(BUCKETS.PLANS_ASBUILT);
  await uploadBuffer(BUCKETS.PLANS_ASBUILT, key, buf, 'application/octet-stream');
  await removeFile(BUCKETS.UPLOADS_TEMP, tempKey).catch(() => {});
  return { key, nom, taille: buf.length };
}

// ── Tableau de bord ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const projets = (await req.db.execute(
    `SELECT p.*,
       (SELECT COUNT(*) FROM asbuilt_documents d WHERE d.projet_id = p.id AND d.categorie IN ('plan_initial','plan_annote')) AS nb_plans,
       (SELECT COUNT(*) FROM asbuilt_documents d WHERE d.projet_id = p.id) AS nb_documents,
       (SELECT COUNT(*) FROM asbuilt_modifications m WHERE m.projet_id = p.id) AS nb_modifications,
       (SELECT COUNT(*) FROM asbuilt_modifications m WHERE m.projet_id = p.id AND m.statut IN ('detectee','a_verifier','a_clarifier')) AS nb_a_valider
     FROM asbuilt_projets p
     ORDER BY p.created_at DESC`
  )).rows;
  res.render('asbuilt-dashboard', { projets, STATUTS_PROJET });
});

// ── Création de projet ───────────────────────────────────────────────────────
router.get('/nouveau', (req, res) => {
  res.render('asbuilt-nouveau', { DISCIPLINES });
});

router.post('/nouveau', express.urlencoded({ extended: true }), async (req, res) => {
  const nom = (req.body.nom || '').trim();
  if (!nom) return res.redirect('/asbuilt/nouveau');
  const disciplines = [].concat(req.body.disciplines || []);
  const r = await req.db.execute({
    sql: `INSERT INTO asbuilt_projets (numero, nom, client, adresse, description, responsable, disciplines, format_plans, notes, statut)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'documents')`,
    args: [
      (req.body.numero || '').trim(), nom, (req.body.client || '').trim(),
      (req.body.adresse || '').trim(), (req.body.description || '').trim(),
      (req.body.responsable || '').trim(), JSON.stringify(disciplines),
      (req.body.format_plans || '').trim(), (req.body.notes || '').trim(),
    ],
  });
  res.redirect('/asbuilt/projet/' + r.lastInsertRowid);
});

// ── Fiche projet (documents + import + accès registre) ──────────────────────
router.get('/projet/:id', async (req, res) => {
  const projet = await chargerProjet(req.db, parseInt(req.params.id));
  if (!projet) return res.redirect('/asbuilt');

  const documents = (await req.db.execute({
    sql: 'SELECT * FROM asbuilt_documents WHERE projet_id = ? ORDER BY categorie, created_at DESC',
    args: [projet.id],
  })).rows;

  const statsModifs = (await req.db.execute({
    sql: `SELECT statut, COUNT(*) AS n FROM asbuilt_modifications WHERE projet_id = ? GROUP BY statut`,
    args: [projet.id],
  })).rows;
  const totalModifs = statsModifs.reduce((s, r) => s + r.n, 0);
  const aValider = statsModifs.filter((r) => ['detectee', 'a_verifier', 'a_clarifier'].includes(r.statut)).reduce((s, r) => s + r.n, 0);

  res.render('asbuilt-projet', {
    projet, documents, CATEGORIES, STATUTS_PROJET, STATUTS_MODIFICATION,
    statsModifs, totalModifs, aValider,
    analyseConfiguree: !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY,
  });
});

// ── Import de documents (clés temp déjà uploadées par le navigateur) ────────
router.post('/projet/:id/documents', express.urlencoded({ extended: true }), async (req, res) => {
  const projet = await chargerProjet(req.db, parseInt(req.params.id));
  if (!projet) return res.status(404).send('Projet introuvable');

  const categorie = CATEGORIES[req.body.categorie] ? req.body.categorie : 'autre';
  const cles = [].concat(req.body.fichier_key || []);
  const noms = [].concat(req.body.fichier_name || []);

  const persistes = (await Promise.all(
    cles.map((cle, i) => persisterFichier(projet.id, categorie, cle, noms[i]))
  )).filter(Boolean);

  for (const f of persistes) {
    await req.db.execute({
      sql: `INSERT INTO asbuilt_documents (projet_id, nom, categorie, type_fichier, date_document, version, auteur, cle_stockage, taille_octets)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        projet.id, f.nom, categorie,
        path.extname(f.nom).replace('.', '').toLowerCase() || null,
        (req.body.date_document || '').trim() || null,
        (req.body.version || '').trim() || null,
        (req.body.auteur || '').trim() || null,
        f.key, f.taille,
      ],
    });
  }

  // Un projet qui reçoit ses premiers documents passe de « nouveau » à
  // « documents à importer » ; le passage à « analyse » se fait au lancement.
  if (projet.statut === 'nouveau') {
    await req.db.execute({ sql: `UPDATE asbuilt_projets SET statut = 'documents', updated_at = datetime('now') WHERE id = ?`, args: [projet.id] });
  }

  res.redirect('/asbuilt/projet/' + projet.id);
});

// ── Ouvrir le fichier source (traçabilité : toujours accessible) ────────────
router.get('/document/:id/fichier', async (req, res) => {
  const r = await req.db.execute({ sql: 'SELECT * FROM asbuilt_documents WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.status(404).send('Document introuvable');
  try {
    const url = await createSignedUrl(BUCKETS.PLANS_ASBUILT, r.rows[0].cle_stockage, 600);
    res.redirect(url);
  } catch (e) {
    res.status(404).send('Fichier introuvable dans le stockage.');
  }
});

router.post('/document/:id/supprimer', async (req, res) => {
  const r = await req.db.execute({ sql: 'SELECT * FROM asbuilt_documents WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.redirect('/asbuilt');
  const doc = r.rows[0];
  await removeFile(BUCKETS.PLANS_ASBUILT, doc.cle_stockage).catch(() => {});
  await req.db.execute({ sql: 'DELETE FROM asbuilt_annotations WHERE document_id = ?', args: [doc.id] }).catch(() => {});
  await req.db.execute({ sql: 'DELETE FROM asbuilt_documents WHERE id = ?', args: [doc.id] });
  res.redirect('/asbuilt/projet/' + doc.projet_id);
});

router.post('/projet/:id/statut', express.urlencoded({ extended: true }), async (req, res) => {
  const id = parseInt(req.params.id);
  const statut = STATUTS_PROJET[req.body.statut] ? req.body.statut : null;
  if (statut) {
    await req.db.execute({ sql: `UPDATE asbuilt_projets SET statut = ?, updated_at = datetime('now') WHERE id = ?`, args: [statut, id] });
  }
  res.redirect('/asbuilt/projet/' + id);
});

router.post('/projet/:id/supprimer', async (req, res) => {
  const id = parseInt(req.params.id);
  const docs = (await req.db.execute({ sql: 'SELECT cle_stockage FROM asbuilt_documents WHERE projet_id = ?', args: [id] })).rows;
  for (const d of docs) await removeFile(BUCKETS.PLANS_ASBUILT, d.cle_stockage).catch(() => {});
  await req.db.execute({ sql: 'DELETE FROM asbuilt_annotations WHERE projet_id = ?', args: [id] }).catch(() => {});
  await req.db.execute({ sql: 'DELETE FROM asbuilt_modifications WHERE projet_id = ?', args: [id] });
  await req.db.execute({ sql: 'DELETE FROM asbuilt_documents WHERE projet_id = ?', args: [id] });
  await req.db.execute({ sql: 'DELETE FROM asbuilt_projets WHERE id = ?', args: [id] });
  res.redirect('/asbuilt');
});

// ── Analyse IA (arrière-plan sur Render — même patron anti-504 que les
//    manuels et bordereaux : Vercel plafonne à 60 s, l'analyse de N documents
//    peut prendre plusieurs minutes) ─────────────────────────────────────────
async function declencherAnalyseDistante(projetId) {
  const url = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!url || !secret) throw new Error('service distant non configuré');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/internal/asbuilt-analyser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-convert-secret': secret },
      body: JSON.stringify({ projetId }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`service distant a répondu ${resp.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

router.post('/projet/:id/analyser', async (req, res) => {
  const projet = await chargerProjet(req.db, parseInt(req.params.id));
  if (!projet) return res.status(404).send('Projet introuvable');

  await req.db.execute({ sql: `UPDATE asbuilt_projets SET statut = 'analyse', updated_at = datetime('now') WHERE id = ?`, args: [projet.id] });

  if (process.env.VERCEL) {
    try {
      await declencherAnalyseDistante(projet.id);
      return res.redirect('/asbuilt/projet/' + projet.id);
    } catch (e) {
      console.error('[asbuilt] Délégation Render impossible, analyse locale :', e.message);
    }
  }

  const { analyserProjetAsbuilt } = require('../services/asbuilt-analyste');
  await analyserProjetAsbuilt(req.db, projet.id);
  res.redirect('/asbuilt/projet/' + projet.id + '/registre');
});

// ── Registre des modifications ───────────────────────────────────────────────
router.get('/projet/:id/registre', async (req, res) => {
  const projet = await chargerProjet(req.db, parseInt(req.params.id));
  if (!projet) return res.redirect('/asbuilt');

  const filtreStatut = STATUTS_MODIFICATION[req.query.statut] ? req.query.statut : null;
  const filtreType = TYPES_MODIFICATION[req.query.type] ? req.query.type : null;

  let sql = `SELECT m.*, d.nom AS document_nom, d.categorie AS document_categorie
             FROM asbuilt_modifications m
             LEFT JOIN asbuilt_documents d ON d.id = m.document_id
             WHERE m.projet_id = ?`;
  const args = [projet.id];
  if (filtreStatut) { sql += ' AND m.statut = ?'; args.push(filtreStatut); }
  if (filtreType) { sql += ' AND m.type = ?'; args.push(filtreType); }
  sql += ` ORDER BY CASE m.statut WHEN 'detectee' THEN 0 WHEN 'a_verifier' THEN 1 WHEN 'a_clarifier' THEN 2 ELSE 3 END, m.confiance DESC, m.id`;

  const modifications = (await req.db.execute({ sql, args })).rows;
  modifications.forEach((m) => {
    m.references_liste = parseJson(m.references_connexes, []);
    m.preuve = parseJson(m.preuve_execution, null);
  });

  res.render('asbuilt-registre', {
    projet, modifications, CATEGORIES, STATUTS_PROJET, STATUTS_MODIFICATION, TYPES_MODIFICATION,
    filtreStatut, filtreType,
  });
});

// ── Écran de validation d'une modification ───────────────────────────────────
router.get('/modification/:id', async (req, res) => {
  const r = await req.db.execute({
    sql: `SELECT m.*, d.nom AS document_nom, d.categorie AS document_categorie, d.type_fichier AS document_type
          FROM asbuilt_modifications m
          LEFT JOIN asbuilt_documents d ON d.id = m.document_id
          WHERE m.id = ?`,
    args: [parseInt(req.params.id)],
  });
  if (r.rows.length === 0) return res.redirect('/asbuilt');
  const modif = r.rows[0];
  modif.references_liste = parseJson(modif.references_connexes, []);
  modif.preuve = parseJson(modif.preuve_execution, null);

  const projet = await chargerProjet(req.db, modif.projet_id);

  // Vérification des références connexes : les autres documents du projet qui
  // mentionnent le même élément ou la même feuille (impacts croisés à
  // vérifier avant d'approuver — ex. une unité mécanique supprimée du plan de
  // toiture peut apparaître aussi aux plans mécanique/électrique/structural).
  const documents = (await req.db.execute({
    sql: `SELECT id, nom, categorie, extraction FROM asbuilt_documents WHERE projet_id = ? AND extraction IS NOT NULL`,
    args: [modif.projet_id],
  })).rows;
  const impacts = [];
  const cible = (modif.element || '').toLowerCase();
  const feuilleCible = (modif.feuille || '').toLowerCase();
  for (const d of documents) {
    if (d.id === modif.document_id) continue;
    const ex = parseJson(d.extraction, {});
    const texte = JSON.stringify(ex).toLowerCase();
    const toucheElement = cible && cible.length > 2 && texte.includes(cible);
    const toucheFeuille = feuilleCible && texte.includes(feuilleCible);
    if (toucheElement || toucheFeuille) {
      impacts.push({ id: d.id, nom: d.nom, categorie: d.categorie, via: toucheElement ? 'élément' : 'feuille' });
    }
  }

  // Navigation précédent/suivant dans les modifications à traiter
  const suivante = (await req.db.execute({
    sql: `SELECT id FROM asbuilt_modifications WHERE projet_id = ? AND id > ? AND statut IN ('detectee','a_verifier','a_clarifier') ORDER BY id LIMIT 1`,
    args: [modif.projet_id, modif.id],
  })).rows[0];

  res.render('asbuilt-validation', {
    projet, modif, impacts, suivante,
    CATEGORIES, STATUTS_MODIFICATION, TYPES_MODIFICATION,
  });
});

router.post('/modification/:id/decision', express.urlencoded({ extended: true }), async (req, res) => {
  const id = parseInt(req.params.id);
  const r = await req.db.execute({ sql: 'SELECT projet_id FROM asbuilt_modifications WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.redirect('/asbuilt');
  const projetId = r.rows[0].projet_id;

  const decisions = { approuver: 'approuvee', refuser: 'refusee', clarifier: 'a_clarifier' };
  const statut = decisions[req.body.decision];
  if (statut) {
    await req.db.execute({
      sql: `UPDATE asbuilt_modifications SET statut = ?, commentaire_reviseur = ?, valide_par = ?, valide_le = datetime('now') WHERE id = ?`,
      args: [statut, (req.body.commentaire || '').trim() || null, (req.body.valide_par || '').trim() || null, id],
    });
  }

  // Quand plus rien n'attend de décision, le projet passe « prêt pour annotation ».
  const restantes = (await req.db.execute({
    sql: `SELECT COUNT(*) AS n FROM asbuilt_modifications WHERE projet_id = ? AND statut IN ('detectee','a_verifier')`,
    args: [projetId],
  })).rows[0].n;
  if (restantes === 0) {
    await req.db.execute({ sql: `UPDATE asbuilt_projets SET statut = 'annotation', updated_at = datetime('now') WHERE id = ? AND statut = 'revision'`, args: [projetId] });
  }

  if (req.body.suivante) return res.redirect('/asbuilt/modification/' + req.body.suivante);
  res.redirect('/asbuilt/projet/' + projetId + '/registre');
});

// ── Visualiseur de plans (PDF.js + annotations structurées) ─────────────────
router.get('/projet/:id/visualiseur', async (req, res) => {
  const projet = await chargerProjet(req.db, parseInt(req.params.id));
  if (!projet) return res.redirect('/asbuilt');

  const plans = (await req.db.execute({
    sql: `SELECT id, nom, categorie, nb_pages FROM asbuilt_documents
          WHERE projet_id = ? AND type_fichier = 'pdf' AND categorie IN ('plan_initial','plan_annote','dessin_atelier')
          ORDER BY categorie, nom`,
    args: [projet.id],
  })).rows;

  const documentId = parseInt(req.query.document) || (plans[0] && plans[0].id);
  const plan = plans.find((p) => p.id === documentId) || null;

  let urlPlan = null;
  if (plan) {
    const rDoc = await req.db.execute({ sql: 'SELECT cle_stockage FROM asbuilt_documents WHERE id = ?', args: [plan.id] });
    try { urlPlan = await createSignedUrl(BUCKETS.PLANS_ASBUILT, rDoc.rows[0].cle_stockage, 3600); } catch (_) {}
  }

  const annotations = plan ? (await req.db.execute({
    sql: 'SELECT * FROM asbuilt_annotations WHERE document_id = ? ORDER BY page, id',
    args: [plan.id],
  })).rows : [];

  // Modifications approuvées non encore annotées : proposées au lien lors de
  // la pose d'une annotation (le registre reste la source de vérité).
  const modifications = (await req.db.execute({
    sql: `SELECT id, titre, type, feuille, statut FROM asbuilt_modifications
          WHERE projet_id = ? AND statut IN ('approuvee','annotee') ORDER BY id`,
    args: [projet.id],
  })).rows;

  res.render('asbuilt-visualiseur', {
    projet, plans, plan, urlPlan, annotations, modifications,
    CATEGORIES, TYPES_MODIFICATION,
  });
});

// API JSON des annotations (objets structurés, jamais dessinés « à plat »).
router.post('/document/:id/annotations', express.json(), async (req, res) => {
  const rDoc = await req.db.execute({ sql: 'SELECT id, projet_id FROM asbuilt_documents WHERE id = ?', args: [parseInt(req.params.id)] });
  if (rDoc.rows.length === 0) return res.status(404).json({ error: 'Document introuvable' });
  const doc = rDoc.rows[0];

  const a = req.body || {};
  const type = ['nuage', 'fleche', 'note', 'barre', 'ajout', 'texte'].includes(a.type) ? a.type : 'note';
  const r = await req.db.execute({
    sql: `INSERT INTO asbuilt_annotations (projet_id, document_id, modification_id, page, type, x, y, w, h, texte, couleur, statut, auteur)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      doc.projet_id, doc.id, parseInt(a.modification_id) || null,
      parseInt(a.page) || 0, type,
      Number(a.x) || 0, Number(a.y) || 0, Number(a.w) || 0, Number(a.h) || 0,
      (a.texte || '').substring(0, 500), a.couleur || null, a.statut || null,
      (a.auteur || '').substring(0, 100) || null,
    ],
  });

  // Une modification liée à au moins une annotation passe « annotée ».
  if (parseInt(a.modification_id)) {
    await req.db.execute({
      sql: `UPDATE asbuilt_modifications SET statut = 'annotee' WHERE id = ? AND statut = 'approuvee'`,
      args: [parseInt(a.modification_id)],
    }).catch(() => {});
  }
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.post('/annotation/:id/supprimer', async (req, res) => {
  await req.db.execute({ sql: 'DELETE FROM asbuilt_annotations WHERE id = ?', args: [parseInt(req.params.id)] });
  res.json({ ok: true });
});

// ── Rapport final ────────────────────────────────────────────────────────────
router.get('/projet/:id/rapport', async (req, res) => {
  const projet = await chargerProjet(req.db, parseInt(req.params.id));
  if (!projet) return res.redirect('/asbuilt');

  const documents = (await req.db.execute({
    sql: 'SELECT * FROM asbuilt_documents WHERE projet_id = ? ORDER BY categorie, nom',
    args: [projet.id],
  })).rows;

  const modifications = (await req.db.execute({
    sql: `SELECT m.*, d.nom AS document_nom FROM asbuilt_modifications m
          LEFT JOIN asbuilt_documents d ON d.id = m.document_id
          WHERE m.projet_id = ? ORDER BY m.statut, m.feuille, m.id`,
    args: [projet.id],
  })).rows;
  modifications.forEach((m) => { m.preuve = parseJson(m.preuve_execution, null); });

  const approuvees = modifications.filter((m) => ['approuvee', 'annotee', 'integree'].includes(m.statut));
  const refusees = modifications.filter((m) => m.statut === 'refusee');
  const manquantes = modifications.filter((m) => m.type === 'info_manquante' || m.statut === 'a_clarifier');
  const contradictions = modifications.filter((m) => m.type === 'contradiction');
  const enAttente = modifications.filter((m) => ['detectee', 'a_verifier'].includes(m.statut));
  const feuilles = [...new Set(modifications.map((m) => m.feuille).filter(Boolean))].sort();
  const validateurs = [...new Set(modifications.map((m) => m.valide_par).filter(Boolean))];

  res.render('asbuilt-rapport', {
    projet, documents, modifications, approuvees, refusees, manquantes, contradictions,
    enAttente, feuilles, validateurs,
    CATEGORIES, STATUTS_MODIFICATION, TYPES_MODIFICATION,
    dateProduction: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
  });
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
module.exports.DISCIPLINES = DISCIPLINES;
module.exports.STATUTS_PROJET = STATUTS_PROJET;
module.exports.STATUTS_MODIFICATION = STATUTS_MODIFICATION;
module.exports.TYPES_MODIFICATION = TYPES_MODIFICATION;
