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

// Détecte le type de fichier (pdf ou word) depuis le buffer
function detectFileType(buffer) {
  if (!buffer || buffer.length < 4) return 'unknown';
  // PDF: commence par %PDF
  if (buffer.slice(0, 5).toString() === '%PDF-') return 'pdf';
  // DOCX (ZIP): commence par PK
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'word';
  // DOC ancien format: D0 CF
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF) return 'word_legacy';
  return 'unknown';
}

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
  const { numero_projet, titre, cree_par, client, adresse, architecte } = req.body;
  const devisFile = req.files && req.files.devis && req.files.devis[0];
  const templateFile = req.files && req.files.template && req.files.template[0];
  const supplementFiles = (req.files && req.files.supplements) || [];

  let contenu = { version: 4, devis: null, template: null, supplements: [], projet: {}, materiaux_matches: [], fiches_selectionnees: [] };
  let devisTexte = '';
  let templateTexte = '';
  let supplementsTexte = '';
  let templateData = null;
  let templateType = null;

  if (devisFile) {
    try {
      const parsed = await parseDevis(devisFile.path, devisFile.originalname);
      devisTexte = parsed.text || '';
      contenu.devis = {
        source_fichier: devisFile.originalname,
        type: parsed.type,
        texte_preview: devisTexte.substring(0, 3000),
      };
      const projectInfo = extractProjectInfo(devisTexte);
      contenu.projet = {
        numero: numero_projet || projectInfo.numero,
        client: client || projectInfo.client,
        adresse: adresse || projectInfo.adresse,
        architecte: architecte || projectInfo.architecte,
      };
    } catch (err) {
      contenu.devis = { erreur: err.message, source_fichier: devisFile.originalname };
    }
  }

  if (templateFile) {
    const rawBuffer = fs.readFileSync(templateFile.path);
    templateType = detectFileType(rawBuffer);

    try {
      const parsed = await parseTemplate(templateFile.path, templateFile.originalname);
      templateTexte = parsed.text || '';
      contenu.template = {
        source_fichier: templateFile.originalname,
        type: templateType,
        texte_preview: templateTexte.substring(0, 3000),
      };
    } catch (err) {
      contenu.template = { erreur: err.message, source_fichier: templateFile.originalname };
    }

    if (templateType === 'pdf' || templateType === 'word') {
      templateData = rawBuffer.toString('base64');
      contenu.template_type = templateType;
    }

    try { fs.unlinkSync(templateFile.path); } catch (e) {}
  }

  for (const sf of supplementFiles) {
    try {
      const parsed = await parseDevis(sf.path, sf.originalname);
      supplementsTexte += '\n' + (parsed.text || '');
      contenu.supplements.push({ source_fichier: sf.originalname, type: parsed.type });
    } catch (err) {
      contenu.supplements.push({ source_fichier: sf.originalname, erreur: err.message });
    }
    try { fs.unlinkSync(sf.path); } catch (e) {}
  }

  const textePourMatching = [devisTexte, templateTexte, supplementsTexte].join('\n');
  if (textePourMatching.trim().length > 10) {
    try {
      contenu.materiaux_matches = await matchMaterials(textePourMatching, db);
    } catch (err) {}
  }

  contenu.projet = contenu.projet || {};
  if (!contenu.projet.numero) contenu.projet.numero = numero_projet || '';
  if (!contenu.projet.client) contenu.projet.client = client || '';
  if (!contenu.projet.adresse) contenu.projet.adresse = adresse || '';
  if (!contenu.projet.architecte) contenu.projet.architecte = architecte || '';

  const result = await db.execute({
    sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, cree_par, devis_fichier, devis_texte, template_fichier, template_texte, template_data)
          VALUES (?, ?, ?, 'brouillon', ?, ?, ?, ?, ?, ?)`,
    args: [
      contenu.projet.numero || numero_projet || '',
      titre || 'Bordereau sans titre',
      JSON.stringify(contenu),
      cree_par || 'Utilisateur',
      devisFile ? devisFile.originalname : null,
      devisTexte.substring(0, 10000) || null,
      templateFile ? templateFile.originalname : null,
      templateTexte.substring(0, 10000) || null,
      templateData,
    ]
  });

  const newId = Number(result.lastInsertRowid) || 0;
  if (newId) {
    await db.execute({
      sql: `INSERT INTO historique_bordereaux (bordereau_id, action, nouveau_statut, effectue_par) VALUES (?, 'creation', 'brouillon', ?)`,
      args: [newId, cree_par || 'Utilisateur']
    });
  }

  res.redirect(`/bordereaux/editer/${newId || 1}`);
});

router.get('/editer/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.redirect('/bordereaux');

  const row = r.rows[0];
  const bordereau = { ...row, contenu: JSON.parse(row.contenu || '{}') };
  const templateType = bordereau.contenu.template_type || (row.template_data ? 'pdf' : null);
  const hasTemplate = !!row.template_data;

  const hist = await db.execute({
    sql: 'SELECT action, commentaire, effectue_par, created_at FROM historique_bordereaux WHERE bordereau_id = ? ORDER BY created_at DESC LIMIT 10',
    args: [bordereau.id]
  });

  const ftDocs = await db.execute("SELECT id, titre, nom_fichier, chemin_fichier, source FROM documents WHERE categorie_id = (SELECT id FROM categories WHERE nom = 'Fiches techniques') AND statut = 'actif' ORDER BY source, titre");

  const { isConfigured } = require('../services/claude-client');
  res.render('bordereau-editer', {
    bordereau,
    historique: hist.rows,
    ftDocs: ftDocs.rows,
    iaActive: isConfigured(),
    hasTemplate,
    templateType,
  });
});

// Chat IA dédié au bordereau — contexte enrichi avec devis + base de connaissances
router.post('/chat/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { message, historique } = req.body;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

  if (!OPENAI_API_KEY) return res.json({ reponse: "L'IA n'est pas configurée (OPENAI_API_KEY manquante sur Render)." });
  if (!message || !message.trim()) return res.json({ reponse: '' });

  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.json({ reponse: 'Bordereau introuvable.' });

  const row = r.rows[0];
  const contenu = JSON.parse(row.contenu || '{}');
  const devisTexte = row.devis_texte || '';
  const templateTexte = row.template_texte || '';
  const projet = contenu.projet || {};

  const allMats = await db.execute('SELECT nom, fabricant, type_produit FROM materiaux ORDER BY fabricant, nom LIMIT 80');

  const systemPrompt = `Tu es un expert en toiture commerciale chez Toitures Trois Étoiles Inc. (T3E), au Québec. Tu aides à remplir les bordereaux techniques de transmission de matériaux.

BORDEREAU EN COURS — ${row.titre || 'Sans titre'} (${row.numero_projet || 'Sans numéro'}) :
${templateTexte ? templateTexte.substring(0, 2000) : 'Format standard T3E (NOM DU PROJET, NUMÉRO, NOM entrepreneur, SPÉCIALITÉ, ADRESSE, Titre, Description, Fournisseur, Fabricant, Délai, Remarque)'}

DEVIS DU PROJET :
${devisTexte ? devisTexte.substring(0, 3500) : 'Aucun devis fourni pour l\'instant'}

INFOS PROJET :
${Object.entries(projet).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join('\n') || 'À extraire du devis'}

MATÉRIAUX DISPONIBLES EN BASE :
${allMats.rows.slice(0, 60).map(m => `${m.nom} (${m.fabricant})`).join(' | ')}

Règles fixes :
- NOM entrepreneur → toujours "Toitures Trois Étoiles Inc."
- SPÉCIALITÉ → toujours "Couvreur"
- Réponds en français québécois professionnel.
- Si on te demande de remplir le bordereau, liste les valeurs de chaque champ clairement.`;

  const messages = [
    ...(Array.isArray(historique) ? historique.slice(-8) : []),
    { role: 'user', content: message.trim() }
  ];

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 900, messages: [{ role: 'system', content: systemPrompt }, ...messages] })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error('OpenAI ' + resp.status + ': ' + txt.substring(0, 200));
    }
    const data = await resp.json();
    const reponse = data.choices?.[0]?.message?.content || 'Pas de réponse.';
    res.json({ reponse });
  } catch (err) {
    console.error('Chat bordereau error:', err.message);
    res.json({ reponse: 'Erreur : ' + err.message });
  }
});

// Générer le bordereau rempli avec l'IA → Word (.docx) ou PDF propre
router.post('/generer/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { remplirBordereauIA, isConfigured } = require('../services/claude-client');

  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).json({ error: 'Bordereau introuvable' });

  const row = r.rows[0];
  if (!isConfigured()) return res.json({ error: "OPENAI_API_KEY non configurée dans Render." });

  const contenu = JSON.parse(row.contenu || '{}');
  const devisTexte = row.devis_texte || '';
  const templateTexte = row.template_texte || '';
  const projet = contenu.projet || {};
  const templateType = contenu.template_type || (row.template_data ? detectFileType(Buffer.from(row.template_data.substring(0, 20), 'base64')) : null);

  const allMats = await db.execute('SELECT nom, fabricant, type_produit FROM materiaux ORDER BY fabricant, nom LIMIT 150');
  const allFiches = await db.execute("SELECT id, titre, source FROM documents WHERE categorie_id = (SELECT id FROM categories WHERE nom = 'Fiches techniques') AND statut = 'actif' ORDER BY source, titre");

  let iaResult;
  try {
    iaResult = await remplirBordereauIA(templateTexte, devisTexte, allMats.rows, allFiches.rows, projet);
  } catch (err) {
    console.error('IA generer error:', err.message);
    return res.json({ error: 'Erreur IA : ' + err.message });
  }

  const champs = iaResult.champs || {};
  const fichesRecommandees = Array.isArray(iaResult.fiches_recommandees) ? iaResult.fiches_recommandees : [];

  // Fiches manuelles du body + recommandées par IA
  const fichesManuelles = Array.isArray(req.body.fiches_manuelles) ? req.body.fiches_manuelles.map(Number) : (contenu.fiches_selectionnees || []).map(f => f.id);
  const toutesLesFiches = [...new Set([...fichesRecommandees, ...fichesManuelles])].slice(0, 12);

  // Sauvegarder les fiches dans la DB
  const fichesSelectionneesFinal = [];
  for (const ficheId of toutesLesFiches) {
    const fRow = await db.execute({ sql: 'SELECT id, titre, nom_fichier, chemin_fichier, source FROM documents WHERE id = ?', args: [ficheId] });
    if (fRow.rows.length === 0) continue;
    fichesSelectionneesFinal.push(fRow.rows[0]);
  }
  contenu.fiches_selectionnees = fichesSelectionneesFinal;
  await db.execute({
    sql: "UPDATE bordereaux SET contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [JSON.stringify(contenu), id],
  });

  // === CAS 1: Template Word → remplir les {{CHAMPS}} et retourner .docx ===
  if (row.template_data && (templateType === 'word' || templateType === 'word_legacy')) {
    const { remplirBordereauWord } = require('../services/bordereau-word-filler');
    const templateBuffer = Buffer.from(row.template_data, 'base64');
    try {
      const wordBuffer = await remplirBordereauWord(templateBuffer, champs);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="bordereau-${row.numero_projet || id}-rempli.docx"`);
      return res.send(wordBuffer);
    } catch (err) {
      console.error('Word fill error:', err.message);
      // Fallback: générer un PDF propre
    }
  }

  // === CAS 2: Template PDF ou pas de template → générer un PDF propre avec pdfkit ===
  const PDFDocument = require('pdfkit');
  const pdfChunks = [];
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, autoFirstPage: false });
  doc.on('data', c => pdfChunks.push(c));
  const pdfDone = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(pdfChunks))));

  doc.addPage();

  // En-tête
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a1a1a')
    .text('BORDEREAU DE TRANSMISSION — MATÉRIAUX', { align: 'center' });
  doc.fontSize(10).font('Helvetica').fillColor('#555')
    .text('Toitures Trois Étoiles Inc. — Couvreur commercial', { align: 'center' });
  doc.moveDown(0.3);
  doc.strokeColor('#003087').lineWidth(2).moveTo(40, doc.y).lineTo(572, doc.y).stroke();
  doc.moveDown(0.5);

  // Section identification projet
  const champsProjets = [
    ['NOM DU PROJET',     champs.NOM_DU_PROJET     || champs.nom_du_projet     || projet.client || ''],
    ['NUMÉRO DU PROJET',  champs.NUMERO_DU_PROJET   || champs.numero_du_projet  || projet.numero || ''],
    ['NOM (entrepreneur)',champs.NOM_ENTREPRENEUR   || 'Toitures Trois Étoiles Inc.'],
    ['SPÉCIALITÉ',        champs.SPECIALITE          || 'Couvreur'],
    ['ADRESSE',           champs.ADRESSE             || champs.adresse           || projet.adresse || ''],
  ];

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#003087').text('IDENTIFICATION DU PROJET');
  doc.strokeColor('#003087').lineWidth(0.5).moveTo(40, doc.y).lineTo(572, doc.y).stroke();
  doc.moveDown(0.2);

  champsProjets.forEach(([label, val]) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333').text(label + ' :', 42, y, { width: 160, continued: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(String(val), 205, y, { width: 365 });
  });

  doc.moveDown(0.5);

  // Section identification matériaux
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#003087').text('IDENTIFICATION DU MATÉRIAU / DOCUMENT');
  doc.strokeColor('#003087').lineWidth(0.5).moveTo(40, doc.y).lineTo(572, doc.y).stroke();
  doc.moveDown(0.2);

  const champsMateriaux = [
    ['Titre',           champs.TITRE       || champs.titre       || ''],
    ['N° dessins',      champs.NUMERO_DESSINS || champs.numero_dessins || 'D-001'],
    ['Nombre feuilles', champs.NOMBRE_FEUILLES || '1'],
    ['Révision',        champs.REVISION    || 'A'],
    ['Description',     champs.DESCRIPTION || champs.description || ''],
    ['Fournisseur',     champs.FOURNISSEUR || champs.fournisseur || ''],
    ['Fabricant',       champs.FABRICANT   || champs.fabricant   || ''],
    ['Section (art.)',  champs.SECTION_ARTICLE || '07 50 00'],
    ['Article',         champs.ARTICLE     || champs.article     || ''],
    ['Délai',           champs.DELAI       || champs.delai       || '3 à 4 semaines'],
    ['Remarque',        champs.REMARQUE    || champs.remarque    || 'Voir fiches techniques ci-jointes'],
  ];

  champsMateriaux.forEach(([label, val]) => {
    if (doc.y > 680) doc.addPage();
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333').text(label + ' :', 42, y, { width: 130, continued: false });
    doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(String(val), 175, y, { width: 395 });
  });

  doc.moveDown(0.8);

  // Tableau suivi (vide, pour signature)
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#003087').text('SUIVI DE TRANSMISSION');
  doc.strokeColor('#003087').lineWidth(0.5).moveTo(40, doc.y).lineTo(572, doc.y).stroke();
  doc.moveDown(0.3);

  const headers = ['ACTION', 'REÇU', 'DATE', 'TRANSMIS À', 'PAR', 'DATE', 'COMMENTAIRES'];
  const colW = [70, 50, 55, 100, 80, 55, 122];
  let cx = 40;
  headers.forEach((h, i) => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff')
      .rect(cx, doc.y, colW[i], 14).fill('#003087').stroke();
    doc.fillColor('#fff').text(h, cx + 2, doc.y - 13, { width: colW[i] - 4, height: 14, align: 'center' });
    cx += colW[i];
  });
  doc.moveDown(0.2);

  for (let row2 = 0; row2 < 5; row2++) {
    let rx = 40;
    const ry = doc.y;
    colW.forEach(w => {
      doc.rect(rx, ry, w, 16).stroke('#ccc');
      rx += w;
    });
    doc.moveDown(0.9);
  }

  // Pied de page
  doc.moveDown(0.5);
  doc.fontSize(7).font('Helvetica').fillColor('#aaa')
    .text('Bordereau généré automatiquement par T3E Interface — ' + new Date().toLocaleDateString('fr-CA'), { align: 'center' });

  // Ajouter les fiches techniques (PDF uniquement)
  doc.end();
  const bordereauBuffer = await pdfDone;

  const finalPdf = await PDFLib.create();
  const bordLoaded = await PDFLib.load(bordereauBuffer);
  const bordPages = await finalPdf.copyPages(bordLoaded, bordLoaded.getPageIndices());
  bordPages.forEach(p => finalPdf.addPage(p));

  for (const fiche of fichesSelectionneesFinal) {
    const ftPath = fiche.chemin_fichier ? path.join(__dirname, '..', '..', fiche.chemin_fichier) : null;
    if (!ftPath || !fs.existsSync(ftPath) || !ftPath.toLowerCase().endsWith('.pdf')) continue;
    try {
      const ftBuf = fs.readFileSync(ftPath);
      const ftDoc = await PDFLib.load(ftBuf, { ignoreEncryption: true });
      const ftPages = await finalPdf.copyPages(ftDoc, ftDoc.getPageIndices());
      ftPages.forEach(p => finalPdf.addPage(p));
    } catch (e) { console.error('FT error:', e.message); }
  }

  const finalBytes = await finalPdf.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-${row.numero_projet || id}-rempli.pdf"`);
  res.send(Buffer.from(finalBytes));
});

