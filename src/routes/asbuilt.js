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

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
module.exports.DISCIPLINES = DISCIPLINES;
module.exports.STATUTS_PROJET = STATUTS_PROJET;
module.exports.STATUTS_MODIFICATION = STATUTS_MODIFICATION;
module.exports.TYPES_MODIFICATION = TYPES_MODIFICATION;
