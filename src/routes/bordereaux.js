const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseDevis } = require('../services/document-parser');
const { remplirBordereau } = require('../services/bordereau-filler');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 20 * 1024 * 1024 } });

// ──────────────────────────────────────────────
//  Extraction des champs via OpenAI
// ──────────────────────────────────────────────
async function extraireChamps(texteDevis, nomProjet) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante sur Render.');

  const prompt = `Tu remplis un bordereau de transmission de fiches techniques pour Toitures Trois Étoiles Inc. (T3E), couvreur commercial au Québec.

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
//  Routes
// ──────────────────────────────────────────────

router.get('/', async (req, res) => {
  const db = req.db;
  const r = await db.execute('SELECT id, titre, numero_projet, cree_par, created_at FROM bordereaux ORDER BY created_at DESC');
  res.render('bordereaux', { bordereaux: r.rows });
});

router.get('/nouveau', (req, res) => {
  res.render('bordereau-nouveau');
});

// Génération complète : upload devis → IA → .docx rempli → téléchargement
router.post('/generer', upload.single('devis'), async (req, res) => {
  const db = req.db;
  const { nom_projet } = req.body;

  if (!req.file) return res.render('bordereau-nouveau', { erreur: 'Veuillez importer le devis PDF.' });

  let texteDevis = '';
  try {
    const parsed = await parseDevis(req.file.path, req.file.originalname);
    texteDevis = parsed.text || '';
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.render('bordereau-nouveau', { erreur: 'Impossible de lire le devis : ' + e.message });
  }
  try { fs.unlinkSync(req.file.path); } catch (_) {}

  if (!texteDevis.trim()) {
    return res.render('bordereau-nouveau', { erreur: 'Le devis semble vide ou illisible.' });
  }

  let champs;
  try {
    champs = await extraireChamps(texteDevis, nom_projet);
  } catch (e) {
    return res.render('bordereau-nouveau', { erreur: 'Erreur IA : ' + e.message });
  }

  // Utiliser le nom fourni par l'utilisateur s'il a été saisi
  if (nom_projet && nom_projet.trim()) champs.NOM_DU_PROJET = nom_projet.trim();

  let docxBuffer;
  try {
    docxBuffer = await remplirBordereau(champs);
  } catch (e) {
    return res.render('bordereau-nouveau', { erreur: 'Erreur génération .docx : ' + e.message });
  }

  // Sauvegarder en DB pour re-téléchargement
  try {
    await db.execute({
      sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, cree_par, devis_texte, template_data)
            VALUES (?, ?, ?, 'genere', 'Utilisateur', ?, ?)`,
      args: [
        champs.NUMERO_DU_PROJET || champs.SECTION || '',
        champs.NOM_DU_PROJET || nom_projet || 'Bordereau',
        JSON.stringify(champs),
        texteDevis.substring(0, 10000),
        docxBuffer.toString('base64'),
      ]
    });
  } catch (e) { /* non-bloquant */ }

  const nomFichier = `Bordereau_${(champs.SECTION || 'T3E').replace(/\s/g, '-')}_${Date.now()}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
  res.send(docxBuffer);
});

// Re-télécharger un bordereau déjà généré
router.get('/telecharger/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0 || !r.rows[0].template_data) return res.status(404).send('Bordereau introuvable');

  const row = r.rows[0];
  const buf = Buffer.from(row.template_data, 'base64');
  const nomFichier = `Bordereau_${(row.numero_projet || row.titre || row.id).toString().replace(/\s/g, '-')}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${nomFichier}"`);
  res.send(buf);
});

router.post('/supprimer/:id', async (req, res) => {
  const db = req.db;
  await db.execute({ sql: 'DELETE FROM historique_bordereaux WHERE bordereau_id = ?', args: [parseInt(req.params.id)] });
  await db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  res.redirect('/bordereaux');
});

module.exports = router;
