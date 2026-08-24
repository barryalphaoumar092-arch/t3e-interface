const express = require('express');
const router = express.Router();
const { downloadBuffer, removeFile, createSignedUrl, BUCKETS } = require('../services/storage');
const { construireContexte } = require('../services/soumission-parser');
const { analyserProjetSoumissionPrivee, isConfigured } = require('../services/claude-client');
const { TEMPLATE_MAP, LABELS_SYSTEME, genererSoumissionPrivee } = require('../services/soumission-filler');

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

router.post('/generer', async (req, res) => {
  const db = req.db;
  const systeme = req.body.systeme;
  const langue = req.body.langue || 'FR';

  if (!TEMPLATE_MAP[systeme]) {
    return res.render('soumission-nouveau', {
      systemes: Object.keys(TEMPLATE_MAP).map(k => ({ cle: k, label: LABELS_SYSTEME[k] || k })),
      iaConfiguree: isConfigured(),
      erreur: 'Système de toiture invalide.',
    });
  }
  if (!isConfigured()) {
    return res.render('soumission-nouveau', {
      systemes: Object.keys(TEMPLATE_MAP).map(k => ({ cle: k, label: LABELS_SYSTEME[k] || k })),
      iaConfiguree: false,
      erreur: "L'extraction automatique nécessite OPENAI_API_KEY (non configurée).",
    });
  }

  // Fichiers par categorie : cle temporaire unique (appel_offre) ou tableau (plans/addendas)
  const fichiersDemandes = [];
  for (const cat of CATEGORIES) {
    const cles = [].concat(req.body[cat + '_key'] || []).filter(cleTempValide);
    const noms = [].concat(req.body[cat + '_name'] || []);
    cles.forEach((cle, i) => fichiersDemandes.push({ cle, nom: noms[i] || cat, categorie: cat }));
  }

  if (fichiersDemandes.length === 0) {
    return res.render('soumission-nouveau', {
      systemes: Object.keys(TEMPLATE_MAP).map(k => ({ cle: k, label: LABELS_SYSTEME[k] || k })),
      iaConfiguree: isConfigured(),
      erreur: "Déposez au moins un document du projet (appel d'offre, devis, plans ou addenda) avant de générer la soumission.",
    });
  }

  // Telechargement + nettoyage du stockage temporaire (on ne garde que les
  // metadonnees dans documents_sources, pas les fichiers eux-memes).
  const documents = [];
  const documentsSources = [];
  for (const f of fichiersDemandes) {
    const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, f.cle);
    await removeFile(BUCKETS.UPLOADS_TEMP, f.cle).catch(() => {});
    if (!buf) continue;
    documents.push({ nom_fichier: f.nom, categorie: f.categorie, buffer: buf });
    documentsSources.push({ nom_fichier: f.nom, categorie: f.categorie });
  }

  const { contexte, documentsVides } = await construireContexte(documents);

  const champs = await analyserProjetSoumissionPrivee(contexte, systeme);
  if (champs.error) {
    return res.render('soumission-nouveau', {
      systemes: Object.keys(TEMPLATE_MAP).map(k => ({ cle: k, label: LABELS_SYSTEME[k] || k })),
      iaConfiguree: isConfigured(),
      erreur: "Erreur d'analyse IA : " + champs.error,
    });
  }

  const numero = await genererNumero(db);
  let resultat;
  try {
    resultat = await genererSoumissionPrivee({ systeme, langue, champs, numero });
  } catch (e) {
    return res.render('soumission-nouveau', {
      systemes: Object.keys(TEMPLATE_MAP).map(k => ({ cle: k, label: LABELS_SYSTEME[k] || k })),
      iaConfiguree: isConfigured(),
      erreur: 'Erreur de génération du document : ' + e.message,
    });
  }

  const r = await db.execute({
    sql: `INSERT INTO soumissions (numero, client_nom, projet_nom, systeme_toiture, type_travaux, langue, statut, template_utilise, fichier_genere, champs_extraits, documents_sources)
          VALUES (?, ?, ?, ?, ?, ?, 'genere', ?, ?, ?, ?)`,
    args: [
      numero,
      (champs.client_nom && champs.client_nom.valeur) || 'Client sans nom',
      (champs.objet_projet && champs.objet_projet.valeur) || null,
      systeme, systeme.includes('PLEUMAGE') ? 'PLEUMAGE' : 'REFECTION', langue,
      resultat.templateUsed, resultat.filename,
      JSON.stringify({ rapport: resultat.rapport, documentsVides }),
      JSON.stringify(documentsSources),
    ],
  });

  res.redirect(`/soumissions/${r.lastInsertRowid}`);
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
