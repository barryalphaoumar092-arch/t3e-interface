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
const SYSTEM_PROMPT = `Tu es un chargé de projet expert en couverture commerciale au Québec. Tu remplis un bordereau de transmission de fiches techniques étape par étape.

SOURCES D'INFORMATION — respecte strictement ces règles :
1. Du DEVIS uniquement → NOM_DU_PROJET, NUMERO_DU_PROJET, SECTION, ARTICLE
2. De la LISTE DES MATÉRIAUX fournie → TITRE, FOURNISSEUR, FABRICANT (cherche dans la liste le matériau mentionné dans le devis)
3. Valeurs fixes entrepreneur → déjà dans le bordereau, ne pas toucher
4. Toujours vide → NUMERO_DESSINS = "", DESCRIPTION = "", DELAI = ""
5. Généré par l'IA → REMARQUE (professionnelle, en lien avec le projet)

PROCESSUS EN 4 ÉTAPES :
Étape 1 — Identification : NOM_DU_PROJET, NUMERO_DU_PROJET (source: devis)
Étape 2 — Section et article : SECTION, ARTICLE (source: devis)
Étape 3 — Fiche technique : TITRE, FOURNISSEUR, FABRICANT (source: liste des matériaux — trouve le match avec ce qui est dans le devis)
Étape 4 — Remarque : REMARQUE générée par l'IA

RÈGLES :
- Extrais les valeurs exactement comme dans le devis/liste, sans inventer
- Pour le match matériaux : si plusieurs correspondances, choisis la plus précise; si aucune, laisse vide
- Message explicatif court : indique d'où vient l'info
- Si l'utilisateur dit "OUI" → passe à l'étape suivante
- Si l'utilisateur dit "AUTRE: [correction]" → applique la correction et re-propose
- Après confirmation de l'étape 4 → génère le JSON final qui DOIT contenir TOUS les champs confirmés aux étapes 1-4, relis la conversation pour les retrouver

FORMAT DE RÉPONSE OBLIGATOIRE — JSON valide uniquement, aucun texte à l'extérieur :

Proposition (étapes 1 à 4) :
{"type":"proposition","etape":N,"titre":"Étape N/4 — ...","message":"...","champs":{"CHAMP1":"valeur",...}}

Réponse finale (OBLIGATOIRE après confirmation étape 4 — inclure TOUTES les valeurs confirmées) :
{"type":"final","champs":{"NOM_DU_PROJET":"[valeur étape 1]","NUMERO_DU_PROJET":"[valeur étape 1]","TITRE":"[valeur étape 3]","NUMERO_DESSINS":"","DESCRIPTION":"","FOURNISSEUR":"[valeur étape 3]","FABRICANT":"[valeur étape 3]","SECTION":"[valeur étape 2]","ARTICLE":"[valeur étape 2]","DELAI":"","REMARQUE":"[valeur étape 4]"}}`;


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
      model: 'gpt-4o-mini',
      max_tokens: 1000,
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
    NOM:       nom_entrepreneur?.trim() || 'Toitures Trois Étoiles',
    SPECIALITE: specialite?.trim()      || 'COUVREUR',
    ADRESSE:   adresse?.trim()          || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
    EMIS_PAR:  emis_par?.trim()         || '',
  };

  // Charger et pré-filtrer les matériaux : on extrait les mots-clés du devis
  // puis on ne garde que les matériaux pertinents (max 40) pour limiter les tokens
  let listeMateriaux = '';
  try {
    const STOP_WORDS = new Set(['pour','dans','avec','sont','cette','leur','leurs','comme','mais','plus','tout','bien','aussi','sous','même','autre','entre','vers','être','fait','donc','très','peut','sans','part','dont','sera','avoir','nous','vous','ils','elles','une','des','les','par','sur','que','qui','est','pas','ces','aux','type','selon','voir','voir','afin']);
    const mots = texteDevis.toLowerCase().match(/[a-zàâäéèêëîïôùûü]{4,}/g) || [];
    const keywords = [...new Set(mots)].filter(m => !STOP_WORDS.has(m)).slice(0, 80);

    const matRows = (await db.execute(
      `SELECT nom, fabricant, fournisseur, type_produit FROM materiaux ORDER BY fabricant, nom`
    )).rows;

    const pertinents = matRows.filter(m => {
      const txt = `${m.nom} ${m.fabricant || ''} ${m.fournisseur || ''} ${m.type_produit || ''}`.toLowerCase();
      return keywords.some(k => txt.includes(k));
    }).slice(0, 40);

    const liste = pertinents.length > 0 ? pertinents : matRows.slice(0, 40);
    listeMateriaux = liste
      .map(m => [m.nom, m.fabricant && `Fabricant: ${m.fabricant}`, m.fournisseur && `Fournisseur: ${m.fournisseur}`].filter(Boolean).join(' | '))
      .join('\n');
  } catch (_) {}

  // Premier message vers l'IA : devis + liste matériaux
  const premierMessage = `DEVIS À ANALYSER :
${texteDevis.substring(0, 5000)}

${nom_projet ? `NOM DU PROJET indiqué par l'utilisateur : ${nom_projet}\n` : ''}
LISTE DES MATÉRIAUX T3E (source: Excel) :
${listeMateriaux || '(aucun matériau disponible)'}

Commence l'étape 1 : extrais du devis le NOM_DU_PROJET et le NUMERO_DU_PROJET. Indique exactement où tu les as trouvés dans le texte.`;

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
