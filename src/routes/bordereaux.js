const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseDevis } = require('../services/document-parser');
const { remplirBordereau } = require('../services/bordereau-filler');
const { PDFDocument } = require('pdf-lib');
const JSZip = require('jszip');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const FT_DIR = path.join(__dirname, '..', '..', 'documents', 'FT');
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 20 * 1024 * 1024 } });
const uploadFields = upload.fields([
  { name: 'devis', maxCount: 1 },
  { name: 'bordereau', maxCount: 1 },
]);

// ══════════════════════════════════════════════════════════════
//  APPEL OPENAI — Extraction unique de TOUS les champs
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Tu es un chargé de projet expert en couverture commerciale au Québec chez Toitures Trois Étoiles Inc. (T3E).
Tu remplis un bordereau de transmission de fiches techniques. Tu extrais TOUTES les informations en UNE SEULE réponse.

SOURCES D'INFORMATION — respecte strictement :
1. Du DEVIS → NOM_DU_PROJET, NUMERO_DU_PROJET, SECTION, ARTICLE
2. De la LISTE DES MATÉRIAUX → TITRE (nom du produit), FOURNISSEUR, FABRICANT
   Cherche dans la liste le matériau qui correspond le mieux à ce qui est décrit dans le devis.
   Si le devis mentionne "membrane de bitume modifié SBS" et que la liste contient "Soprastar Flam GR", c'est un match.
3. Généré par toi → REMARQUE (note professionnelle courte sur le produit et son usage)

TOUJOURS VIDE : NUMERO_DESSINS, DESCRIPTION, DELAI

RÈGLES :
- Extrais les valeurs EXACTEMENT comme dans le texte du devis (pas de reformulation)
- Pour SECTION : inclure le numéro ET le titre (ex: "07 52 21 — Couverture à membrane de bitume modifié")
- Pour ARTICLE : inclure le numéro ET la description (ex: "2.5 Membrane et solin de finition élastomère")
- Pour le match matériaux : choisis le produit LE PLUS SPÉCIFIQUE qui correspond au devis
- Si tu ne trouves pas une info → chaîne vide ""
- Retourne UNIQUEMENT du JSON valide, AUCUN texte autour`;

async function appelIA(texteDevis, listeMateriaux) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const userContent = `TEXTE DU DEVIS :
${texteDevis.substring(0, 6000)}

LISTE DES MATÉRIAUX T3E (Produit | Fabricant | Fournisseur) :
${listeMateriaux || '(aucun matériau disponible)'}

Retourne un JSON avec ces clés exactes :
{
  "NOM_DU_PROJET": "...",
  "NUMERO_DU_PROJET": "...",
  "SECTION": "...",
  "ARTICLE": "...",
  "TITRE": "...",
  "FABRICANT": "...",
  "FOURNISSEUR": "...",
  "REMARQUE": "..."
}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('OpenAI ' + resp.status + ': ' + txt.substring(0, 200));
  }

  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

