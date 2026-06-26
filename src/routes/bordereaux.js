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
  const { numero_projet, titre, cree_par, client, adresse, architecte } = req.body;
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
        client: client || projectInfo.client,
        adresse: adresse || projectInfo.adresse,
        architecte: architecte || projectInfo.architecte,
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

  contenu.projet = contenu.projet || {};
  if (!contenu.projet.numero) contenu.projet.numero = numero_projet || '';
  if (!contenu.projet.client) contenu.projet.client = client || '';
  if (!contenu.projet.adresse) contenu.projet.adresse = adresse || '';
  if (!contenu.projet.architecte) contenu.projet.architecte = architecte || '';

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

  // Extraire les champs du template
  const templateTexte = bordereau.template_texte || '';
  let templateFields = extractTemplateFields(templateTexte);

  // Fallback: champs standard du bordereau T3E si aucun champ détecté
  if (templateFields.length === 0) {
    templateFields = [
      { key: 'nom_du_projet', label: 'NOM DU PROJET' },
      { key: 'num_ro_du_projet', label: 'NUMÉRO DU PROJET' },
      { key: 'nom', label: 'NOM (entrepreneur)' },
      { key: 'sp_cialit', label: 'SPÉCIALITÉ' },
      { key: 'adresse', label: 'ADRESSE' },
      { key: 'ligne_num_ro', label: 'Ligne numéro' },
      { key: 'titre', label: 'Titre' },
      { key: 'num_ro_de_dessins', label: 'Numéro de dessins' },
      { key: 'nombre_feuilles', label: 'Nombre feuilles' },
      { key: 'r_vision', label: 'Révision' },
      { key: 'description', label: 'Description' },
      { key: 'fournisseur', label: 'Fournisseur' },
      { key: 'fabricant', label: 'Fabricant' },
      { key: 'section_item', label: 'Section (item)' },
      { key: 'article', label: 'Article' },
      { key: 'd_lai', label: 'Délai' },
      { key: 'remarque', label: 'Remarque' },
    ];
  }

  const { isConfigured } = require('../services/claude-client');
  res.render('bordereau-editer', { bordereau, historique, ftDocs: ftDocs.rows, templateFields, iaActive: isConfigured(), hasTemplate: !!row.template_data });
});

