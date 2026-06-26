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

  const prompt = `Tu es un expert en couverture commerciale au Québec. Tu dois remplir TOUS les champs d'un bordereau de transmission de fiches techniques à partir d'un devis de construction.

DEVIS COMPLET :
${texteDevis.substring(0, 8000)}

NOM DU PROJET (si fourni par l'utilisateur) : ${nomProjet || '— à extraire du devis —'}

INSTRUCTIONS PAR CHAMP — sois précis et complet, comme le ferait un chargé de projet expérimenté :

- NOM_DU_PROJET : Nom officiel et complet du projet tel qu'il apparaît dans le devis (ex: "Réfection de toiture — Polytechnique Montréal — Bâtiment Principal")
- NUMERO_DU_PROJET : Numéro de section CSC ou numéro de devis (ex: "07 52 21", "07 52 00", "07520")
- TITRE : "Fiches techniques — [nom du système de toiture] — Section [numéro]" (ex: "Fiches techniques — Membrane bitumineuse SBS — Section 07 52 21")
- NUMERO_DESSINS : "FT-[SECTION SANS ESPACES]-001" (ex: "FT-075221-001")
- DESCRIPTION : Description détaillée du système de toiture complet — type de membrane, isolant, pare-vapeur, méthode de pose, nombre de plis. Minimum 2 phrases. (ex: "Système de toiture en membrane de bitume modifié SBS bicouche, posée à chaud sur isolant polyisocyanurate de 2 po. Pare-vapeur en bitume modifié SBS soudé à la flamme.")
- FOURNISSEUR : Nom complet du fournisseur ou distributeur mentionné dans le devis (ex: "Soprema Inc.", "IKO Industries", "BP Canada")
- FABRICANT : Nom du fabricant du produit principal (souvent identique au fournisseur pour les toitures : "Soprema", "IKO", "BP")
- SECTION : Numéro de section CSC exact tel qu'écrit dans le devis (ex: "07 52 21", "07 52 00")
- ARTICLE : Type de produit principal avec spécifications (ex: "Membrane de bitume modifié SBS — Sopralène Flam 180", "Membrane d'asphalte modifié APP — IKO Torchflex")
- DELAI : Délai de livraison habituel pour ce type de matériau (ex: "3 à 4 semaines", "4 à 6 semaines" pour produits spéciaux)
- REMARQUE : Liste complète des matériaux requis avec fabricant et normes si disponibles. Inclure : membrane de base, membrane de surface, isolant, fixations, mastics, renforts. Mentionner l'architecte/ingénieur si nommé dans le devis. Format : "Matériaux requis : [liste]. Architecte : [nom si disponible]."

Retourne UNIQUEMENT ce JSON valide (aucun texte avant ou après) :
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

// Génération : devis PDF + bordereau .docx → IA → .docx rempli (+ fiches en ZIP si sélectionnées)
router.post('/generer', uploadFields, async (req, res) => {
  const db = req.db;
  const { nom_projet, nom_entrepreneur, specialite, adresse, emis_par } = req.body;
  const fichesSelectionnees = Array.isArray(req.body.fiches) ? req.body.fiches.map(Number)
    : req.body.fiches ? [Number(req.body.fiches)] : [];

  const devisFile     = req.files && req.files.devis     && req.files.devis[0];
  const bordereauFile = req.files && req.files.bordereau && req.files.bordereau[0];

  // Liste complète pour re-render en cas d'erreur
  const toutesLesFichesDispo = (await db.execute(
    `SELECT id, titre, nom_fichier, chemin_fichier, source
     FROM documents
     WHERE categorie_id = (SELECT id FROM categories WHERE nom = 'Fiches techniques') AND statut = 'actif'
     ORDER BY source, titre`
  )).rows;

  const toutesLesFiches = fichesSelectionnees.length > 0
    ? toutesLesFichesDispo.filter(f => fichesSelectionnees.includes(f.id))
    : [];

  const rendu = (erreur) => res.render('bordereau-nouveau', {
    fiches: toutesLesFichesDispo,
    erreur
  });

  if (!devisFile)     return rendu('Veuillez importer le devis PDF.');
  if (!bordereauFile) return rendu('Veuillez importer le bordereau .docx à remplir.');

  // Lire le devis PDF
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

  // Identifications saisies par l'utilisateur
  if (nom_projet       && nom_projet.trim())        champs.NOM_DU_PROJET  = nom_projet.trim();
  if (nom_entrepreneur && nom_entrepreneur.trim())  champs.NOM            = nom_entrepreneur.trim();
  if (specialite       && specialite.trim())        champs.SPECIALITE     = specialite.trim();
  if (adresse          && adresse.trim())           champs.ADRESSE        = adresse.trim();
  if (emis_par         && emis_par.trim())          champs.EMIS_PAR       = emis_par.trim();

  // Remplir le .docx avec le template fourni — processus inchangé
  let docxBuffer;
  try {
    docxBuffer = await remplirBordereau(champs, bordereauBuffer);
  } catch (e) {
    return rendu('Erreur remplissage bordereau : ' + e.message);
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

  const section = (champs.SECTION || 'T3E').replace(/\s/g, '-');
  const ts = Date.now();

  // Pas de fiches → retourner directement le .docx (comportement original)
  if (toutesLesFiches.length === 0) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.docx"`);
    return res.send(docxBuffer);
  }

  // Avec fiches → ZIP : bordereau.docx + fiches fusionnées en PDF
  const JSZip = require('jszip');
  const { PDFDocument } = require('pdf-lib');

  const zip = new JSZip();
  zip.file(`Bordereau_${section}.docx`, docxBuffer);

  // Fusionner les fiches sélectionnées en un seul PDF
  const fichesDoc = await PDFDocument.create();
  for (const fiche of toutesLesFiches) {
    if (!fiche.chemin_fichier) continue;
    const fichePath = path.join(__dirname, '..', '..', fiche.chemin_fichier);
    if (!fs.existsSync(fichePath)) continue;
    try {
      const ftBuf = fs.readFileSync(fichePath);
      const ftDoc = await PDFDocument.load(ftBuf, { ignoreEncryption: true });
      const pages = await fichesDoc.copyPages(ftDoc, ftDoc.getPageIndices());
      pages.forEach(p => fichesDoc.addPage(p));
    } catch (_) { /* fiche illisible — on passe */ }
  }

  const fichesPdf = await fichesDoc.save();
  zip.file(`Fiches_Techniques_${section}.pdf`, fichesPdf);

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.zip"`);
  res.send(zipBuffer);
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
