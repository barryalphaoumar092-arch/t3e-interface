const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument: PDFLib } = require('pdf-lib');
const { parseDevis, parseTemplate, extractProjectInfo } = require('../services/document-parser');
const { matchMaterials } = require('../services/material-matcher');

const DOCS_DIR = path.join(__dirname, '..', '..', 'documents');
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
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
  { name: 'supplements', maxCount: 10 },
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
  const supplementFiles = req.files && req.files.supplements || [];

  let contenu = { version: 3, devis: null, template: null, supplements: [], projet: {}, materiaux_matches: [], fiches_selectionnees: [] };
  let devisTexte = '';
  let templateTexte = '';
  let supplementsTexte = '';
  let templateChemin = null;

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
      contenu.devis = { erreur: err.message, source_fichier: devisFile.originalname };
    }
  }

  if (templateFile) {
    templateChemin = templateFile.path;
    try {
      const parsed = await parseTemplate(templateFile.path, templateFile.originalname);
      templateTexte = parsed.text || '';
      contenu.template = {
        source_fichier: templateFile.originalname,
        type: parsed.type,
        texte_preview: templateTexte.substring(0, 3000),
      };
    } catch (err) {
      contenu.template = { erreur: err.message, source_fichier: templateFile.originalname };
    }
  }

  for (const sf of supplementFiles) {
    try {
      const parsed = await parseDevis(sf.path, sf.originalname);
      supplementsTexte += '\n' + (parsed.text || '');
      contenu.supplements.push({ source_fichier: sf.originalname, type: parsed.type });
    } catch (err) {
      contenu.supplements.push({ source_fichier: sf.originalname, erreur: err.message });
    }
  }

  const textePourMatching = [devisTexte, templateTexte, supplementsTexte].join('\n');
  if (textePourMatching.trim().length > 10) {
    try {
      contenu.materiaux_matches = await matchMaterials(textePourMatching, db);
    } catch (err) { }
  }

  if (!contenu.projet.numero) contenu.projet.numero = numero_projet || '';

  let templateData = null;
  if (templateFile && fs.existsSync(templateFile.path)) {
    const rawBuffer = fs.readFileSync(templateFile.path);
    const isPdf = rawBuffer.length > 4 && rawBuffer.slice(0, 5).toString() === '%PDF-';

    if (isPdf) {
      templateData = rawBuffer.toString('base64');
    } else {
      let wordText = templateTexte || '';
      if (!wordText && rawBuffer[0] === 0xD0 && rawBuffer[1] === 0xCF) {
        try {
          const WordExtractor = require('word-extractor');
          const ext = new WordExtractor();
          const doc = await ext.extract(templateFile.path);
          wordText = doc.getBody() || '';
        } catch (e) { wordText = 'Bordereau'; }
      }
      if (!wordText) wordText = 'Bordereau';

      const PDFDocument = require('pdfkit');
      const pdfChunks = [];
      const wordPdf = new PDFDocument({ size: 'LETTER', margin: 50 });
      wordPdf.on('data', c => pdfChunks.push(c));
      const wordPdfDone = new Promise(resolve => wordPdf.on('end', () => resolve(Buffer.concat(pdfChunks))));
      wordPdf.fontSize(11).font('Helvetica');
      for (const line of wordText.split('\n')) {
        if (wordPdf.y > 720) wordPdf.addPage();
        const trimmed = line.trim();
        if (trimmed.length > 3 && trimmed === trimmed.toUpperCase()) {
          wordPdf.font('Helvetica-Bold').text(trimmed);
          wordPdf.font('Helvetica');
        } else {
          wordPdf.text(line);
        }
      }
      wordPdf.end();
      templateData = (await wordPdfDone).toString('base64');
    }
  }

  const result = await db.execute({
    sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, cree_par, devis_fichier, devis_texte, template_fichier, template_texte, template_chemin, template_data)
          VALUES (?, ?, ?, 'brouillon', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      contenu.projet.numero || numero_projet || '',
      titre || 'Bordereau sans titre',
      JSON.stringify(contenu),
      cree_par || 'Utilisateur',
      devisFile ? devisFile.originalname : null,
      devisTexte.substring(0, 10000) || null,
      templateFile ? templateFile.originalname : null,
      templateTexte.substring(0, 10000) || null,
      templateChemin,
      templateData,
    ]
  });

  const newId = Number(result.lastInsertRowid);
  await db.execute({
    sql: `INSERT INTO historique_bordereaux (bordereau_id, action, nouveau_statut, effectue_par) VALUES (?, 'creation', 'brouillon', ?)`,
    args: [newId, cree_par || 'Utilisateur']
  });

  res.redirect(`/bordereaux/editer/${newId}`);
});