// Remplissage IA complet côté serveur : analyse + remplissage + PDF final en un clic
router.post('/remplir-ia-complet/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { isConfigured, proposerContenuBordereauComplet } = require('../services/claude-client');
  const { fillTemplatePdf } = require('../services/pdf-filler');

  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).json({ error: 'Bordereau introuvable' });

  const row = r.rows[0];
  if (!row.template_data) return res.json({ error: 'Aucun template PDF chargé. Cliquez sur "Charger le template PDF" pour uploader le bordereau vierge T3E.' });
  if (!isConfigured()) return res.json({ error: 'OPENAI_API_KEY non configurée dans Render.' });

  const contenu = JSON.parse(row.contenu || '{}');
  const devisTexte = row.devis_texte || '';
  const templateTexte = row.template_texte || '';
  const projet = contenu.projet || {};

  let champs = extractTemplateFields(templateTexte);
  if (champs.length === 0) {
    champs = [
      { key: 'nom_du_projet', label: 'NOM DU PROJET' },
      { key: 'num_ro_du_projet', label: 'NUMÉRO DU PROJET' },
      { key: 'nom', label: 'NOM (entrepreneur)' },
      { key: 'sp_cialit', label: 'SPÉCIALITÉ' },
      { key: 'adresse', label: 'ADRESSE' },
      { key: 'ligne_num_ro', label: 'Ligne numéro' },
      { key: 'titre', label: 'Titre' },
      { key: 'num_ro_de_dessins', label: 'Numéro de dessins' },
      { key: 'nombre_feuilles', label: 'Nombre feuilles' },
      { key: 'r_vision', label: 'Révision' },
      { key: 'description', label: 'Description' },
      { key: 'fournisseur', label: 'Fournisseur' },
      { key: 'fabricant', label: 'Fabricant' },
      { key: 'section_item', label: 'Section (item)' },
      { key: 'article', label: 'Article' },
      { key: 'd_lai', label: 'Délai' },
      { key: 'remarque', label: 'Remarque' },
    ];
  }

  const allMats = await db.execute('SELECT nom, fabricant, type_produit FROM materiaux ORDER BY fabricant, nom LIMIT 150');
  const allFiches = await db.execute("SELECT id, titre, source FROM documents WHERE categorie_id = (SELECT id FROM categories WHERE nom = 'Fiches techniques') AND statut = 'actif' ORDER BY source, titre");

  let suggestions = {};
  let fichesRecommandees = [];

  try {
    const iaResult = await proposerContenuBordereauComplet(champs, projet, devisTexte, allMats.rows, allFiches.rows);
    suggestions = iaResult.suggestions || {};
    fichesRecommandees = Array.isArray(iaResult.fiches_recommandees) ? iaResult.fiches_recommandees : [];
  } catch (err) {
    console.error('IA remplir-complet error:', err.message);
    return res.json({ error: 'Erreur IA : ' + err.message });
  }

  // Valeurs T3E garanties
  suggestions.nom = suggestions.nom || ['Toitures Trois Étoiles Inc.'];
  suggestions.sp_cialit = suggestions.sp_cialit || ['Couvreur'];

  // Positions par défaut calibrées pour le bordereau T3E standard
  const defaultPos = {
    nom_du_projet:    { x: 27, y: 16 },   nom:           { x: 16, y: 22.3 },
    num_ro_du_projet: { x: 29, y: 18 },   sp_cialit:     { x: 67, y: 22.3 },
    adresse:          { x: 20, y: 25.8 }, ligne_num_ro:  { x: 82, y: 32.2 },
    titre:            { x: 18, y: 38.4 }, num_ro_de_dessins: { x: 30, y: 40.7 },
    nombre_feuilles:  { x: 63, y: 40.7 }, r_vision:      { x: 83, y: 40.7 },
    description:      { x: 24, y: 42.6 }, fournisseur:   { x: 25, y: 44.7 },
    fabricant:        { x: 59, y: 44.7 }, section_item:  { x: 65, y: 47 },
    article:          { x: 58, y: 49.2 }, d_lai:         { x: 18, y: 51 },
    remarque:         { x: 24, y: 54.5 },
  };

  // Construire l'objet positions en fusionnant IA + positions sauvegardées + défauts
  const savedPos = contenu.field_positions || {};
  const positions = {};
  Object.keys(suggestions).forEach(key => {
    const vals = suggestions[key];
    const val = Array.isArray(vals) ? vals[0] : vals;
    if (!val) return;
    const base = savedPos[key] || defaultPos[key] || { x: 40, y: 50 };
    positions[key] = { x: base.x, y: base.y, val: String(val), page: base.page || 0, size: base.size || 9 };
  });

  // Remplir le PDF template
  const templateBuffer = Buffer.from(row.template_data, 'base64');
  const filledDoc = await fillTemplatePdf(templateBuffer, positions);
  const filledBuffer = await filledDoc.save();

  // Construire le PDF final : bordereau rempli + fiches techniques
  const finalPdf = await PDFLib.create();
  const filledLoaded = await PDFLib.load(filledBuffer);
  const pages = await finalPdf.copyPages(filledLoaded, filledLoaded.getPageIndices());
  pages.forEach(p => finalPdf.addPage(p));

  // Fiches recommandées par l'IA + fiches sélectionnées manuellement (du body ou de la DB)
  const fichesManuelles = (req.body.fiches_manuelles && Array.isArray(req.body.fiches_manuelles))
    ? req.body.fiches_manuelles.map(Number)
    : (contenu.fiches_selectionnees || []).map(f => f.id);
  const toutesLesFiches = [...new Set([...fichesRecommandees, ...fichesManuelles])].slice(0, 12);

  const fichesSelectionneesFinal = [];
  for (const ficheId of toutesLesFiches) {
    const fRow = await db.execute({ sql: 'SELECT id, titre, nom_fichier, chemin_fichier, source FROM documents WHERE id = ?', args: [ficheId] });
    if (fRow.rows.length === 0) continue;
    const fiche = fRow.rows[0];
    fichesSelectionneesFinal.push({ id: fiche.id, titre: fiche.titre, nom_fichier: fiche.nom_fichier, chemin_fichier: fiche.chemin_fichier, source: fiche.source });
    const ftPath = fiche.chemin_fichier ? path.join(__dirname, '..', '..', fiche.chemin_fichier) : null;
    if (!ftPath || !fs.existsSync(ftPath) || !ftPath.toLowerCase().endsWith('.pdf')) continue;
    try {
      const ftBuf = fs.readFileSync(ftPath);
      const ftDoc = await PDFLib.load(ftBuf, { ignoreEncryption: true });
      const ftPages = await finalPdf.copyPages(ftDoc, ftDoc.getPageIndices());
      ftPages.forEach(p => finalPdf.addPage(p));
    } catch (e) { console.error('FT error:', e.message); }
  }

  // Sauvegarder les positions et fiches dans la DB pour la prochaine fois
  contenu.field_positions = positions;
  contenu.fiches_selectionnees = fichesSelectionneesFinal;
  await db.execute({
    sql: "UPDATE bordereaux SET contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [JSON.stringify(contenu), id],
  });

  if (finalPdf.getPageCount() === 0) finalPdf.addPage();
  const finalBytes = await finalPdf.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-${id}-rempli.pdf"`);
  res.send(Buffer.from(finalBytes));
});

