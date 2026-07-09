const express = require('express');
const router = express.Router();
const path = require('path');
const { downloadBuffer, sanitizeKey, BUCKETS } = require('../services/storage');

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};
function mimeFor(filename) {
  return MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

router.get('/', async (req, res) => {
  const db = req.db;
  const tab = req.query.tab || 'documents';
  const search = req.query.q || '';
  const catFilter = req.query.categorie || '';

  const categories = await db.execute('SELECT id, nom FROM categories ORDER BY nom');
  const catList = categories.rows.map(r => [r.id, r.nom]);

  let documents = [];
  if (tab === 'documents') {
    let sql = `SELECT d.id, d.titre, d.nom_fichier, c.nom as categorie, d.type_fichier,
               d.source, d.annee, d.description, d.statut, ROUND(d.taille_octets/1048576.0,2) as taille_mb
               FROM documents d JOIN categories c ON d.categorie_id = c.id WHERE d.statut = 'actif'`;
    const args = [];
    if (search) {
      sql += ` AND (d.titre LIKE ? OR d.description LIKE ? OR d.mots_cles LIKE ?)`;
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (catFilter) {
      sql += ` AND c.nom = ?`;
      args.push(catFilter);
    }
    sql += ' ORDER BY c.nom, d.titre';
    const r = await db.execute({ sql, args });
    documents = r.rows;
  }

  let materiaux = [];
  if (tab === 'materiaux') {
    let sql = `SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, unite, lien_fiche_technique, lien_fiche_securite FROM materiaux WHERE 1=1`;
    const args = [];
    if (search) {
      sql += ` AND (nom LIKE ? OR fabricant LIKE ? OR type_produit LIKE ? OR type_systeme LIKE ?)`;
      args.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY type_produit, fabricant, nom';
    const r = await db.execute({ sql, args });
    materiaux = r.rows.map(row => ({
      ...row, lien_ft: row.lien_fiche_technique, lien_sds: row.lien_fiche_securite
    }));
  }

  let architectes = [];
  if (tab === 'architectes') {
    let sql = `SELECT id, firme, ville, telephone, email, contact, adresse, site_web FROM architectes WHERE 1=1`;
    const args = [];
    if (search) {
      sql += ` AND (firme LIKE ? OR ville LIKE ? OR contact LIKE ?)`;
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY firme';
    const r = await db.execute({ sql, args });
    architectes = r.rows;
  }

  res.render('connaissances', { tab, search, catFilter, catList, documents, materiaux, architectes });
});

const MDP_ADMIN = process.env.MDP_APP || 'barry';

// Le fichier est deja uploade DIRECTEMENT vers le bucket Supabase "documents"
// par le navigateur (voir /api/upload-url + views/connaissances.ejs) — cette
// route ne recoit plus que les metadonnees, pour contourner la limite de
// 4.5 Mo par requete des fonctions serverless Vercel.
router.post('/categorie', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.redirect('/connaissances?error=mdp');
  const db = req.db;
  const nom = (req.body.nom || '').trim();
  if (!nom) return res.redirect('/connaissances?error=no_nom');
  try {
    await db.execute({
      sql: 'INSERT INTO categories (nom, description) VALUES (?, ?)',
      args: [nom, (req.body.description || '').trim() || null],
    });
  } catch (e) {
    // categorie deja existante (contrainte UNIQUE sur nom) -> pas une erreur utilisateur
    if (!/UNIQUE/i.test(e.message || '')) throw e;
  }
  res.redirect('/connaissances?success=categorie');
});

router.post('/ajouter', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.redirect('/connaissances?error=mdp');
  const db = req.db;
  const { titre, categorie_id, description, source, annee, mots_cles, fichier_nom, fichier_taille } = req.body;
  if (!fichier_nom) return res.redirect('/connaissances?error=no_file');

  const ext = path.extname(fichier_nom).toLowerCase().replace('.', '');
  const relativePath = 'documents/' + fichier_nom;
  await db.execute({
    sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, annee, mots_cles)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [titre, fichier_nom, relativePath, parseInt(categorie_id), ext, parseInt(fichier_taille) || 0, description || null, source || null, annee || null, mots_cles || null]
  });
  res.redirect('/connaissances?success=added');
});

// chemin_fichier est normalement "documents/{fichier}" (bucket "documents",
// a plat) -- mais pour certains documents de la base de connaissances (ex :
// fiches techniques deja stockees dans le bucket "fiches-techniques", sous
// des sous-dossiers par fabricant) le premier segment peut designer un AUTRE
// bucket connu. On ne retombe sur le comportement historique (bucket
// "documents", cle = basename) que si ce premier segment n'est pas un bucket
// reconnu, pour ne rien casser sur les documents deja corrects.
const BUCKETS_CONNUS = new Set(Object.values(BUCKETS));
function resoudreBucketEtCle(cheminFichier, nomFichier) {
  const brut = cheminFichier || nomFichier || '';
  const segments = brut.split('/');
  if (segments.length > 1 && BUCKETS_CONNUS.has(segments[0])) {
    return { bucket: segments[0], key: sanitizeKey(segments.slice(1).join('/')) };
  }
  return { bucket: BUCKETS.DOCUMENTS, key: sanitizeKey(path.basename(brut)) };
}

router.get('/fichier/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT nom_fichier, chemin_fichier FROM documents WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.status(404).send('Document introuvable');

  const { nom_fichier, chemin_fichier } = r.rows[0];
  const { bucket, key } = resoudreBucketEtCle(chemin_fichier, nom_fichier);
  const buffer = await downloadBuffer(bucket, key);
  if (!buffer) return res.status(404).send('Fichier introuvable dans le stockage.');

  res.setHeader('Content-Type', mimeFor(nom_fichier));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nom_fichier)}"`);
  res.send(buffer);
});