router.get('/editer/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.redirect('/bordereaux');

  const row = r.rows[0];
  const bordereau = { ...row, contenu: JSON.parse(row.contenu || '{}') };

  if (!bordereau.contenu.version || bordereau.contenu.version < 3) {
    bordereau.contenu.fiches_selectionnees = bordereau.contenu.fiches_selectionnees || [];
  }

  const hist = await db.execute({
    sql: 'SELECT action, ancien_statut, nouveau_statut, commentaire, effectue_par, created_at FROM historique_bordereaux WHERE bordereau_id = ? ORDER BY created_at DESC',
    args: [bordereau.id]
  });
  const historique = hist.rows.map(h => ({
    action: h.action, ancien: h.ancien_statut, nouveau: h.nouveau_statut,
    commentaire: h.commentaire, par: h.effectue_par, date: h.created_at
  }));

  const ftDocs = await db.execute("SELECT id, titre, nom_fichier, chemin_fichier, source FROM documents WHERE categorie_id = (SELECT id FROM categories WHERE nom = 'Fiches techniques') AND statut = 'actif' ORDER BY source, titre");

  res.render('bordereau-editer', { bordereau, historique, ftDocs: ftDocs.rows });
});

router.post('/sauvegarder/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { titre, numero_projet, client, adresse, architecte, materiaux_json, fiches_json } = req.body;

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
  if (fiches_json) {
    try { contenu.fiches_selectionnees = JSON.parse(fiches_json); } catch (e) {}
  }

  await db.execute({
    sql: "UPDATE bordereaux SET titre = ?, numero_projet = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [titre, numero_projet, JSON.stringify(contenu), id]
  });
  res.redirect(`/bordereaux/editer/${id}?success=saved`);
});

