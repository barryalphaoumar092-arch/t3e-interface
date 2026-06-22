const express = require('express');
const router = express.Router();

router.get('/recherche', async (req, res) => {
  const db = req.db;
  const q = req.query.q || '';
  if (!q) return res.json({ documents: [], materiaux: [], architectes: [] });

  const like = `%${q}%`;

  const docs = await db.execute({
    sql: `SELECT d.id, d.titre, c.nom as categorie, d.description, d.source, d.annee, d.nom_fichier, d.type_fichier
          FROM documents d JOIN categories c ON d.categorie_id = c.id
          WHERE d.statut = 'actif' AND (d.titre LIKE ? OR d.description LIKE ? OR d.mots_cles LIKE ? OR c.nom LIKE ?)
          ORDER BY c.nom, d.titre LIMIT 50`,
    args: [like, like, like, like]
  });

  const mats = await db.execute({
    sql: `SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, lien_fiche_technique, lien_fiche_securite
          FROM materiaux
          WHERE nom LIKE ? OR fabricant LIKE ? OR type_produit LIKE ? OR type_systeme LIKE ?
          ORDER BY type_produit, nom LIMIT 50`,
    args: [like, like, like, like]
  });

  const archs = await db.execute({
    sql: `SELECT id, firme, ville, telephone, email, contact, site_web
          FROM architectes
          WHERE firme LIKE ? OR ville LIKE ? OR contact LIKE ?
          ORDER BY firme LIMIT 50`,
    args: [like, like, like]
  });

  res.json({
    documents: docs.rows.map(r => ({ id: r.id, titre: r.titre, categorie: r.categorie, description: r.description, source: r.source, annee: r.annee, fichier: r.nom_fichier, type: r.type_fichier })),
    materiaux: mats.rows.map(r => ({ id: r.id, nom: r.nom, fabricant: r.fabricant, type_produit: r.type_produit, type_systeme: r.type_systeme, fournisseur: r.fournisseur, dimension: r.dimension, lien_ft: r.lien_fiche_technique, lien_sds: r.lien_fiche_securite })),
    architectes: archs.rows
  });
});

router.get('/materiaux', async (req, res) => {
  const db = req.db;
  const q = req.query.q || '';
  const fab = req.query.fabricant || '';
  const type = req.query.type || '';

  let sql = `SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, unite, lien_fiche_technique, lien_fiche_securite FROM materiaux WHERE 1=1`;
  const args = [];
  if (q) { sql += ` AND (nom LIKE ? OR fabricant LIKE ?)`; args.push(`%${q}%`, `%${q}%`); }
  if (fab) { sql += ` AND fabricant = ?`; args.push(fab); }
  if (type) { sql += ` AND type_produit = ?`; args.push(type); }
  sql += ' ORDER BY type_produit, fabricant, nom LIMIT 100';

  const r = await db.execute({ sql, args });
  res.json(r.rows.map(row => ({
    ...row, lien_ft: row.lien_fiche_technique, lien_sds: row.lien_fiche_securite
  })));
});

module.exports = router;