// ══════════════════════════════════════════════════════════════
//  AUTO-MATCH FICHES TECHNIQUES — scan documents/FT/{Fabricant}/
// ══════════════════════════════════════════════════════════════
function trouverFichesTechniques(fabricant, titre) {
  if (!fabricant || !fs.existsSync(FT_DIR)) return [];

  let fabDir = path.join(FT_DIR, fabricant);

  if (!fs.existsSync(fabDir)) {
    const dirs = [];
    try {
      for (const d of fs.readdirSync(FT_DIR)) {
        const full = path.join(FT_DIR, d);
        if (fs.statSync(full).isDirectory() && d.toLowerCase().includes(fabricant.toLowerCase().substring(0, 4))) {
          dirs.push(d);
        }
      }
    } catch (_) {}
    if (dirs.length === 0) return [];
    fabDir = path.join(FT_DIR, dirs[0]);
  }

  let pdfs;
  try { pdfs = fs.readdirSync(fabDir).filter(f => f.endsWith('.pdf')); } catch (_) { return []; }

  if (!titre || pdfs.length === 0) return pdfs.slice(0, 3).map(f => path.join(fabDir, f));

  const keywords = titre.toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûü0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  const scored = pdfs.map(f => {
    const fname = f.toLowerCase();
    const score = keywords.filter(k => fname.includes(k)).length;
    return { file: f, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length > 0) return [path.join(fabDir, scored[0].file)];
  return [];
}

// ══════════════════════════════════════════════════════════════
//  FUSIONNER PLUSIEURS PDF EN UN SEUL (pdf-lib)
// ══════════════════════════════════════════════════════════════
async function fusionnerPDF(chemins) {
  const merged = await PDFDocument.create();
  for (const p of chemins) {
    if (!fs.existsSync(p)) continue;
    try {
      const buf = fs.readFileSync(p);
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(pg => merged.addPage(pg));
    } catch (_) {}
  }
  return merged.getPageCount() > 0 ? Buffer.from(await merged.save()) : null;
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// Liste des bordereaux
router.get('/', async (req, res) => {
  const r = await req.db.execute(
    "SELECT id, titre, numero_projet, cree_par, created_at FROM bordereaux WHERE (session_actif = 0 OR session_actif IS NULL) ORDER BY created_at DESC"
  );
  res.render('bordereaux', { bordereaux: r.rows });
});

// Page d'upload
router.get('/nouveau', (req, res) => {
  res.render('bordereau-nouveau');
});

// ── ANALYSER : upload devis + bordereau → IA extrait → redirige vers révision ──
router.post('/analyser', uploadFields, async (req, res) => {
  const db = req.db;
  const { nom_entrepreneur, specialite, adresse, emis_par, nom_projet } = req.body;

  const devisFile = req.files?.devis?.[0];
  const bordereauFile = req.files?.bordereau?.[0];
  if (!devisFile) return res.status(400).send('Veuillez importer le devis PDF.');
  if (!bordereauFile) return res.status(400).send('Veuillez importer le bordereau .docx.');

  // 1. Lire le devis
  let texteDevis = '';
  try {
    const parsed = await parseDevis(devisFile.path, devisFile.originalname);
    texteDevis = parsed.text || '';
  } catch (e) {
    return res.status(400).send('Impossible de lire le devis : ' + e.message);
  } finally {
    try { fs.unlinkSync(devisFile.path); } catch (_) {}
  }

  if (!texteDevis.trim()) {
    try { fs.unlinkSync(bordereauFile.path); } catch (_) {}
    return res.status(400).send('Le devis semble vide ou illisible.');
  }

  // 2. Lire le template bordereau .docx
  const bordereauBuffer = fs.readFileSync(bordereauFile.path);
  try { fs.unlinkSync(bordereauFile.path); } catch (_) {}

  // 3. Charger les matériaux pour l'IA (pré-filtré par mots-clés du devis)
  let listeMateriaux = '';
  try {
    const STOP = new Set(['pour','dans','avec','sont','cette','leur','plus','tout','bien','sous','même','autre','être','fait','donc','très','peut','sans','dont','sera','avoir','nous','vous','type','selon','voir','afin']);
    const mots = texteDevis.toLowerCase().match(/[a-zàâäéèêëîïôùûü]{4,}/g) || [];
    const keywords = [...new Set(mots)].filter(m => !STOP.has(m)).slice(0, 80);

    const matRows = (await db.execute('SELECT nom, fabricant, fournisseur, type_produit FROM materiaux ORDER BY fabricant, nom')).rows;
    const pertinents = matRows.filter(m => {
      const txt = `${m.nom} ${m.fabricant || ''} ${m.fournisseur || ''} ${m.type_produit || ''}`.toLowerCase();
      return keywords.some(k => txt.includes(k));
    }).slice(0, 50);

    const liste = pertinents.length > 0 ? pertinents : matRows.slice(0, 50);
    listeMateriaux = liste.map(m =>
      [m.nom, m.fabricant && `Fabricant: ${m.fabricant}`, m.fournisseur && `Fournisseur: ${m.fournisseur}`].filter(Boolean).join(' | ')
    ).join('\n');
  } catch (_) {}

  // 4. Appel IA — extraction unique de TOUS les champs
  let champsIA = {};
  let iaErreur = '';
  try {
    champsIA = await appelIA(texteDevis, listeMateriaux);
  } catch (e) {
    iaErreur = e.message;
  }

  // 5. Valeurs d'identification (fixes T3E)
  const identification = {
    NOM: nom_entrepreneur?.trim() || 'Toitures Trois Étoiles',
    SPECIALITE: specialite?.trim() || 'COUVREUR',
    ADRESSE: adresse?.trim() || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
  };

  // 6. Fusionner IA + identification + nom_projet utilisateur
  const champs = {
    NOM_DU_PROJET: champsIA.NOM_DU_PROJET || nom_projet || '',
    NUMERO_DU_PROJET: champsIA.NUMERO_DU_PROJET || '',
    NOM: identification.NOM,
    SPECIALITE: identification.SPECIALITE,
    ADRESSE: identification.ADRESSE,
    TITRE: champsIA.TITRE || '',
    NUMERO_DESSINS: '',
    NOMBRE_FEUILLES: '',
    REVISION: '',
    DESCRIPTION: '',
    FOURNISSEUR: champsIA.FOURNISSEUR || '',
    FABRICANT: champsIA.FABRICANT || '',
    SECTION: champsIA.SECTION || '',
    ARTICLE: champsIA.ARTICLE || '',
    DELAI: '',
    REMARQUE: champsIA.REMARQUE || '',
  };

  // 7. Auto-match des fiches techniques
  const ftTrouvees = trouverFichesTechniques(champs.FABRICANT, champs.TITRE);

  // 8. Sauvegarder en DB
  const r = await db.execute({
    sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, session_actif, cree_par, devis_texte, template_data)
          VALUES (?, ?, ?, 'brouillon', 1, ?, ?, ?)`,
    args: [
      champs.NUMERO_DU_PROJET || '',
      champs.NOM_DU_PROJET || 'Bordereau en cours',
      JSON.stringify({ champs, ft_chemins: ftTrouvees, ia_erreur: iaErreur }),
      identification.NOM,
      texteDevis.substring(0, 10000),
      bordereauBuffer.toString('base64'),
    ],
  });

  const sessionId = r.lastInsertRowid || 0;
  res.redirect('/bordereaux/reviser/' + sessionId);
});

// ── PAGE DE RÉVISION — affiche les champs extraits par l'IA ──
router.get('/reviser/:id', async (req, res) => {
  const db = req.db;
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.redirect('/bordereaux');

  const row = r.rows[0];
  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = { champs: {}, ft_chemins: [] }; }

  const champs = data.champs || {};
  const ftChemins = data.ft_chemins || [];
  const iaErreur = data.ia_erreur || '';

  const ftNoms = ftChemins.map(p => path.basename(p));

  res.render('bordereau-reviser', {
    bordereau: row,
    champs,
    ftNoms,
    iaErreur,
  });
});

// ── GÉNÉRER — remplir le .docx + fusionner FT → télécharger ──
router.post('/generer/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau introuvable');

  const row = r.rows[0];
  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = { champs: {}, ft_chemins: [] }; }

  // 1. Récupérer les champs du formulaire (l'utilisateur peut avoir modifié)
  const champs = {
    NOM_DU_PROJET: req.body.NOM_DU_PROJET || '',
    NUMERO_DU_PROJET: req.body.NUMERO_DU_PROJET || '',
    NOM: req.body.NOM || 'Toitures Trois Étoiles',
    SPECIALITE: req.body.SPECIALITE || 'COUVREUR',
    ADRESSE: req.body.ADRESSE || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
    TITRE: req.body.TITRE || '',
    NUMERO_DESSINS: req.body.NUMERO_DESSINS || '',
    NOMBRE_FEUILLES: req.body.NOMBRE_FEUILLES || '',
    REVISION: req.body.REVISION || '',
    DESCRIPTION: req.body.DESCRIPTION || '',
    FOURNISSEUR: req.body.FOURNISSEUR || '',
    FABRICANT: req.body.FABRICANT || '',
    SECTION: req.body.SECTION || '',
    ARTICLE: req.body.ARTICLE || '',
    DELAI: req.body.DELAI || '',
    REMARQUE: req.body.REMARQUE || '',
  };

  // 2. Remplir le .docx — suit les étapes exactes :
  //    normalizeXmlText → remplirChampDansXml (NBSP + indexOf + labels longs d'abord)
  const bordereauBuffer = Buffer.from(row.template_data, 'base64');
  let docxBuffer;
  try {
    docxBuffer = await remplirBordereau(champs, bordereauBuffer);
  } catch (e) {
    return res.status(500).send('Erreur remplissage .docx : ' + e.message);
  }

  // 3. Auto-match FT (recalculer au cas où l'utilisateur a changé FABRICANT/TITRE)
  const ftChemins = trouverFichesTechniques(champs.FABRICANT, champs.TITRE);

  // 4. Fusionner les FT en un seul PDF
  const ftPdfBuffer = await fusionnerPDF(ftChemins);

  // 5. Mettre à jour la DB
  const section = (champs.SECTION || champs.NUMERO_DU_PROJET || 'T3E').replace(/\s/g, '-').substring(0, 30);
  await db.execute({
    sql: `UPDATE bordereaux SET statut = 'genere', session_actif = 0, numero_projet = ?, titre = ?, contenu = ?, template_data = ? WHERE id = ?`,
    args: [
      champs.NUMERO_DU_PROJET || '',
      champs.NOM_DU_PROJET || '',
      JSON.stringify({ champs, ft_chemins: ftChemins }),
      docxBuffer.toString('base64'),
      id,
    ],
  });

  // 6. Retourner le résultat
  const ts = Date.now();

  if (!ftPdfBuffer) {
    // Pas de FT → .docx seul
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.docx"`);
    return res.send(docxBuffer);
  }

  // Avec FT → ZIP contenant le .docx rempli + le PDF des fiches techniques combinées
  const zip = new JSZip();
  zip.file(`Bordereau_${section}.docx`, docxBuffer);
  zip.file(`Fiches_Techniques_${section}.pdf`, ftPdfBuffer);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.zip"`);
  res.send(zipBuffer);
});

// Re-télécharger un .docx déjà généré
router.get('/telecharger/:id', async (req, res) => {
  const r = await req.db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0 || !r.rows[0].template_data) return res.status(404).send('Bordereau introuvable');
  const row = r.rows[0];
  const buf = Buffer.from(row.template_data, 'base64');
  const nom = `Bordereau_${(row.numero_projet || row.id).toString().replace(/\s/g, '-')}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
  res.send(buf);
});

// Supprimer
router.post('/supprimer/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try { await req.db.execute({ sql: 'DELETE FROM historique_bordereaux WHERE bordereau_id = ?', args: [id] }); } catch (_) {}
  await req.db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [id] });
  res.redirect('/bordereaux');
});

module.exports = router;
