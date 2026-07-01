const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createSignedUploadUrl, sanitizeKey, BUCKETS } = require('../services/storage');

// URL d'upload signee — le navigateur envoie ensuite le fichier DIRECTEMENT a
// Supabase Storage, en contournant la limite de 4.5 Mo par requete des
// fonctions serverless Vercel. `dest` est restreint a une liste blanche.
const UPLOAD_DESTS = {
  temp: BUCKETS.UPLOADS_TEMP,
  documents: BUCKETS.DOCUMENTS,
};

router.post('/upload-url', async (req, res) => {
  const { filename, dest } = req.body || {};
  const bucket = UPLOAD_DESTS[dest];
  if (!filename || !bucket) return res.status(400).json({ error: 'Parametres invalides' });

  const key = dest === 'temp'
    ? `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${sanitizeKey(filename)}`
    : sanitizeKey(filename);

  try {
    const { signedUrl, token, path } = await createSignedUploadUrl(bucket, key);
    res.json({ bucket, key: path || key, signedUrl, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/recherche', async (req, res) => {
  const db = req.db;
  const q = req.query.q || '';
  if (!q) return res.json({ documents: [], materiaux: [], architectes: [] });

  const like = `%${q}%`;

  const docs = await db.execute({
    sql: `SELECT d.id, d.titre, c.nom as categorie, d.description, d.source, d.annee, d.nom_fichier, d.type_fichier
          FROM documents d JOIN categories c ON d.categorie_id = c.id
          WHERE d.statut = 'actif' AND (d.titre LIKE ? OR d.description LIKE ? OR d.mots_cles LIKE ? OR c.nom LIKE ?)
          ORDER BY c.nom, d.titre LIMIT 50`,
    args: [like, like, like, like]
  });

  const mats = await db.execute({
    sql: `SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, lien_fiche_technique, lien_fiche_securite
          FROM materiaux
          WHERE nom LIKE ? OR fabricant LIKE ? OR type_produit LIKE ? OR type_systeme LIKE ?
          ORDER BY type_produit, nom LIMIT 50`,
    args: [like, like, like, like]
  });

  const archs = await db.execute({
    sql: `SELECT id, firme, ville, telephone, email, contact, site_web
          FROM architectes
          WHERE firme LIKE ? OR ville LIKE ? OR contact LIKE ?
          ORDER BY firme LIMIT 50`,
    args: [like, like, like]
  });

  res.json({
    documents: docs.rows.map(r => ({ id: r.id, titre: r.titre, categorie: r.categorie, description: r.description, source: r.source, annee: r.annee, fichier: r.nom_fichier, type: r.type_fichier })),
    materiaux: mats.rows.map(r => ({ id: r.id, nom: r.nom, fabricant: r.fabricant, type_produit: r.type_produit, type_systeme: r.type_systeme, fournisseur: r.fournisseur, dimension: r.dimension, lien_ft: r.lien_fiche_technique, lien_sds: r.lien_fiche_securite })),
    architectes: archs.rows
  });
});

router.get('/materiaux', async (req, res) => {
  const db = req.db;
  const q = req.query.q || '';
  const fab = req.query.fabricant || '';
  const type = req.query.type || '';

  let sql = `SELECT id, nom, fabricant, type_produit, type_systeme, fournisseur, dimension, unite, lien_fiche_technique, lien_fiche_securite FROM materiaux WHERE 1=1`;
  const args = [];
  if (q) { sql += ` AND (nom LIKE ? OR fabricant LIKE ?)`; args.push(`%${q}%`, `%${q}%`); }
  if (fab) { sql += ` AND fabricant = ?`; args.push(fab); }
  if (type) { sql += ` AND type_produit = ?`; args.push(type); }
  sql += ' ORDER BY type_produit, fabricant, nom LIMIT 100';

  const r = await db.execute({ sql, args });
  res.json(r.rows.map(row => ({
    ...row, lien_ft: row.lien_fiche_technique, lien_sds: row.lien_fiche_securite
  })));
});

router.post('/chat', async (req, res) => {
  const { message, contexte, historique } = req.body;
  if (!message) return res.json({ reponse: '' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) {
    return res.json({ reponse: "L'assistant IA n'est pas activé. Ajoutez OPENAI_API_KEY dans les variables d'environnement Render." });
  }

  const systemPrompt = `Tu es l'assistant IA intégré à l'interface T3E de Toitures Trois Étoiles Inc., une entreprise de couverture commerciale au Québec.
Tu aides les estimateurs avec : soumissions (devis de prix), bordereaux techniques, choix de systèmes de toiture, matériaux, garanties.
Tu connais les systèmes : BUR (asphalte et gravier), Soprasmart (panneau laminé), Soprafix (fixation mécanique), Colvent, EPDM/PVC, TPO/PVC Rhinobond, Toiture Inversée, Ancestral.
Réponds toujours en français québécois, de façon concise et professionnelle. Maximum 4-5 phrases par réponse sauf si plus de détails sont demandés.
${contexte ? '\nContexte de la page : ' + contexte : ''}`;

  const messages = [];
  if (Array.isArray(historique)) {
    historique.slice(-8).forEach(function(h) {
      if (h.role && h.content) messages.push({ role: h.role, content: h.content });
    });
  }
  messages.push({ role: 'user', content: message });

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 600,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('OpenAI chat error:', resp.status, errText);
    return res.json({ reponse: 'Erreur de connexion à l\'IA (' + resp.status + ').' });
  }

  const data = await resp.json();
  const reponse = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || 'Pas de réponse.';
  res.json({ reponse });
});

module.exports = router;