// Remplacer / uploader le template PDF d'un bordereau existant
router.post('/remplacer-template/:id', upload.single('template'), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);

  if (!req.file) return res.json({ error: 'Aucun fichier envoyé' });

  const rawBuffer = fs.readFileSync(req.file.path);
  const isPdf = rawBuffer.length > 4 && rawBuffer.slice(0, 5).toString() === '%PDF-';

  if (!isPdf) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.json({ error: 'Le fichier doit être un PDF valide' });
  }

  let templateTexte = '';
  try {
    const parsed = await parseTemplate(req.file.path, req.file.originalname);
    templateTexte = parsed.text || '';
  } catch (e) {}

  const templateData = rawBuffer.toString('base64');
  try { fs.unlinkSync(req.file.path); } catch (e) {}

  await db.execute({
    sql: "UPDATE bordereaux SET template_data = ?, template_texte = ?, template_fichier = ?, updated_at = datetime('now') WHERE id = ?",
    args: [templateData, templateTexte, req.file.originalname, id],
  });

  const champs = extractTemplateFields(templateTexte);
  res.json({ ok: true, fichier: req.file.originalname, nb_champs: champs.length });
});

router.post('/sauvegarder-ajax/:id', async (req, res) => {
  try {
    const db = req.db;
    const id = parseInt(req.params.id);
    const body = req.body || {};

    console.log('SAVE AJAX id=' + id, 'keys:', Object.keys(body), 'positions:', body.positions_json ? body.positions_json.substring(0, 100) : 'VIDE', 'fiches:', body.fiches_json ? body.fiches_json.substring(0, 100) : 'VIDE');

    const current = await db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
    if (current.rows.length === 0) return res.json({ error: 'not found' });

    const contenu = JSON.parse(current.rows[0].contenu || '{}');
    contenu.projet = contenu.projet || {};
    if (body.numero_projet) contenu.projet.numero = body.numero_projet;
    if (body.client) contenu.projet.client = body.client;
    if (body.adresse) contenu.projet.adresse = body.adresse;
    if (body.architecte) contenu.projet.architecte = body.architecte;

    // Sauvegarder les positions — accepter string JSON ou objet direct
    if (body.positions_json) {
      if (typeof body.positions_json === 'string') {
        try { contenu.field_positions = JSON.parse(body.positions_json); } catch (e) {}
      } else {
        contenu.field_positions = body.positions_json;
      }
    }
    if (body.positions && typeof body.positions === 'object') {
      contenu.field_positions = body.positions;
    }

    // Sauvegarder les fiches
    if (body.fiches_json) {
      if (typeof body.fiches_json === 'string') {
        try { contenu.fiches_selectionnees = JSON.parse(body.fiches_json); } catch (e) {}
      } else {
        contenu.fiches_selectionnees = body.fiches_json;
      }
    }
    if (body.fiches && Array.isArray(body.fiches)) {
      contenu.fiches_selectionnees = body.fiches;
    }

    console.log('SAVE RESULT positions:', JSON.stringify(contenu.field_positions || {}).substring(0, 200));

    await db.execute({
      sql: "UPDATE bordereaux SET titre = ?, numero_projet = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
      args: [body.titre || '', body.numero_projet || '', JSON.stringify(contenu), id]
    });

    res.json({ ok: true, saved_positions: Object.keys(contenu.field_positions || {}).length, saved_fiches: (contenu.fiches_selectionnees || []).length });
  } catch (err) {
    console.error('SAVE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/generer-pdf-get/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Non trouvé');

  const row = r.rows[0];
  const contenu = JSON.parse(row.contenu || '{}');
  const projet = contenu.projet || {};
  const fichesSelectionnees = contenu.fiches_selectionnees || [];

  const { fillTemplatePdf } = require('../services/pdf-filler');
  const finalPdf = await PDFLib.create();

  if (row.template_data) {
    try {
      const templateBuffer = Buffer.from(row.template_data, 'base64');
      if (templateBuffer.length > 4 && templateBuffer.slice(0, 5).toString() === '%PDF-') {
        const filledDoc = await fillTemplatePdf(templateBuffer, contenu.field_positions || {});
        const filledBuffer = await filledDoc.save();
        const filledLoaded = await PDFLib.load(filledBuffer);
        const pages = await finalPdf.copyPages(filledLoaded, filledLoaded.getPageIndices());
        pages.forEach(p => finalPdf.addPage(p));
      }
    } catch (err) {
      console.error('Erreur template:', err.message);
    }
  }

  const ftSkipped = [];
  for (const fiche of fichesSelectionnees) {
    const ftPath = fiche.chemin_fichier ? path.join(__dirname, '..', '..', fiche.chemin_fichier) : null;
    if (!ftPath || !fs.existsSync(ftPath)) {
      ftSkipped.push(fiche.titre || fiche.nom_fichier || 'inconnu');
      continue;
    }
    if (!ftPath.toLowerCase().endsWith('.pdf')) {
      ftSkipped.push(`${fiche.titre || fiche.nom_fichier} (format non-PDF)`);
      continue;
    }
    try {
      const ftBuffer = fs.readFileSync(ftPath);
      const ftDoc = await PDFLib.load(ftBuffer, { ignoreEncryption: true });
      const ftPages = await finalPdf.copyPages(ftDoc, ftDoc.getPageIndices());
      ftPages.forEach(p => finalPdf.addPage(p));
    } catch (err) {
      ftSkipped.push(`${fiche.titre || fiche.nom_fichier} (erreur: ${err.message})`);
    }
  }
  if (ftSkipped.length > 0) {
    console.log('FT non incluses dans le PDF:', ftSkipped.join(', '));
  }

  if (finalPdf.getPageCount() === 0) finalPdf.addPage();
  const finalBuffer = await finalPdf.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-${projet.numero || id}.pdf"`);
  res.send(Buffer.from(finalBuffer));
});

router.post('/sauvegarder/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { titre, numero_projet, client, adresse, architecte, materiaux_json, fiches_json, positions_json } = req.body;

  const current = await db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
  if (current.rows.length === 0) return res.redirect('/bordereaux');

  const contenu = JSON.parse(current.rows[0].contenu || '{}');
  contenu.projet = contenu.projet || {};
  contenu.projet.numero = numero_projet || contenu.projet.numero || '';
  contenu.projet.client = client || contenu.projet.client || '';
  contenu.projet.adresse = adresse || contenu.projet.adresse || '';
  contenu.projet.architecte = architecte || contenu.projet.architecte || '';

  if (materiaux_json) { try { contenu.materiaux_matches = JSON.parse(materiaux_json); } catch (e) {} }
  if (fiches_json) { try { contenu.fiches_selectionnees = JSON.parse(fiches_json); } catch (e) {} }
  if (positions_json) { try { contenu.field_positions = JSON.parse(positions_json); } catch (e) {} }

  await db.execute({
    sql: "UPDATE bordereaux SET titre = ?, numero_projet = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [titre, numero_projet, JSON.stringify(contenu), id]
  });
  res.redirect(`/bordereaux/editer/${id}?success=saved`);
});

