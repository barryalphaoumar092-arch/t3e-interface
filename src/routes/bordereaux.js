const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const PDFDocument = require('pdfkit');
const { parseDevis, parseTemplate, extractProjectInfo } = require('../services/document-parser');
const { matchMaterials } = require('../services/material-matcher');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'uploads'),
  filename: (req, file, cb) => {
    const prefix = file.fieldname;
    const ext = path.extname(file.originalname);
    cb(null, `${prefix}-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadFields = upload.fields([
  { name: 'devis', maxCount: 1 },
  { name: 'template', maxCount: 1 },
]);

router.get('/', async (req, res) => {
  const db = req.db;
  const r = await db.execute('SELECT id, numero_projet, titre, statut, cree_par, created_at, updated_at FROM bordereaux ORDER BY created_at DESC');
  res.render('bordereaux', { bordereaux: r.rows });
});

router.get('/nouveau', (req, res) => {
  res.render('bordereau-nouveau');
});

router.post('/creer', uploadFields, async (req, res) => {
  const db = req.db;
  const { numero_projet, titre, cree_par } = req.body;
  const devisFile = req.files && req.files.devis && req.files.devis[0];
  const templateFile = req.files && req.files.template && req.files.template[0];

  let contenu = { version: 2, devis: null, template: null, projet: {}, materiaux_matches: [] };
  let devisTexte = '';
  let templateTexte = '';

  if (devisFile) {
    try {
      const parsed = await parseDevis(devisFile.path, devisFile.originalname);
      devisTexte = parsed.text || '';
      contenu.devis = {
        source_fichier: devisFile.originalname,
        type: parsed.type,
        tables: parsed.tables || [],
        texte_preview: devisTexte.substring(0, 3000),
      };
      const projectInfo = extractProjectInfo(devisTexte);
      contenu.projet = {
        numero: numero_projet || projectInfo.numero,
        client: projectInfo.client,
        adresse: projectInfo.adresse,
        architecte: projectInfo.architecte,
      };
    } catch (err) {
      console.error('Erreur parsing devis:', err.message);
      contenu.devis = { erreur: err.message, source_fichier: devisFile.originalname };
    }
  }

  if (templateFile) {
    try {
      const parsed = await parseTemplate(templateFile.path, templateFile.originalname);
      templateTexte = parsed.text || '';
      contenu.template = {
        source_fichier: templateFile.originalname,
        type: parsed.type,
        texte_preview: templateTexte.substring(0, 3000),
      };
    } catch (err) {
      console.error('Erreur parsing template:', err.message);
      contenu.template = { erreur: err.message, source_fichier: templateFile.originalname };
    }
  }

  const textePourMatching = [devisTexte, templateTexte].join('\n');
  if (textePourMatching.trim().length > 10) {
    try {
      contenu.materiaux_matches = await matchMaterials(textePourMatching, db);
    } catch (err) {
      console.error('Erreur matching materiaux:', err.message);
    }
  }

  if (!contenu.projet.numero) contenu.projet.numero = numero_projet || '';

  const result = await db.execute({
    sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, cree_par, devis_fichier, devis_texte, template_fichier, template_texte)
          VALUES (?, ?, ?, 'brouillon', ?, ?, ?, ?, ?)`,
    args: [
      contenu.projet.numero || numero_projet || '',
      titre || 'Bordereau sans titre',
      JSON.stringify(contenu),
      cree_par || 'Utilisateur',
      devisFile ? devisFile.originalname : null,
      devisTexte.substring(0, 10000) || null,
      templateFile ? templateFile.originalname : null,
      templateTexte.substring(0, 10000) || null,
    ]
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
    sql: 'SELECT * FROM bordereaux WHERE id = ?',
    args: [parseInt(req.params.id)]
  });
  if (r.rows.length === 0) return res.redirect('/bordereaux');

  const row = r.rows[0];
  const bordereau = { ...row, contenu: JSON.parse(row.contenu || '{}') };

  if (!bordereau.contenu.version) {
    bordereau.contenu = {
      version: 1,
      materiaux_matches: bordereau.contenu.materiaux_suggeres || [],
      devis: bordereau.contenu.donnees ? { tables: [{ colonnes: bordereau.contenu.colonnes, donnees: bordereau.contenu.donnees }] } : null,
      projet: { numero: bordereau.numero_projet },
      template: null,
    };
  }

  const hist = await db.execute({
    sql: 'SELECT action, ancien_statut, nouveau_statut, commentaire, effectue_par, created_at FROM historique_bordereaux WHERE bordereau_id = ? ORDER BY created_at DESC',
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
  const { titre, numero_projet, client, adresse, architecte, materiaux_json } = req.body;

  const current = await db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
  if (current.rows.length === 0) return res.redirect('/bordereaux');

  const contenu = JSON.parse(current.rows[0].contenu || '{}');
  contenu.projet = contenu.projet || {};
  contenu.projet.numero = numero_projet || '';
  contenu.projet.client = client || '';
  contenu.projet.adresse = adresse || '';
  contenu.projet.architecte = architecte || '';

  if (materiaux_json) {
    try { contenu.materiaux_matches = JSON.parse(materiaux_json); } catch (e) {}
  }

  await db.execute({
    sql: "UPDATE bordereaux SET titre = ?, numero_projet = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [titre, numero_projet, JSON.stringify(contenu), id]
  });
  res.redirect(`/bordereaux/editer/${id}?success=saved`);
});

