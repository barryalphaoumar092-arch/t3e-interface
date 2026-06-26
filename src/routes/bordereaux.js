const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseDevis } = require('../services/document-parser');
const { remplirBordereau } = require('../services/bordereau-filler');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const DOCS_DIR = path.join(__dirname, '..', '..', 'documents');

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadFields = upload.fields([
  { name: 'devis', maxCount: 1 },
  { name: 'bordereau', maxCount: 1 },
]);

// ──────────────────────────────────────────────
//  Extraction des champs via OpenAI
// ──────────────────────────────────────────────
async function extraireChamps(texteDevis, nomProjet) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante sur Render.');

  const prompt = `Tu remplis un bordereau de transmission de fiches techniques pour une entreprise de couverture commerciale au Québec.

DEVIS :
${texteDevis.substring(0, 5000)}

NOM DU PROJET FOURNI PAR L'UTILISATEUR : ${nomProjet || 'À extraire du devis'}

Extrais et retourne UNIQUEMENT ce JSON (sans texte autour) :
{
  "NOM_DU_PROJET": "Nom complet du projet",
  "NUMERO_DU_PROJET": "Numéro de projet ou section",
  "TITRE": "Fiches techniques - [système] - Section [numéro]",
  "NUMERO_DESSINS": "FT-[SECTION]-001",
  "DESCRIPTION": "Description courte du système de toiture (membrane, isolant, méthode de pose)",
  "FOURNISSEUR": "Nom du fournisseur (ex: Soprema Inc.)",
  "FABRICANT": "Nom du fabricant (ex: Soprema)",
  "SECTION": "Numéro de section du devis (ex: 07 52 21)",
  "ARTICLE": "Type de produit principal (ex: Membrane de bitume modifié SBS)",
  "DELAI": "3 à 4 semaines",
  "REMARQUE": "Liste des matériaux principaux avec fabricant. Architecte si mentionné."
}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Tu es un expert en toiture commerciale au Québec. Réponds uniquement en JSON valide.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('OpenAI ' + resp.status + ': ' + txt.substring(0, 300));
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

// ──────────────────────────────────────────────
//  Génération PDF bordereau + fiches techniques
// ──────────────────────────────────────────────
async function genererPDFComplet(champs, fichesPaths) {
  const PDFDocument = require('pdfkit');
  const { PDFDocument: PDFLib } = require('pdf-lib');

  // 1. Bordereau en pdfkit
  const chunks = [];
  const doc = new PDFDocument({ size: 'LETTER', margin: 45, autoFirstPage: false });
  doc.on('data', c => chunks.push(c));
  const done = new Promise(r => doc.on('end', () => r(Buffer.concat(chunks))));

  doc.addPage();

  // En-tête
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1a1a')
    .text('BORDEREAU DE TRANSMISSION — FICHES TECHNIQUES', { align: 'center' });
  doc.fontSize(9).font('Helvetica').fillColor('#555')
    .text(`${champs.NOM || 'Toitures Trois Étoiles Inc.'} — ${champs.SPECIALITE || 'Couvreur'}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.strokeColor('#003087').lineWidth(2).moveTo(45, doc.y).lineTo(567, doc.y).stroke();
  doc.moveDown(0.5);

  // Identification projet
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#003087').text('IDENTIFICATION DU PROJET');
  doc.strokeColor('#003087').lineWidth(0.5).moveTo(45, doc.y).lineTo(567, doc.y).stroke();
  doc.moveDown(0.2);

  const ligneProjet = [
    ['NOM DU PROJET',    champs.NOM_DU_PROJET    || ''],
    ['NUMÉRO DU PROJET', champs.NUMERO_DU_PROJET  || ''],
    ['NOM',              champs.NOM               || 'Toitures Trois Étoiles Inc.'],
    ['SPÉCIALITÉ',       champs.SPECIALITE         || 'Couvreur'],
    ['ADRESSE',          champs.ADRESSE            || ''],
  ];
  ligneProjet.forEach(([lbl, val]) => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333').text(lbl + ' :', 47, y, { width: 150 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(String(val), 200, y, { width: 367 });
  });

  doc.moveDown(0.6);

  // Identification matériaux
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#003087').text('IDENTIFICATION DU MATÉRIAU');
  doc.strokeColor('#003087').lineWidth(0.5).moveTo(45, doc.y).lineTo(567, doc.y).stroke();
  doc.moveDown(0.2);

  const lignesMat = [
    ['Titre',             champs.TITRE           || ''],
    ['N° dessins',        champs.NUMERO_DESSINS   || ''],
    ['Nombre feuilles',   '1'],
    ['Révision',          'A'],
    ['Description',       champs.DESCRIPTION     || ''],
    ['Fournisseur',       champs.FOURNISSEUR      || ''],
    ['Fabricant',         champs.FABRICANT        || ''],
    ['Section (item)',    champs.SECTION          || ''],
    ['Article',           champs.ARTICLE         || ''],
    ['Délai',             champs.DELAI            || '3 à 4 semaines'],
    ['Remarque',          champs.REMARQUE        || ''],
  ];
  lignesMat.forEach(([lbl, val]) => {
    if (doc.y > 670) doc.addPage();
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333').text(lbl + ' :', 47, y, { width: 120 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(String(val), 170, y, { width: 397 });
  });

  doc.moveDown(0.8);

  // Suivi
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#003087').text('SUIVI DE TRANSMISSION');
  doc.strokeColor('#003087').lineWidth(0.5).moveTo(45, doc.y).lineTo(567, doc.y).stroke();
  doc.moveDown(0.4);

  const colW = [70, 50, 60, 110, 80, 60, 97];
  const hdrs = ['ACTION', 'REÇU', 'DATE', 'TRANSMIS À', 'PAR', 'DATE', 'COMMENTAIRES'];
  let cx = 45, hy = doc.y;
  hdrs.forEach((h, i) => {
    doc.rect(cx, hy, colW[i], 14).fill('#003087');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7)
      .text(h, cx + 2, hy + 3, { width: colW[i] - 4, align: 'center' });
    cx += colW[i];
  });
  doc.moveDown(0.8);
  for (let i = 0; i < 4; i++) {
    let rx = 45, ry = doc.y;
    colW.forEach(w => { doc.rect(rx, ry, w, 16).stroke('#ccc'); rx += w; });
    doc.moveDown(0.9);
  }

  // Signatures
  doc.moveDown(0.5);
  const sy = doc.y;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#333')
    .text('ÉMIS PAR : ' + (champs.EMIS_PAR || ''), 47, sy)
    .text('SOUMIS PAR : ' + (champs.NOM || 'Toitures Trois Étoiles Inc.'), 310, sy);

  doc.moveDown(2);
  doc.fontSize(7).font('Helvetica').fillColor('#aaa')
    .text('Généré par T3E Interface — ' + new Date().toLocaleDateString('fr-CA'), { align: 'center' });

  doc.end();
  const bordereauBuf = await done;

  // 2. Assembler avec pdf-lib
  const final = await PDFLib.create();
  const bLoaded = await PDFLib.load(bordereauBuf);
  const bPages = await final.copyPages(bLoaded, bLoaded.getPageIndices());
  bPages.forEach(p => final.addPage(p));

  for (const ftPath of fichesPaths) {
    if (!ftPath || !fs.existsSync(ftPath)) continue;
    try {
      const ftBuf = fs.readFileSync(ftPath);
      const ftDoc = await PDFLib.load(ftBuf, { ignoreEncryption: true });
      const ftPages = await final.copyPages(ftDoc, ftDoc.getPageIndices());
      ftPages.forEach(p => final.addPage(p));
    } catch (e) { /* fiche corrompue — on passe */ }
  }

  return Buffer.from(await final.save());
}

