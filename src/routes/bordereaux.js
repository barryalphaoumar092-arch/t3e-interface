const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib } = require('pdf-lib');
const { parseDevis, parseTemplate, extractProjectInfo } = require('../services/document-parser');
const { matchMaterials } = require('../services/material-matcher');

const DOCS_DIR = path.join(__dirname, '..', '..', 'documents');

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

  let contenu = { version: 2, devis: null, template: null, supplements: [], projet: {}, materiaux_matches: [] };
  let devisTexte = '';
  let templateTexte = '';
  let supplementsTexte = '';

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

function findFtFile(fabricant) {
  if (!fabricant) return [];
  const ftDir = path.join(DOCS_DIR, 'FT');
  if (!fs.existsSync(ftDir)) return [];

  const fabNorm = fabricant.toLowerCase().trim();
  const dirs = fs.readdirSync(ftDir).filter(d => {
    const stat = fs.statSync(path.join(ftDir, d));
    return stat.isDirectory() && d.toLowerCase().includes(fabNorm.substring(0, 4));
  });

  const pdfs = [];
  for (const dir of dirs) {
    const dirPath = path.join(ftDir, dir);
    for (const f of fs.readdirSync(dirPath)) {
      if (f.toLowerCase().endsWith('.pdf')) {
        pdfs.push(path.join(dirPath, f));
      }
    }
  }
  return pdfs;
}

function generateBordereauPage(doc, mat, projet, row, index) {
  if (index > 0) doc.addPage();

  const left = 50;
  const right = 562;
  let y = 50;

  doc.rect(left, y, right - left, 30).fill('#003366');
  doc.fillColor('white').fontSize(12).font('Helvetica-Bold');
  doc.text('IDENTIFICATION DE DESSINS D\'ATELIER, ÉCHANTILLONS ET FICHES TECHNIQUES', left + 10, y + 8, { width: right - left - 20, align: 'center' });
  y += 40;
  doc.fillColor('black');

  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('NOM DU PROJET :', left, y); doc.font('Helvetica').text(projet.client || row.titre || '', left + 120, y);
  y += 18;
  doc.font('Helvetica-Bold').text('NUMÉRO DU PROJET :', left, y); doc.font('Helvetica').text(projet.numero || '', left + 120, y);
  y += 25;

  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).stroke('#003366');
  y += 8;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#003366').text('IDENTIFICATION DE L\'ENTREPRENEUR', left, y);
  doc.fillColor('black');
  y += 18;

  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('NOM :', left, y); doc.font('Helvetica').text('Toitures Trois Étoiles', left + 80, y);
  y += 16;
  doc.font('Helvetica-Bold').text('SPÉCIALITÉ :', left, y); doc.font('Helvetica').text('Couvreur', left + 80, y);
  y += 16;
  doc.font('Helvetica-Bold').text('ADRESSE :', left, y); doc.font('Helvetica').text(projet.adresse || '', left + 80, y);
  y += 25;

  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).stroke('#003366');
  y += 8;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#003366').text('IDENTIFICATION', left, y);
  doc.fillColor('black');
  y += 20;

  doc.fontSize(9);
  const checkFT = '☑'; const unchk = '☐';
  doc.font('Helvetica').text(`${unchk} Dessin d'atelier          ${unchk} Échantillon          ${checkFT} Fiche technique`, left, y);
  y += 16;
  doc.text(`Ligne numéro : ${index + 1}`, left + 350, y - 16);

  doc.font('Helvetica-Bold').text('Titre :', left, y);
  doc.font('Helvetica').text(mat.nom || '', left + 80, y);
  y += 16;

  doc.font('Helvetica-Bold').text('Description :', left, y);
  doc.font('Helvetica').text(`${mat.type_produit || ''} ${mat.type_systeme ? '- ' + mat.type_systeme : ''} ${mat.dimension ? '(' + mat.dimension + ')' : ''}`, left + 80, y);
  y += 16;

  doc.font('Helvetica-Bold').text('Fournisseur :', left, y);
  doc.font('Helvetica').text(mat.fabricant || '', left + 80, y);
  doc.font('Helvetica-Bold').text('Fabricant :', left + 280, y);
  doc.font('Helvetica').text(mat.fabricant || '', left + 350, y);
  y += 16;

  doc.font('Helvetica').text(`${checkFT} Tel que plans et devis`, left, y);
  y += 16;

  if (mat.lien_fiche_technique) {
    doc.font('Helvetica-Bold').text('Fiche technique :', left, y);
    doc.font('Helvetica').fillColor('blue').text('Voir page suivante', left + 110, y).fillColor('black');
    y += 16;
  }
  if (mat.lien_fiche_securite) {
    doc.font('Helvetica-Bold').text('Fiche SDS :', left, y);
    doc.font('Helvetica').text(mat.lien_fiche_securite, left + 110, y, { width: 400 });
    y += 16;
  }
  y += 15;

  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).stroke('#003366');
  y += 8;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#003366').text('SUIVI', left, y);
  doc.fillColor('black');
  y += 20;

  doc.fontSize(9).font('Helvetica-Bold');
  doc.text('REÇU DE L\'ENTREPRENEUR LE :', left, y);
  doc.font('Helvetica').text('_______________', left + 190, y);
  y += 25;
  doc.font('Helvetica-Bold').text('RETOUR DU PROFESSIONNEL LE :', left, y);
  doc.font('Helvetica').text('_______________', left + 200, y);
  y += 35;

  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke();
  y += 15;
  doc.fontSize(9);
  doc.text('ÉMIS PAR : ___________________________________', left, y);
  doc.text('Date : _______________', left + 350, y);
  y += 12;
  doc.fontSize(7).fillColor('#666').text('Signature de l\'entrepreneur', left + 65, y).fillColor('black');
  y += 18;
  doc.fontSize(9).text('SOUMIS PAR : _________________________________', left, y);
  doc.text('Date : _______________', left + 350, y);
  y += 12;
  doc.fontSize(7).fillColor('#666').text('Signature de Toitures Trois Étoiles', left + 75, y).fillColor('black');
}

router.get('/pdf/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau non trouvé');

  const row = r.rows[0];
  const contenu = JSON.parse(row.contenu || '{}');
  const projet = contenu.projet || {};
  const materiaux = (contenu.materiaux_matches || []).filter(m => m.confirmed !== false);

  if (materiaux.length === 0) {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bordereau-${projet.numero || row.id}.pdf"`);
    doc.pipe(res);
    doc.fontSize(14).text('Aucun matériau confirmé dans ce bordereau.', { align: 'center' });
    doc.end();
    return;
  }

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const bordereauPdf = new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  materiaux.forEach((mat, i) => generateBordereauPage(doc, mat, projet, row, i));
  doc.end();

  const bordereauBuffer = await bordereauPdf;

  const finalPdf = await PDFLib.create();

  const bordereauDoc = await PDFLib.load(bordereauBuffer);
  const bordereauPages = await finalPdf.copyPages(bordereauDoc, bordereauDoc.getPageIndices());

  for (let i = 0; i < materiaux.length; i++) {
    finalPdf.addPage(bordereauPages[i]);

    const mat = materiaux[i];
    const ftFiles = findFtFile(mat.fabricant);
    for (const ftPath of ftFiles) {
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

  const finalBuffer = await finalPdf.save();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="bordereau-${projet.numero || row.id}.pdf"`);
  res.send(Buffer.from(finalBuffer));
});

module.exports = router;