// POST pour sauvegarder + générer PDF en une seule action
router.post('/generer-pdf/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { titre, numero_projet, client, adresse, architecte, materiaux_json, fiches_json } = req.body;

  // 1. Sauvegarder d'abord
  const current = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (current.rows.length === 0) return res.status(404).send('Bordereau non trouvé');

  const row = current.rows[0];
  const contenu = JSON.parse(row.contenu || '{}');
  contenu.projet = contenu.projet || {};
  if (titre) contenu.projet.numero = numero_projet || '';
  if (client) contenu.projet.client = client || '';
  if (adresse) contenu.projet.adresse = adresse || '';
  if (architecte) contenu.projet.architecte = architecte || '';
  if (materiaux_json) { try { contenu.materiaux_matches = JSON.parse(materiaux_json); } catch (e) {} }
  if (fiches_json) { try { contenu.fiches_selectionnees = JSON.parse(fiches_json); } catch (e) {} }

  await db.execute({
    sql: "UPDATE bordereaux SET titre = ?, numero_projet = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [titre || row.titre, numero_projet || row.numero_projet, JSON.stringify(contenu), id]
  });

  const projet = contenu.projet || {};
  const fichesSelectionnees = contenu.fiches_selectionnees || [];
  const materiaux = (contenu.materiaux_matches || []).filter(m => m.confirmed !== false);

  // 2. Construire le PDF final
  const finalPdf = await PDFLib.create();
  let templateLoaded = false;

  // 2a. Copier le template original
  if (row.template_data) {
    try {
      const templateBuffer = Buffer.from(row.template_data, 'base64');
      if (templateBuffer.length > 4 && templateBuffer.slice(0, 5).toString() === '%PDF-') {
        const templateDoc = await PDFLib.load(templateBuffer, { ignoreEncryption: true });
        const pages = await finalPdf.copyPages(templateDoc, templateDoc.getPageIndices());
        pages.forEach(p => finalPdf.addPage(p));
        templateLoaded = true;
      }
    } catch (err) {
      console.error('Erreur template:', err.message);
    }
  }

  // 2b. Ajouter la page résumé remplie
  const PDFDocument = require('pdfkit');
  const chunks = [];
  const summaryDoc = new PDFDocument({ size: 'LETTER', margin: 50 });
  summaryDoc.on('data', c => chunks.push(c));
  const summaryDone = new Promise(resolve => summaryDoc.on('end', () => resolve(Buffer.concat(chunks))));

  summaryDoc.rect(50, 40, 512, 35).fill('#003366');
  summaryDoc.fillColor('white').fontSize(14).font('Helvetica-Bold');
  summaryDoc.text('TOITURES 3 ÉTOILES — BORDEREAU REMPLI', 60, 50, { width: 492, align: 'center' });
  summaryDoc.fillColor('black').moveDown(1.5);

  summaryDoc.fontSize(10).font('Helvetica-Bold');
  summaryDoc.text(`Projet: ${projet.numero || 'N/A'}`, 50);
  summaryDoc.font('Helvetica').text(`Titre: ${titre || row.titre || ''}`);
  if (projet.client) summaryDoc.text(`Client: ${projet.client}`);
  if (projet.architecte) summaryDoc.text(`Architecte: ${projet.architecte}`);
  if (projet.adresse) summaryDoc.text(`Adresse: ${projet.adresse}`);
  summaryDoc.text(`Préparé par: ${row.cree_par || ''} | Date: ${row.created_at || ''}`);
  summaryDoc.text(`Statut: ${(row.statut || 'brouillon').toUpperCase()}`);
  summaryDoc.moveDown();

  summaryDoc.moveTo(50, summaryDoc.y).lineTo(562, summaryDoc.y).stroke('#003366');
  summaryDoc.moveDown(0.5);

  if (materiaux.length > 0) {
    summaryDoc.fontSize(12).font('Helvetica-Bold').text('MATÉRIAUX ET FICHES TECHNIQUES');
    summaryDoc.moveDown(0.5);
    summaryDoc.fontSize(8).font('Helvetica');

    materiaux.forEach((m, i) => {
      if (summaryDoc.y > 680) summaryDoc.addPage();
      summaryDoc.font('Helvetica-Bold').fontSize(9).text(`${i + 1}. ${m.nom || ''} — ${m.fabricant || ''}`);
      summaryDoc.font('Helvetica').fontSize(8);
      if (m.type_produit) summaryDoc.text(`   Type: ${m.type_produit}${m.type_systeme ? ' | Système: ' + m.type_systeme : ''}`);
      if (m.dimension) summaryDoc.text(`   Dimension: ${m.dimension}${m.unite ? ' (' + m.unite + ')' : ''}`);
      if (m.lien_fiche_technique) summaryDoc.fillColor('blue').text(`   Fiche technique: ${m.lien_fiche_technique}`, { link: m.lien_fiche_technique }).fillColor('black');
      if (m.lien_fiche_securite) summaryDoc.fillColor('blue').text(`   Fiche SDS: ${m.lien_fiche_securite}`, { link: m.lien_fiche_securite }).fillColor('black');
      summaryDoc.moveDown(0.3);
    });
  }

  if (fichesSelectionnees.length > 0) {
    summaryDoc.moveDown();
    summaryDoc.fontSize(12).font('Helvetica-Bold').text('FICHES TECHNIQUES JOINTES');
    summaryDoc.moveDown(0.3);
    summaryDoc.fontSize(9).font('Helvetica');
    fichesSelectionnees.forEach((f, i) => {
      summaryDoc.text(`${i + 1}. ${f.titre} (${f.source || ''})`);
    });
  }

  summaryDoc.moveDown(2);
  summaryDoc.moveTo(50, summaryDoc.y).lineTo(562, summaryDoc.y).stroke();
  summaryDoc.moveDown();
  summaryDoc.fontSize(9);
  summaryDoc.text('Préparé par: ___________________________    Date: _______________');
  summaryDoc.moveDown(0.6);
  summaryDoc.text('Révisé par:  ___________________________    Date: _______________');
  summaryDoc.moveDown(0.6);
  summaryDoc.text('Approuvé par: __________________________    Date: _______________');

  summaryDoc.end();
  const summaryBuffer = await summaryDone;

  const summaryPdfDoc = await PDFLib.load(summaryBuffer);
  const summaryPages = await finalPdf.copyPages(summaryPdfDoc, summaryPdfDoc.getPageIndices());
  summaryPages.forEach(p => finalPdf.addPage(p));

  // 2c. Ajouter les fiches techniques PDF sélectionnées
  for (const fiche of fichesSelectionnees) {
    const ftPath = fiche.chemin_fichier ? path.join(__dirname, '..', '..', fiche.chemin_fichier) : null;
    if (ftPath && fs.existsSync(ftPath) && ftPath.toLowerCase().endsWith('.pdf')) {
      try {
        const ftBuffer = fs.readFileSync(ftPath);
        const ftDoc = await PDFLib.load(ftBuffer, { ignoreEncryption: true });
        const ftPages = await finalPdf.copyPages(ftDoc, ftDoc.getPageIndices());
        ftPages.forEach(p => finalPdf.addPage(p));
      } catch (err) {
        console.error('Erreur fusion FT:', ftPath, err.message);
      }
    }
  }

  if (finalPdf.getPageCount() === 0) {
    const page = finalPdf.addPage();
    page.drawText('Aucun contenu genere.', { x: 50, y: 700, size: 14 });
  }

  const finalBuffer = await finalPdf.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-${projet.numero || id}.pdf"`);
  res.send(Buffer.from(finalBuffer));
});

module.exports = router;