router.post('/supprimer/:id', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.redirect('/connaissances?error=mdp');
  const db = req.db;
  await db.execute({
    sql: `UPDATE documents SET statut = 'supprime' WHERE id = ?`,
    args: [parseInt(req.params.id)]
  });
  res.redirect('/connaissances?success=removed');
});

// ── Reclassement ponctuel (a retirer apres execution) ────────────────────
// 10 documents legacy classes par TYPE de document dans une categorie
// ORGANISEE PAR SOURCE ("Certificats corporatifs", "Departement Service",
// "Bordereaux et formulaires") -- deplaces vers Garanties (18) / Formulaires
// (20), les 2 nouvelles categories creees pour la separation FT/SDS/Garanties
// demandee par l'utilisateur. Approuve explicitement avant execution.
const RECLASSEMENT_LEGACY = [
  { id: 138, categorie_id: 18 }, // Certificat Garantie Carlisle DRAFT
  { id: 162, categorie_id: 18 }, // SPECIMEN - GARANTIE T3E
  { id: 164, categorie_id: 18 }, // SPECIMEN - GARANTIE T3E - ANGLAIS
  { id: 163, categorie_id: 18 }, // SPECIMEN - Garantie MAMMOUTH PLATINUM - SBS
  { id: 165, categorie_id: 18 }, // SPECIMEN - MAMMOUTH PLATINUM Warranty - SBS
  { id: 296, categorie_id: 18 }, // 12. Garantie T3E 5 ans
  { id: 264, categorie_id: 18 }, // Certificat Vierge Garantie ANGLAIS
  { id: 297, categorie_id: 18 }, // GARANTIE Template FR
  { id: 298, categorie_id: 18 }, // Warranty Template EN
  { id: 34, categorie_id: 20 },  // Bordereau de transmission de fiche technique
];

router.post('/_reclasser-legacy', async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.status(403).json({ error: 'mdp_admin invalide' });
  const db = req.db;
  for (const r of RECLASSEMENT_LEGACY) {
    await db.execute({ sql: 'UPDATE documents SET categorie_id = ? WHERE id = ?', args: [r.categorie_id, r.id] });
  }
  res.json({ ok: true, total: RECLASSEMENT_LEGACY.length });
});

module.exports = router;