// Remplacer le template (accepte Word ou PDF)
router.post('/remplacer-template/:id', upload.single('template'), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);

  if (!req.file) return res.json({ error: 'Aucun fichier envoyé' });

  const rawBuffer = fs.readFileSync(req.file.path);
  const fileType = detectFileType(rawBuffer);
  try { fs.unlinkSync(req.file.path); } catch (e) {}

  if (fileType === 'unknown') {
    return res.json({ error: 'Format non supporté. Uploadez un fichier Word (.docx) ou PDF.' });
  }

  let templateTexte = '';
  try {
    const tmp = path.join(UPLOADS_DIR, 'tmp-' + Date.now() + (fileType === 'pdf' ? '.pdf' : '.docx'));
    fs.writeFileSync(tmp, rawBuffer);
    const parsed = await parseTemplate(tmp, req.file.originalname);
    templateTexte = parsed.text || '';
    try { fs.unlinkSync(tmp); } catch (e) {}
  } catch (e) {}

  const templateData = rawBuffer.toString('base64');

  const current = await db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
  if (current.rows.length > 0) {
    const contenu = JSON.parse(current.rows[0].contenu || '{}');
    contenu.template_type = fileType;
    await db.execute({
      sql: "UPDATE bordereaux SET template_data = ?, template_texte = ?, template_fichier = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
      args: [templateData, templateTexte, req.file.originalname, JSON.stringify(contenu), id],
    });
  } else {
    await db.execute({
      sql: "UPDATE bordereaux SET template_data = ?, template_texte = ?, template_fichier = ?, updated_at = datetime('now') WHERE id = ?",
      args: [templateData, templateTexte, req.file.originalname, id],
    });
  }

  res.json({ ok: true, fichier: req.file.originalname, type: fileType });
});

