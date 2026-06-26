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

// ──────────────────────────────────────────────────────
//  Prompt système — définit le comportement de l'IA
// ──────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es un chargé de projet expert en couverture commerciale au Québec. Tu remplis un bordereau de transmission de fiches techniques étape par étape, en proposant des valeurs et en demandant confirmation à l'utilisateur.

PROCESSUS EN 5 ÉTAPES :
Étape 1 — Identification du projet : NOM_DU_PROJET, NUMERO_DU_PROJET, SECTION
Étape 2 — Titre et numérotation : TITRE, NUMERO_DESSINS
Étape 3 — Description du système : DESCRIPTION, ARTICLE
Étape 4 — Fournisseurs : FOURNISSEUR, FABRICANT
Étape 5 — Délai et remarques : DELAI, REMARQUE

RÈGLES :
- Pour chaque étape, propose des valeurs précises extraites du devis
- Explique brièvement d'où viennent les informations
- Si l'utilisateur dit "OUI" → passe à l'étape suivante
- Si l'utilisateur dit "NON" → annule tout
- Si l'utilisateur dit "AUTRE: [correction]" → tiens compte de la correction et re-propose cette étape
- À l'étape 5, après confirmation, génère le JSON final

FORMAT DE RÉPONSE OBLIGATOIRE — toujours du JSON valide uniquement :

Pour une proposition (étapes 1 à 5) :
{"type":"proposition","etape":N,"titre":"...","message":"...","champs":{"CHAMP1":"valeur","CHAMP2":"valeur"}}

Pour la réponse finale (après confirmation de l'étape 5) :
{"type":"final","champs":{"NOM_DU_PROJET":"...","NUMERO_DU_PROJET":"...","TITRE":"...","NUMERO_DESSINS":"...","DESCRIPTION":"...","FOURNISSEUR":"...","FABRICANT":"...","SECTION":"...","ARTICLE":"...","DELAI":"...","REMARQUE":"..."}}

Ne mets AUCUN texte en dehors du JSON.`;

// ──────────────────────────────────────────────────────
//  Appel OpenAI
// ──────────────────────────────────────────────────────
async function appelIA(messages) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante sur Render.');

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('OpenAI ' + resp.status + ': ' + txt.substring(0, 300));
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  return { parsed: JSON.parse(content), raw: content };
}

// ──────────────────────────────────────────────────────
//  Routes principales
// ──────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const db = req.db;
  const r = await db.execute("SELECT id, titre, numero_projet, cree_par, created_at FROM bordereaux WHERE (session_actif = 0 OR session_actif IS NULL) ORDER BY created_at DESC");
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
  res.render('bordereau-nouveau', { fiches: ftDocs.rows });
});

// ──────────────────────────────────────────────────────
//  ÉTAPE 1 : Démarrer la session — upload + première proposition IA
// ──────────────────────────────────────────────────────
router.post('/demarrer', uploadFields, async (req, res) => {
  const db = req.db;
  const { nom_projet, nom_entrepreneur, specialite, adresse, emis_par } = req.body;
  const fichesSelectionnees = Array.isArray(req.body.fiches) ? req.body.fiches.map(Number)
    : req.body.fiches ? [Number(req.body.fiches)] : [];

  const devisFile     = req.files?.devis?.[0];
  const bordereauFile = req.files?.bordereau?.[0];

  if (!devisFile)     return res.status(400).json({ erreur: 'Veuillez importer le devis PDF.' });
  if (!bordereauFile) return res.status(400).json({ erreur: 'Veuillez importer le bordereau .docx à remplir.' });

  // Lire le devis
  let texteDevis = '';
  try {
    const parsed = await parseDevis(devisFile.path, devisFile.originalname);
    texteDevis = parsed.text || '';
  } catch (e) {
    return res.status(400).json({ erreur: 'Impossible de lire le devis : ' + e.message });
  } finally {
    try { fs.unlinkSync(devisFile.path); } catch (_) {}
  }

  if (!texteDevis.trim()) {
    try { fs.unlinkSync(bordereauFile.path); } catch (_) {}
    return res.status(400).json({ erreur: 'Le devis semble vide ou illisible.' });
  }

  const bordereauBuffer = fs.readFileSync(bordereauFile.path);
  try { fs.unlinkSync(bordereauFile.path); } catch (_) {}

  // Identification fournie par l'utilisateur
  const identification = {
    NOM:       nom_entrepreneur?.trim() || 'Toitures Trois Étoiles Inc.',
    SPECIALITE: specialite?.trim()      || 'Couvreur',
    ADRESSE:   adresse?.trim()          || '2215, rue Michelin, Laval (Québec) H7L 5B7',
    EMIS_PAR:  emis_par?.trim()         || '',
  };

  // Premier message vers l'IA : lire le devis et proposer étape 1
  const premierMessage = `DEVIS À ANALYSER :
${texteDevis.substring(0, 10000)}

${nom_projet ? `NOM DU PROJET fourni par l'utilisateur : ${nom_projet}` : ''}

Commence l'étape 1 : analyse le devis et propose l'identification du projet (NOM_DU_PROJET, NUMERO_DU_PROJET, SECTION). Explique ce que tu as trouvé dans le devis pour justifier tes choix.`;

  let iaResult;
  try {
    const messages = [{ role: 'user', content: premierMessage }];
    iaResult = await appelIA(messages);
    messages.push({ role: 'assistant', content: iaResult.raw });

    // Sauvegarder la session en DB
    const r = await db.execute({
      sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, session_actif, cree_par, devis_texte, template_data)
            VALUES (?, ?, ?, 'brouillon', 1, ?, ?, ?)`,
      args: [
        '',
        nom_projet || 'Bordereau en cours',
        JSON.stringify({ messages, identification, fiches_ids: fichesSelectionnees, champs_confirmes: {} }),
        identification.NOM,
        texteDevis.substring(0, 10000),
        bordereauBuffer.toString('base64'),
      ]
    });

    const sessionId = r.lastInsertRowid || null;
    return res.json({ sessionId, ...iaResult.parsed });

  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur IA : ' + e.message });
  }
});