// ──────────────────────────────────────────────
//  Routes
// ──────────────────────────────────────────────

router.get('/', async (req, res) => {
  const db = req.db;
  const r = await db.execute('SELECT id, titre, numero_projet, cree_par, created_at FROM bordereaux ORDER BY created_at DESC');
  res.render('bordereaux', { bordereaux: r.rows });
});

router.get('/nouveau', async (req, res) => {
  const db = req.db;
  const ftDocs = await db.execute(
    `SELECT id, titre, nom_fichier, chemin_fichier, source
     FROM documents
     WHERE categorie_id = (SELECT id FROM categories WHERE nom = 'Fiches techniques') AND statut = 'actif'
     ORDER BY source, titre`
  );
  res.render('bordereau-nouveau', { fiches: ftDocs.rows, erreur: null });
});

// Génération complète : devis + bordereau → IA → PDF bordereau + fiches
router.post('/generer', uploadFields, async (req, res) => {
  const db = req.db;
  const { nom_projet, nom_entrepreneur, specialite, adresse, emis_par } = req.body;
  const fichesSelectionnees = Array.isArray(req.body.fiches) ? req.body.fiches.map(Number)
    : req.body.fiches ? [Number(req.body.fiches)] : [];

  const devisFile = req.files && req.files.devis && req.files.devis[0];
  const bordereauFile = req.files && req.files.bordereau && req.files.bordereau[0];

  const ftDocs = await db.execute(
    `SELECT id, titre, nom_fichier, chemin_fichier, source
     FROM documents
     WHERE categorie_id = (SELECT id FROM categories WHERE nom = 'Fiches techniques') AND statut = 'actif'
     ORDER BY source, titre`
  );
  const toutesLesFiches = ftDocs.rows;

  const rendu = (erreur) => res.render('bordereau-nouveau', { fiches: toutesLesFiches, erreur });

  if (!devisFile)    return rendu('Veuillez importer le devis PDF.');
  if (!bordereauFile) return rendu('Veuillez importer le bordereau .docx à remplir.');

  // Lire le devis
  let texteDevis = '';
  try {
    const parsed = await parseDevis(devisFile.path, devisFile.originalname);
    texteDevis = parsed.text || '';
  } catch (e) {
    try { fs.unlinkSync(devisFile.path); } catch (_) {}
    try { fs.unlinkSync(bordereauFile.path); } catch (_) {}
    return rendu('Impossible de lire le devis : ' + e.message);
  }
  try { fs.unlinkSync(devisFile.path); } catch (_) {}

  if (!texteDevis.trim()) {
    try { fs.unlinkSync(bordereauFile.path); } catch (_) {}
    return rendu('Le devis semble vide ou illisible.');
  }

  const bordereauBuffer = fs.readFileSync(bordereauFile.path);
  try { fs.unlinkSync(bordereauFile.path); } catch (_) {}

  // Extraction IA
  let champs;
  try {
    champs = await extraireChamps(texteDevis, nom_projet);
  } catch (e) {
    return rendu('Erreur IA : ' + e.message);
  }

  // Appliquer les identifications de l'utilisateur
  if (nom_projet       && nom_projet.trim())        champs.NOM_DU_PROJET  = nom_projet.trim();
  if (nom_entrepreneur && nom_entrepreneur.trim())  champs.NOM            = nom_entrepreneur.trim();
  if (specialite       && specialite.trim())        champs.SPECIALITE     = specialite.trim();
  if (adresse          && adresse.trim())           champs.ADRESSE        = adresse.trim();
  if (emis_par         && emis_par.trim())          champs.EMIS_PAR       = emis_par.trim();

  // Defaults fixes si non fournis
  if (!champs.NOM)        champs.NOM        = 'Toitures Trois Étoiles Inc.';
  if (!champs.SPECIALITE) champs.SPECIALITE = 'Couvreur';
  if (!champs.ADRESSE)    champs.ADRESSE    = '2215, rue Michelin, Laval (Québec) H7L 5B7';

  // Remplir le .docx (pour sauvegarder en DB)
  let docxBuffer;
  try {
    docxBuffer = await remplirBordereau(champs, bordereauBuffer);
  } catch (e) {
    return rendu('Erreur génération .docx : ' + e.message);
  }

  // Chemins des fiches sélectionnées
  const fichesPaths = fichesSelectionnees
    .map(id => toutesLesFiches.find(f => f.id === id))
    .filter(Boolean)
    .map(f => f.chemin_fichier ? path.join(__dirname, '..', '..', f.chemin_fichier) : null)
    .filter(Boolean);

  // Générer le PDF combiné (bordereau + fiches)
  let pdfBuffer;
  try {
    pdfBuffer = await genererPDFComplet(champs, fichesPaths);
  } catch (e) {
    return rendu('Erreur génération PDF : ' + e.message);
  }

  // Sauvegarder en DB
  try {
    await db.execute({
      sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, cree_par, devis_texte, template_data)
            VALUES (?, ?, ?, 'genere', ?, ?, ?)`,
      args: [
        champs.NUMERO_DU_PROJET || champs.SECTION || '',
        champs.NOM_DU_PROJET || nom_projet || 'Bordereau',
        JSON.stringify({ champs, fiches_ids: fichesSelectionnees }),
        champs.NOM || 'Utilisateur',
        texteDevis.substring(0, 10000),
        docxBuffer.toString('base64'),
      ]
    });
  } catch (e) { /* non-bloquant */ }

  const nomFichier = `Bordereau_${(champs.SECTION || 'T3E').replace(/\s/g, '-')}_${Date.now()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
  res.send(pdfBuffer);
});

// Re-télécharger le .docx d'un bordereau déjà généré
router.get('/telecharger/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0 || !r.rows[0].template_data) return res.status(404).send('Bordereau introuvable');
  const row = r.rows[0];
  const buf = Buffer.from(row.template_data, 'base64');
  const nomFichier = `Bordereau_${(row.numero_projet || row.id).toString().replace(/\s/g, '-')}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
  res.send(buf);
});

router.post('/supprimer/:id', async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  try { await db.execute({ sql: 'DELETE FROM historique_bordereaux WHERE bordereau_id = ?', args: [id] }); } catch (_) {}
  await db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [id] });
  res.redirect('/bordereaux');
});

module.exports = router;