router.get('/pdf/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau non trouvé');

  const row = r.rows[0];
  const contenu = JSON.parse(row.contenu || '{}');
  const projet = contenu.projet || {};
  const materiaux = (contenu.materiaux_matches || []).filter(m => m.confirmed !== false);

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-${projet.numero || row.id}.pdf"`);
  doc.pipe(res);

  doc.fontSize(18).font('Helvetica-Bold').text('TOITURES 3 ÉTOILES', { align: 'center' });
  doc.fontSize(11).font('Helvetica').text('Bordereau de transmission de fiches techniques', { align: 'center' });
  doc.moveDown(1.5);

  doc.fontSize(10).font('Helvetica-Bold');
  const infoY = doc.y;
  doc.text(`Projet: ${projet.numero || 'N/A'}`, 50, infoY);
  doc.text(`Statut: ${(row.statut || '').toUpperCase()}`, 350, infoY);
  doc.text(`Titre: ${row.titre || ''}`, 50);
  if (projet.client) doc.text(`Client: ${projet.client}`);
  if (projet.architecte) doc.text(`Architecte: ${projet.architecte}`);
  if (projet.adresse) doc.text(`Adresse: ${projet.adresse}`);
  doc.font('Helvetica').text(`Préparé par: ${row.cree_par || 'N/A'}    Date: ${row.created_at || ''}`);
  doc.moveDown();

  doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown();

  if (materiaux.length > 0) {
    doc.fontSize(12).font('Helvetica-Bold').text('MATÉRIAUX ET FICHES TECHNIQUES');
    doc.moveDown(0.5);

    const colX = [50, 65, 240, 340, 430, 500];
    const colW = [15, 175, 100, 90, 70, 62];
    const headerY = doc.y;

    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('#', colX[0], headerY, { width: colW[0] });
    doc.text('Produit', colX[1], headerY, { width: colW[1] });
    doc.text('Fabricant', colX[2], headerY, { width: colW[2] });
    doc.text('Type', colX[3], headerY, { width: colW[3] });
    doc.text('FT', colX[4], headerY, { width: colW[4], align: 'center' });
    doc.text('SDS', colX[5], headerY, { width: colW[5], align: 'center' });

    doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(7);
    materiaux.forEach((m, i) => {
      if (doc.y > 700) { doc.addPage(); doc.y = 50; }
      const y = doc.y;
      doc.text(String(i + 1), colX[0], y, { width: colW[0] });
      doc.text(m.nom || '', colX[1], y, { width: colW[1] });
      doc.text(m.fabricant || '', colX[2], y, { width: colW[2] });
      doc.text(m.type_produit || '', colX[3], y, { width: colW[3] });
      if (m.lien_fiche_technique) {
        doc.fillColor('green').text('OUI', colX[4], y, { width: colW[4], align: 'center' }).fillColor('black');
      } else {
        doc.fillColor('#999').text('—', colX[4], y, { width: colW[4], align: 'center' }).fillColor('black');
      }
      if (m.lien_fiche_securite) {
        doc.fillColor('green').text('OUI', colX[5], y, { width: colW[5], align: 'center' }).fillColor('black');
      } else {
        doc.fillColor('#999').text('—', colX[5], y, { width: colW[5], align: 'center' }).fillColor('black');
      }
      doc.moveDown(0.3);
    });

    doc.moveDown();
    doc.fontSize(7).fillColor('#666');
    doc.text('FT = Fiche technique disponible  |  SDS = Fiche de données de sécurité disponible');
    doc.fillColor('black');

    doc.moveDown();
    doc.fontSize(9).font('Helvetica-Bold').text('DÉTAILS DES FICHES TECHNIQUES');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(8);

    for (const m of materiaux) {
      if (doc.y > 680) { doc.addPage(); doc.y = 50; }
      if (m.lien_fiche_technique || m.lien_fiche_securite) {
        doc.font('Helvetica-Bold').text(`${m.nom} — ${m.fabricant || ''}`);
        doc.font('Helvetica');
        if (m.type_produit) doc.text(`  Type: ${m.type_produit}${m.type_systeme ? ' | Système: ' + m.type_systeme : ''}`);
        if (m.dimension) doc.text(`  Dimension: ${m.dimension}${m.unite ? ' (' + m.unite + ')' : ''}`);
        if (m.lien_fiche_technique) doc.fillColor('blue').text(`  Fiche technique: ${m.lien_fiche_technique}`, { link: m.lien_fiche_technique }).fillColor('black');
        if (m.lien_fiche_securite) doc.fillColor('blue').text(`  Fiche SDS: ${m.lien_fiche_securite}`, { link: m.lien_fiche_securite }).fillColor('black');
        doc.moveDown(0.5);
      }
    }
  } else {
    doc.fontSize(10).text('Aucun matériau associé à ce bordereau.');
  }

  if (doc.y > 600) doc.addPage();
  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(10).font('Helvetica-Bold').text('SIGNATURES');
  doc.moveDown();
  doc.font('Helvetica').fontSize(9);
  doc.text('Préparé par: ___________________________    Date: _______________');
  doc.moveDown(0.8);
  doc.text('Révisé par:  ___________________________    Date: _______________');
  doc.moveDown(0.8);
  doc.text('Approuvé par: __________________________    Date: _______________');

  doc.end();
});

module.exports = router;