// ──────────────────────────────────────────────────────
//  ÉTAPE N : Répondre à une proposition IA (oui/non/autre)
// ──────────────────────────────────────────────────────
router.post('/repondre/:id', express.json(), async (req, res) => {
  const db = req.db;
  const sessionId = parseInt(req.params.id);
  const { reponse, correction } = req.body; // reponse: 'oui'|'non'|'autre', correction: string optionnel

  // Charger la session
  const r = await db.execute({ sql: "SELECT * FROM bordereaux WHERE id = ? AND session_actif = 1", args: [sessionId] });
  if (r.rows.length === 0) return res.status(404).json({ erreur: 'Session introuvable.' });

  const session = JSON.parse(r.rows[0].contenu);
  const { messages, identification, fiches_ids, champs_confirmes } = session;

  if (reponse === 'non') {
    // Annuler — supprimer la session
    await db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [sessionId] });
    return res.json({ type: 'annule' });
  }

  // Construire le message utilisateur
  let msgUtilisateur;
  if (reponse === 'oui') {
    msgUtilisateur = 'OUI — confirme et passe à l\'étape suivante.';
  } else {
    msgUtilisateur = `AUTRE — voici ma correction : ${correction || ''}. Tiens-en compte et re-propose cette étape avec les corrections.`;
  }

  messages.push({ role: 'user', content: msgUtilisateur });

  // Appel IA avec l'historique complet
  let iaResult;
  try {
    iaResult = await appelIA(messages);
  } catch (e) {
    return res.status(500).json({ erreur: 'Erreur IA : ' + e.message });
  }

  messages.push({ role: 'assistant', content: iaResult.raw });

  // Si réponse finale → générer le .docx
  if (iaResult.parsed.type === 'final') {
    const champsFinaux = { ...iaResult.parsed.champs, ...identification };
    const bordereauBuffer = Buffer.from(r.rows[0].template_data, 'base64');

    let docxBuffer;
    try {
      docxBuffer = await remplirBordereau(champsFinaux, bordereauBuffer);
    } catch (e) {
      return res.status(500).json({ erreur: 'Erreur remplissage : ' + e.message });
    }

    // Mettre à jour en DB (statut genere)
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'brouillon', session_actif = 0, numero_projet = ?, titre = ?, contenu = ?, template_data = ? WHERE id = ?`,
      args: [
        champsFinaux.NUMERO_DU_PROJET || champsFinaux.SECTION || '',
        champsFinaux.NOM_DU_PROJET || '',
        JSON.stringify({ champs: champsFinaux, fiches_ids }),
        docxBuffer.toString('base64'),
        sessionId,
      ]
    });

    const section = (champsFinaux.SECTION || 'T3E').replace(/\s/g, '-');
    const ts = Date.now();
    const fiches = Array.isArray(fiches_ids) ? fiches_ids.map(Number).filter(Boolean) : [];

    // Sans fiches → .docx direct
    if (fiches.length === 0) {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.docx"`);
      return res.send(docxBuffer);
    }

    // Avec fiches → ZIP
    const JSZip = require('jszip');
    const { PDFDocument } = require('pdf-lib');
    const ftRows = (await db.execute({
      sql: `SELECT id, chemin_fichier FROM documents WHERE id IN (${fiches.map(() => '?').join(',')})`,
      args: fiches
    })).rows;

    const zip = new JSZip();
    zip.file(`Bordereau_${section}.docx`, docxBuffer);
    const fichesDoc = await PDFDocument.create();
    for (const fiche of ftRows) {
      const ftPath = path.join(__dirname, '..', '..', fiche.chemin_fichier || '');
      if (!fiche.chemin_fichier || !fs.existsSync(ftPath)) continue;
      try {
        const ftDoc = await PDFDocument.load(fs.readFileSync(ftPath), { ignoreEncryption: true });
        const pages = await fichesDoc.copyPages(ftDoc, ftDoc.getPageIndices());
        pages.forEach(p => fichesDoc.addPage(p));
      } catch (_) {}
    }
    zip.file(`Fiches_Techniques_${section}.pdf`, await fichesDoc.save());
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.zip"`);
    return res.send(zipBuffer);
  }

  // Pas encore final → sauvegarder l'historique mis à jour et retourner la prochaine proposition
  await db.execute({
    sql: `UPDATE bordereaux SET contenu = ? WHERE id = ?`,
    args: [JSON.stringify({ messages, identification, fiches_ids, champs_confirmes }), sessionId]
  });

  return res.json({ sessionId, ...iaResult.parsed });
});

// Annuler une session en cours
router.post('/annuler/:id', async (req, res) => {
  const db = req.db;
  try { await db.execute({ sql: "DELETE FROM bordereaux WHERE id = ? AND session_actif = 1", args: [parseInt(req.params.id)] }); } catch (_) {}
  res.json({ ok: true });
});

// Re-télécharger un .docx généré
router.get('/telecharger/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0 || !r.rows[0].template_data) return res.status(404).send('Bordereau introuvable');
  const row = r.rows[0];
  const buf = Buffer.from(row.template_data, 'base64');
  const nom = `Bordereau_${(row.numero_projet || row.id).toString().replace(/\s/g, '-')}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
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
