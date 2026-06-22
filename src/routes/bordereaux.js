const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const fs = require('fs');

const upload = multer({ dest: path.join(__dirname, '..', '..', 'uploads') });

router.get('/', async (req, res) => {
  const db = req.db;
  const r = await db.execute(`SELECT id, numero_projet, titre, statut, cree_par, created_at, updated_at
                              FROM bordereaux ORDER BY created_at DESC`);
  res.render('bordereaux', { bordereaux: r.rows });
});

router.get('/nouveau', (req, res) => {
  res.render('bordereau-nouveau');
});

router.post('/creer', upload.single('fichier_source'), async (req, res) => {
  const db = req.db;
  const { numero_projet, titre, cree_par } = req.body;
  const file = req.file;

  let contenu = {};

  if (file) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
      const wb = XLSX.readFile(file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws);
      contenu = {
        source_fichier: file.originalname,
        donnees: data.slice(0, 50),
        colonnes: data.length > 0 ? Object.keys(data[0]) : []
      };
    }
  }

  const materiaux_projet = [];
  if (contenu.donnees) {
    for (const row of contenu.donnees) {
      const vals = Object.values(row).join(' ');
      const search = await db.execute({
        sql: `SELECT id, nom, fabricant, type_produit, lien_fiche_technique
              FROM materiaux WHERE nom LIKE ? LIMIT 3`,
        args: [`%${vals.substring(0, 20)}%`]
      });
      for (const m of search.rows) {
        materiaux_projet.push({ id: m.id, nom: m.nom, fabricant: m.fabricant, type: m.type_produit, fiche: m.lien_fiche_technique });
      }
    }
  }

  contenu.materiaux_suggeres = materiaux_projet;
  contenu.numero_projet = numero_projet;

  const result = await db.execute({
    sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, cree_par)
          VALUES (?, ?, ?, 'brouillon', ?)`,
    args: [numero_projet || '', titre || 'Bordereau sans titre', JSON.stringify(contenu), cree_par || 'Utilisateur']
  });

  const newId = Number(result.lastInsertRowid);

  await db.execute({
    sql: `INSERT INTO historique_bordereaux (bordereau_id, action, nouveau_statut, effectue_par)
          VALUES (?, 'creation', 'brouillon', ?)`,
    args: [newId, cree_par || 'Utilisateur']
  });

  res.redirect(`/bordereaux/editer/${newId}`);
});

router.get('/editer/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({
    sql: `SELECT id, numero_projet, titre, contenu, statut, cree_par, created_at, updated_at
          FROM bordereaux WHERE id = ?`,
    args: [parseInt(req.params.id)]
  });
  if (r.rows.length === 0) return res.redirect('/bordereaux');

  const row = r.rows[0];
  const bordereau = {
    ...row,
    contenu: JSON.parse(row.contenu || '{}')
  };

  const hist = await db.execute({
    sql: `SELECT action, ancien_statut, nouveau_statut, commentaire, effectue_par, created_at
          FROM historique_bordereaux WHERE bordereau_id = ? ORDER BY created_at DESC`,
    args: [bordereau.id]
  });
  const historique = hist.rows.map(h => ({
    action: h.action, ancien: h.ancien_statut, nouveau: h.nouveau_statut,
    commentaire: h.commentaire, par: h.effectue_par, date: h.created_at
  }));

  res.render('bordereau-editer', { bordereau, historique });
});

router.post('/sauvegarder/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { titre, numero_projet, contenu_json } = req.body;

  await db.execute({
    sql: `UPDATE bordereaux SET titre = ?, numero_projet = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [titre, numero_projet, contenu_json, id]
  });
  res.redirect(`/bordereaux/editer/${id}?success=saved`);
});

router.get('/pdf/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({
    sql: `SELECT id, numero_projet, titre, contenu, statut, cree_par, created_at FROM bordereaux WHERE id = ?`,
    args: [parseInt(req.params.id)]
  });
  if (r.rows.length === 0) return res.status(404).send('Bordereau non trouvé');

  const row = r.rows[0];
  const bordereau = { ...row, contenu: JSON.parse(row.contenu || '{}') };

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-${bordereau.numero_projet || bordereau.id}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).text('TOITURES 3 ÉTOILES', { align: 'center' });
  doc.fontSize(12).text('Bordereau de transmission de fiche technique', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10);
  doc.text(`Projet: ${bordereau.numero_projet || 'N/A'}`, { continued: true });
  doc.text(`    Statut: ${bordereau.statut.toUpperCase()}`, { align: 'right' });
  doc.text(`Titre: ${bordereau.titre}`);
  doc.text(`Créé par: ${bordereau.cree_par || 'N/A'}    Date: ${bordereau.created_at || 'N/A'}`);
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown();

  const contenu = bordereau.contenu;
  if (contenu.donnees && contenu.donnees.length > 0) {
    doc.fontSize(12).text('Données du document source', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(8);
    const cols = contenu.colonnes || Object.keys(contenu.donnees[0]);
    for (const r of contenu.donnees.slice(0, 30)) {
      const line = cols.map(c => `${c}: ${r[c] || ''}`).join(' | ');
      doc.text(line, { width: 512 });
    }
  }

  if (contenu.materiaux_suggeres && contenu.materiaux_suggeres.length > 0) {
    doc.moveDown();
    doc.fontSize(12).text('Matériaux suggérés', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(9);
    for (const m of contenu.materiaux_suggeres) {
      doc.text(`- ${m.nom} (${m.fabricant}) - ${m.type}`);
      if (m.fiche) doc.fillColor('blue').text(`  Fiche: ${m.fiche}`, { link: m.fiche }).fillColor('black');
    }
  }

  doc.moveDown(2);
  doc.fontSize(10);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown(0.5);
  doc.text(`Statut: ${bordereau.statut.toUpperCase()}`, { align: 'right' });

  doc.end();
});

module.exports = router;
