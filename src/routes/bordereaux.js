const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseDevis } = require('../services/document-parser');
const { remplirBordereau } = require('../services/bordereau-filler');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

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

  const prompt = `Tu es un expert en couverture commerciale au Québec. Lis attentivement ce devis et remplis TOUS les champs du bordereau de transmission de fiches techniques avec le maximum de précision et de détail — exactement comme le ferait un chargé de projet senior.

DEVIS :
${texteDevis.substring(0, 10000)}

${nomProjet ? `NOM DU PROJET (fourni par l'utilisateur) : ${nomProjet}` : ''}

Remplis chaque champ en te basant sur le contenu réel du devis. Sois précis, complet, professionnel.

Instructions détaillées par champ :
- NOM_DU_PROJET : Nom officiel complet du projet (ex: "Réfection de toiture — Polytechnique Montréal, pavillon Lassonde")
- NUMERO_DU_PROJET : Numéro de section CSC du devis (ex: "07 52 21")
- TITRE : "Fiches techniques — [description du système] — Section [numéro CSC]"
- NUMERO_DESSINS : "FT-[SECTION_SANS_ESPACES]-001" (ex: "FT-075221-001")
- DESCRIPTION : Description complète et détaillée du système de toiture : type de membrane, nombre de plis, isolant, pare-vapeur, méthode d'attache, revêtement de surface. Au moins 2-3 phrases.
- FOURNISSEUR : Nom complet du fournisseur/distributeur tel qu'il apparaît dans le devis
- FABRICANT : Nom du fabricant du produit principal
- SECTION : Numéro de section CSC exact (ex: "07 52 21")
- ARTICLE : Nom complet du produit principal avec désignation commerciale si disponible
- DELAI : Délai de livraison réaliste ("3 à 4 semaines" typiquement, "4 à 6 semaines" pour spéciaux)
- REMARQUE : Liste exhaustive de TOUS les matériaux requis avec fabricant (membrane base, membrane surface, isolant, colle/soudure, fixations mécaniques, closoirs, renforts, mastic, etc.). Architecte ou firme si mentionné dans le devis.

Retourne UNIQUEMENT un objet JSON valide, sans aucun texte avant ou après :
{
  "NOM_DU_PROJET": "...",
  "NUMERO_DU_PROJET": "...",
  "TITRE": "...",
  "NUMERO_DESSINS": "...",
  "DESCRIPTION": "...",
  "FOURNISSEUR": "...",
  "FABRICANT": "...",
  "SECTION": "...",
  "ARTICLE": "...",
  "DELAI": "...",
  "REMARQUE": "..."
}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Tu es un expert en toiture commerciale au Québec. Remplis chaque champ avec précision et détail, comme un chargé de projet expérimenté. Réponds uniquement en JSON valide.' },
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
//  Routes
// ──────────────────────────────────────────────

router.get('/', async (req, res) => {
  const db = req.db;
  const r = await db.execute('SELECT id, titre, numero_projet, cree_par, created_at FROM bordereaux WHERE statut != \'preview\' ORDER BY created_at DESC');
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

// ──────────────────────────────────────────────
//  ÉTAPE 1 : upload + extraction IA → retourne JSON pour la modale
// ──────────────────────────────────────────────
router.post('/generer', uploadFields, async (req, res) => {
  const db = req.db;
  const { nom_projet, nom_entrepreneur, specialite, adresse, emis_par } = req.body;
  const fichesSelectionnees = Array.isArray(req.body.fiches) ? req.body.fiches.map(Number)
    : req.body.fiches ? [Number(req.body.fiches)] : [];

  const devisFile     = req.files && req.files.devis     && req.files.devis[0];
  const bordereauFile = req.files && req.files.bordereau && req.files.bordereau[0];

  const erreurJson = (msg) => res.status(400).json({ erreur: msg });

  if (!devisFile)     return erreurJson('Veuillez importer le devis PDF.');
  if (!bordereauFile) return erreurJson('Veuillez importer le bordereau .docx à remplir.');

  // Lire le devis PDF
  let texteDevis = '';
  try {
    const parsed = await parseDevis(devisFile.path, devisFile.originalname);
    texteDevis = parsed.text || '';
  } catch (e) {
    try { fs.unlinkSync(devisFile.path); } catch (_) {}
    try { fs.unlinkSync(bordereauFile.path); } catch (_) {}
    return erreurJson('Impossible de lire le devis : ' + e.message);
  }
  try { fs.unlinkSync(devisFile.path); } catch (_) {}

  if (!texteDevis.trim()) {
    try { fs.unlinkSync(bordereauFile.path); } catch (_) {}
    return erreurJson('Le devis semble vide ou illisible.');
  }

  const bordereauBuffer = fs.readFileSync(bordereauFile.path);
  try { fs.unlinkSync(bordereauFile.path); } catch (_) {}

  // Extraction IA
  let champs;
  try {
    champs = await extraireChamps(texteDevis, nom_projet);
  } catch (e) {
    return erreurJson('Erreur IA : ' + e.message);
  }

  // Identification fournie par l'utilisateur (override)
  const identification = {
    NOM:       nom_entrepreneur?.trim() || 'Toitures Trois Étoiles Inc.',
    SPECIALITE: specialite?.trim()      || 'Couvreur',
    ADRESSE:   adresse?.trim()          || '2215, rue Michelin, Laval (Québec) H7L 5B7',
    EMIS_PAR:  emis_par?.trim()         || '',
  };

  // Sauvegarder en DB comme brouillon (template_data = bordereau buffer, statut = preview)
  let brouillonId;
  try {
    const r = await db.execute({
      sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, cree_par, devis_texte, template_data)
            VALUES (?, ?, ?, 'preview', ?, ?, ?)`,
      args: [
        champs.SECTION || '',
        champs.NOM_DU_PROJET || nom_projet || 'Bordereau',
        JSON.stringify({ champs, identification, fiches_ids: fichesSelectionnees }),
        identification.NOM,
        texteDevis.substring(0, 10000),
        bordereauBuffer.toString('base64'),
      ]
    });
    brouillonId = r.lastInsertRowid || r.rows?.[0]?.id;
  } catch (e) {
    return erreurJson('Erreur sauvegarde : ' + e.message);
  }

  // Retourner les champs extraits pour affichage dans la modale
  res.json({
    id: brouillonId,
    champs,
    identification,
    fiches_ids: fichesSelectionnees,
  });
});

// ──────────────────────────────────────────────
//  ÉTAPE 2 : confirmation → remplit le .docx et renvoie le fichier
// ──────────────────────────────────────────────
router.post('/confirmer/:id', express.json(), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const { champs, identification, fiches_ids } = req.body;

  // Charger le brouillon
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).json({ erreur: 'Brouillon introuvable.' });

  const row = r.rows[0];
  const bordereauBuffer = Buffer.from(row.template_data, 'base64');

  // Fusionner identification dans les champs
  const champsFinaux = { ...champs, ...identification };

  // Remplir le .docx — processus inchangé
  let docxBuffer;
  try {
    docxBuffer = await remplirBordereau(champsFinaux, bordereauBuffer);
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur remplissage : ' + e.message });
  }

  // Mettre à jour le statut en DB
  try {
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'genere', numero_projet = ?, titre = ?, contenu = ?, template_data = ? WHERE id = ?`,
      args: [
        champsFinaux.NUMERO_DU_PROJET || champsFinaux.SECTION || '',
        champsFinaux.NOM_DU_PROJET || '',
        JSON.stringify({ champs: champsFinaux, fiches_ids }),
        docxBuffer.toString('base64'),
        id,
      ]
    });
  } catch (_) {}

  const section = (champsFinaux.SECTION || 'T3E').replace(/\s/g, '-');
  const ts = Date.now();

  // Sans fiches → .docx direct
  const fichesIds = Array.isArray(fiches_ids) ? fiches_ids.map(Number).filter(Boolean) : [];
  if (fichesIds.length === 0) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.docx"`);
    return res.send(docxBuffer);
  }

  // Avec fiches → ZIP : bordereau.docx + fiches fusionnées en PDF
  const JSZip = require('jszip');
  const { PDFDocument } = require('pdf-lib');

  // Charger les fiches depuis la DB
  const ftRows = (await db.execute({
    sql: `SELECT id, titre, chemin_fichier FROM documents WHERE id IN (${fichesIds.map(() => '?').join(',')})`,
    args: fichesIds
  })).rows;

  const zip = new JSZip();
  zip.file(`Bordereau_${section}.docx`, docxBuffer);

  const fichesDoc = await PDFDocument.create();
  for (const fiche of ftRows) {
    if (!fiche.chemin_fichier) continue;
    const ftPath = path.join(__dirname, '..', '..', fiche.chemin_fichier);
    if (!fs.existsSync(ftPath)) continue;
    try {
      const ftBuf = fs.readFileSync(ftPath);
      const ftDoc = await PDFDocument.load(ftBuf, { ignoreEncryption: true });
      const pages = await fichesDoc.copyPages(ftDoc, ftDoc.getPageIndices());
      pages.forEach(p => fichesDoc.addPage(p));
    } catch (_) {}
  }

  const fichesPdf = await fichesDoc.save();
  zip.file(`Fiches_Techniques_${section}.pdf`, fichesPdf);

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.zip"`);
  res.send(zipBuffer);
});

// Annuler un brouillon
router.post('/annuler/:id', async (req, res) => {
  const db = req.db;
  try { await db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ? AND statut = \'preview\'', args: [parseInt(req.params.id)] }); } catch (_) {}
  res.json({ ok: true });
});

// Re-télécharger le .docx sauvegardé
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