router.post('/supprimer/:id', async (req, res) => {
  const db = req.db;
  await db.execute({ sql: 'DELETE FROM historique_bordereaux WHERE bordereau_id = ?', args: [parseInt(req.params.id)] });
  await db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  res.redirect('/bordereaux');
});

router.get('/template-pdf/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT template_data, template_fichier FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0 || !r.rows[0].template_data) return res.status(404).send('Template non trouvé');
  const buf = Buffer.from(r.rows[0].template_data, 'base64');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(buf);
});

// Analyse IA pour remplir le bordereau
router.post('/analyser-ia/:id', async (req, res) => {
  const db = req.db;
  const { isConfigured, proposerContenuBordereau } = require('../services/claude-client');

  if (!isConfigured()) {
    return res.json({ error: 'L\'IA n\'est pas configurée. Ajoutez OPENAI_API_KEY dans les variables d\'environnement Render.' });
  }

  const r = await db.execute({ sql: 'SELECT contenu, devis_texte, template_texte FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.json({ error: 'Bordereau introuvable' });

  const contenu = JSON.parse(r.rows[0].contenu || '{}');
  const devisTexte = r.rows[0].devis_texte || '';
  const templateTexte = r.rows[0].template_texte || '';

  // Obtenir les champs du template (même logique que GET /editer)
  let champs = extractTemplateFields(templateTexte);
  if (champs.length === 0) {
    champs = [
      { key: 'nom_du_projet', label: 'NOM DU PROJET' },
      { key: 'num_ro_du_projet', label: 'NUMÉRO DU PROJET' },
      { key: 'nom', label: 'NOM (entrepreneur)' },
      { key: 'sp_cialit', label: 'SPÉCIALITÉ' },
      { key: 'adresse', label: 'ADRESSE' },
      { key: 'ligne_num_ro', label: 'Ligne numéro' },
      { key: 'titre', label: 'Titre' },
      { key: 'num_ro_de_dessins', label: 'Numéro de dessins' },
      { key: 'nombre_feuilles', label: 'Nombre feuilles' },
      { key: 'r_vision', label: 'Révision' },
      { key: 'description', label: 'Description' },
      { key: 'fournisseur', label: 'Fournisseur' },
      { key: 'fabricant', label: 'Fabricant' },
      { key: 'section_item', label: 'Section (item)' },
      { key: 'article', label: 'Article' },
      { key: 'd_lai', label: 'Délai' },
      { key: 'remarque', label: 'Remarque' },
    ];
  }

  const projet = contenu.projet || {};
  const allMats = await db.execute('SELECT nom, fabricant, type_produit FROM materiaux ORDER BY fabricant, nom LIMIT 100');

  try {
    const result = await proposerContenuBordereau(champs, projet, devisTexte, allMats.rows);
    res.json(result);
  } catch (err) {
    console.error('Erreur IA bordereau:', err.message);
    res.json({ error: 'Erreur lors de l\'analyse IA: ' + err.message });
  }
});

router.get('/suggestions/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT contenu, devis_texte FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.json({});
  const contenu = JSON.parse(r.rows[0].contenu || '{}');
  const devisTexte = r.rows[0].devis_texte || '';
  const materiaux = contenu.materiaux_matches || [];

  const allMats = await db.execute('SELECT DISTINCT nom, fabricant, type_produit, type_systeme, dimension FROM materiaux ORDER BY fabricant, nom LIMIT 500');

  const fabricants = [...new Set([
    ...materiaux.map(m => m.fabricant).filter(Boolean),
    ...allMats.rows.map(m => m.fabricant).filter(Boolean),
  ])].slice(0, 30);

  const produits = [...new Set([
    ...materiaux.map(m => m.nom).filter(Boolean),
    ...allMats.rows.map(m => m.nom).filter(Boolean),
  ])].slice(0, 30);

  const types = [...new Set([
    ...materiaux.map(m => m.type_produit).filter(Boolean),
    ...allMats.rows.map(m => m.type_produit).filter(Boolean),
  ])].slice(0, 20);

  const descriptions = materiaux.map(m => [m.type_produit, m.type_systeme, m.dimension].filter(Boolean).join(' — ')).filter(Boolean);

  const projet = contenu.projet || {};

  // Infos des fiches sélectionnées
  const fichesSelect = contenu.fiches_selectionnees || [];
  const ftTitres = fichesSelect.map(f => f.titre).filter(Boolean);
  const ftSources = [...new Set(fichesSelect.map(f => f.source).filter(Boolean))];

  // Descriptions enrichies
  const allDescriptions = [
    ...descriptions,
    ...ftTitres.map(t => 'Fiche technique — ' + t),
    ...materiaux.map(m => [m.nom, m.fabricant, m.type_produit].filter(Boolean).join(' — ')),
  ].filter(Boolean);

  // Valeurs courantes du projet
  const projValues = [projet.client, projet.numero, projet.adresse, projet.architecte].filter(Boolean);

  res.json({
    nom_projet: [projet.client, extractFromText(devisTexte, /(?:projet|client)\s*[:#]?\s*([^\n]{3,40})/i)].filter(Boolean),
    numero_projet: [projet.numero, extractFromText(devisTexte, /(?:no|num[ée]ro)\s*(?:projet)?\s*[:#]?\s*([A-Z0-9][\w-]{2,15})/i)].filter(Boolean),
    adresse: [projet.adresse, extractFromText(devisTexte, /(?:adresse|lieu)\s*[:#]?\s*([^\n]{5,60})/i)].filter(Boolean),
    architecte: [projet.architecte, extractFromText(devisTexte, /(?:architecte|arch)\s*[:#]?\s*([^\n]{3,40})/i)].filter(Boolean),
    titre: [...new Set([...ftTitres, ...produits])],
    description: [...new Set(allDescriptions)].slice(0, 30),
    fournisseur: [...new Set([...ftSources, ...fabricants])],
    fabricant: [...new Set([...ftSources, ...fabricants])],
    types: types,
    ligne_num_ro: ['1', '2', '3', '4', '5'],
    nombre_feuilles: ['1', '2', '3', '4', '5', '10'],
    r_vision: ['0', '1', '2', 'A', 'B'],
    nom: ['Toitures Trois Étoiles Inc.'],
    sp_cialit: ['Couvreur', 'Couvreur — Toitures et étanchéité', 'Entrepreneur spécialisé en couverture'],
    d_lai: ['Selon échéancier', 'À confirmer', '2 semaines', '3 semaines', '1 mois'],
    remarque: fichesSelect.length > 0 ? ['Voir fiches techniques ci-jointes'] : [],
  });
});

function extractTemplateFields(text) {
  if (!text) return [];
  const fields = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) continue;
    // Pattern 1: "LABEL :" or "Label:"
    // Pattern 2: "Label : ____" or "Label:  "
    // Pattern 3: "Label :" at end of line
    const match = trimmed.match(/^([A-Za-zÀ-ÿ\s''°#()\-]{3,})\s*:/i) || trimmed.match(/^(.+?)\s*:\s*[_\s]*$/);
    if (match) {
      const label = match[1].trim();
      if (label.length > 2 && label.length < 50) {
        const upper = label.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        if (seen.has(upper)) continue;
        if (/^(IDENTIFICATION|SUIVI|COMMENTAIRES|RECU|RETOUR|EMIS|SOUMIS|SIGNATURE|DATE|PAGE|OBJET|RE |NOTE)/.test(upper)) continue;
        seen.add(upper);
        const key = label.toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        fields.push({ key, label });
      }
    }
  }
  return fields;
}

function extractFromText(text, regex) {
  if (!text) return '';
  const m = text.match(regex);
  return m ? m[1].trim() : '';
}

// POST pour sauvegarder + générer PDF en une seule action
router.post('/generer-pdf/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { titre, numero_projet, client, adresse, architecte, materiaux_json, fiches_json, positions_json } = req.body;

  const current = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (current.rows.length === 0) return res.status(404).send('Bordereau non trouvé');

  const row = current.rows[0];
  const contenu = JSON.parse(row.contenu || '{}');
  contenu.projet = contenu.projet || {};
  contenu.projet.numero = numero_projet || contenu.projet.numero || '';
  contenu.projet.client = client || contenu.projet.client || '';
  contenu.projet.adresse = adresse || contenu.projet.adresse || '';
  contenu.projet.architecte = architecte || contenu.projet.architecte || '';
  if (materiaux_json) { try { contenu.materiaux_matches = JSON.parse(materiaux_json); } catch (e) {} }
  if (fiches_json) { try { contenu.fiches_selectionnees = JSON.parse(fiches_json); } catch (e) {} }
  if (positions_json) { try { contenu.field_positions = JSON.parse(positions_json); } catch (e) {} }

  await db.execute({
    sql: "UPDATE bordereaux SET titre = ?, numero_projet = ?, contenu = ?, updated_at = datetime('now') WHERE id = ?",
    args: [titre || row.titre, numero_projet || row.numero_projet, JSON.stringify(contenu), id]
  });

  const projet = contenu.projet || {};
  const fichesSelectionnees = contenu.fiches_selectionnees || [];
  const materiaux = (contenu.materiaux_matches || []).filter(m => m.confirmed !== false);

  // 2. Construire le PDF final
  const { fillTemplatePdf } = require('../services/pdf-filler');
  const finalPdf = await PDFLib.create();
  let templateLoaded = false;

  // 2a. Charger le template et le REMPLIR avec les données
  if (row.template_data) {
    try {
      const templateBuffer = Buffer.from(row.template_data, 'base64');
      if (templateBuffer.length > 4 && templateBuffer.slice(0, 5).toString() === '%PDF-') {
        const filledDoc = await fillTemplatePdf(templateBuffer, contenu.field_positions || {});
        const filledBuffer = await filledDoc.save();
        const filledLoaded = await PDFLib.load(filledBuffer);
        const pages = await finalPdf.copyPages(filledLoaded, filledLoaded.getPageIndices());
        pages.forEach(p => finalPdf.addPage(p));
        templateLoaded = true;
      }
    } catch (err) {
      console.error('Erreur remplissage template:', err.message);
    }
  }

  if (!templateLoaded) {
    const page = finalPdf.addPage();
    page.drawText('Template PDF non disponible. Veuillez soumettre un vrai fichier PDF.', { x: 50, y: 700, size: 12 });
  }

  // 3. Ajouter les fiches techniques PDF sélectionnées
  for (const fiche of fichesSelectionnees) {
    const ftPath = fiche.chemin_fichier ? path.join(__dirname, '..', '..', fiche.chemin_fichier) : null;
    if (!ftPath || !fs.existsSync(ftPath)) continue;
    if (!ftPath.toLowerCase().endsWith('.pdf')) {
      console.log('FT ignorée (non-PDF):', fiche.titre || fiche.nom_fichier);
      continue;
    }
    try {
      const ftBuffer = fs.readFileSync(ftPath);
      const ftDoc = await PDFLib.load(ftBuffer, { ignoreEncryption: true });
      const ftPages = await finalPdf.copyPages(ftDoc, ftDoc.getPageIndices());
      ftPages.forEach(p => finalPdf.addPage(p));
    } catch (err) {
      console.error('Erreur fusion FT:', ftPath, err.message);
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
