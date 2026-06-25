const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'documents'),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

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

router.post('/ajouter', upload.single('fichier'), async (req, res) => {
  if (req.body.mdp_admin !== MDP_ADMIN) return res.redirect('/connaissances?error=mdp');
  const db = req.db;
  const { titre, categorie_id, description, source, annee, mots_cles } = req.body;
  const file = req.file;
  if (!file) return res.redirect('/connaissances?error=no_file');

  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const relativePath = 'documents/' + file.originalname;
  await db.execute({
    sql: `INSERT INTO documents (titre, nom_fichier, chemin_fichier, categorie_id, type_fichier, taille_octets, description, source, annee, mots_cles)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [titre, file.originalname, relativePath, parseInt(categorie_id), ext, file.size, description || null, source || null, annee || null, mots_cles || null]
  });
  res.redirect('/connaissances?success=added');
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

module.exports = router;