// Uploader un devis sur un bordereau existant
router.post('/uploader-devis/:id', upload.single('devis'), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);

  if (!req.file) return res.json({ error: 'Aucun fichier envoyé' });

  let devisTexte = '';
  try {
    const parsed = await parseDevis(req.file.path, req.file.originalname);
    devisTexte = parsed.text || '';
  } catch (e) {}
  try { fs.unlinkSync(req.file.path); } catch (e) {}

  const r = await db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.json({ error: 'Bordereau introuvable' });

  const contenu = JSON.parse(r.rows[0].contenu || '{}');
  contenu.devis = contenu.devis || {};
  contenu.devis.source_fichier = req.file.originalname;

  // Matcher les matériaux
  if (devisTexte.trim().length > 10) {
    try {
      contenu.materiaux_matches = await matchMaterials(devisTexte, db);
    } catch (e) {}
  }

  await db.execute({
    sql: "UPDATE bordereaux SET devis_fichier = ?, devis_texte = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [req.file.originalname, devisTexte.substring(0, 10000), JSON.stringify(contenu), id]
  });

  res.json({ ok: true, fichier: req.file.originalname, preview: devisTexte.substring(0, 300) });
});

router.post('/supprimer/:id', async (req, res) => {
  const db = req.db;
  await db.execute({ sql: 'DELETE FROM historique_bordereaux WHERE bordereau_id = ?', args: [parseInt(req.params.id)] });
  await db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  res.redirect('/bordereaux');
});

router.get('/template-pdf/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT template_data, contenu FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0 || !r.rows[0].template_data) return res.status(404).send('Template non trouvé');
  const buf = Buffer.from(r.rows[0].template_data, 'base64');
  const contenu = JSON.parse(r.rows[0].contenu || '{}');
  const type = contenu.template_type || detectFileType(buf);
  if (type === 'word') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="template-bordereau.docx"');
  } else {
    res.setHeader('Content-Type', 'application/pdf');
  }
  res.send(buf);
});

// Sauvegarder fiches sélectionnées
router.post('/sauvegarder-fiches/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { fiches_json } = req.body;

  const current = await db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
  if (current.rows.length === 0) return res.json({ error: 'not found' });

  const contenu = JSON.parse(current.rows[0].contenu || '{}');
  if (fiches_json) {
    try { contenu.fiches_selectionnees = JSON.parse(fiches_json); } catch (e) {}
  }

  await db.execute({
    sql: "UPDATE bordereaux SET contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [JSON.stringify(contenu), id]
  });

  res.json({ ok: true });
});

module.exports = router;
