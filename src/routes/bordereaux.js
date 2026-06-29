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
//  APPEL OPENAI — Extraction exhaustive de TOUS les champs
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Tu es un chargé de projet SENIOR expert en couverture commerciale au Québec chez Toitures Trois Étoiles Inc. (T3E).
Tu remplis DES BORDEREAUX de transmission de fiches techniques — UN PAR PRODUIT DE RÉFÉRENCE trouvé dans le devis.

=== MISSION ===
Lis le devis EN ENTIER et identifie CHAQUE "Produit de référence" mentionné.
Pour CHACUN, crée une entrée dans le tableau "produits".

=== SOURCES ===

DEVIS PDF → NOM_DU_PROJET, NUMERO_DU_PROJET (communs à tous les bordereaux)
DEVIS PDF → SECTION, ARTICLE (spécifiques à chaque produit)
LISTE MATÉRIAUX T3E → TITRE (nom exact colonne E), FABRICANT (colonne C), FOURNISSEUR (colonne D)
IA → REMARQUE (résumé technique)
VIDE → DESCRIPTION, NUMERO_DESSINS (toujours "")

=== COMMENT TROUVER LES PRODUITS ===
Dans le devis, cherche :
- "Produit de référence :" suivi d'un nom de produit
- Les sous-sections numérotées dans "PARTIE 2 — PRODUITS" (2.1, 2.2, 2.3, etc.)
- Chaque matériau nommé avec un fabricant (Soprema, IKO, BP, Tremco, CGC, Murphco, etc.)

Exemples de produits à trouver :
- Pare-vapeur (ex: Sopralene 180 SP 3,5)
- Isolant (ex: Sopra-ISO, Sopra-ISO HD)
- Membrane de sous-couche (ex: Elastocol 500S)
- Membrane de finition (ex: Soprastar Flam GR FR)
- Panneau de support (ex: Securock, Densdeck Prime)
- Drain (ex: Ultra MEK cuivre 32 oz)
- Manchon d'évent (ex: manchon aluminium prémoulé)
- Solin (ex: Weather XL Vicwest)

=== RÈGLES ===
- Retourne TOUS les produits, pas juste le principal
- TITRE, FABRICANT, FOURNISSEUR : cherche dans la LISTE MATÉRIAUX T3E d'abord
- Si pas dans la liste, utilise le nom commercial du devis
- NOM_DU_PROJET et NUMERO_DU_PROJET sont les mêmes pour tous les produits
- Retourne UNIQUEMENT du JSON valide`;

async function appelIA(texteDevis, listeMateriaux) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const userContent = `TEXTE COMPLET DU DEVIS (lis CHAQUE ligne attentivement) :
───────────────────────────────────────
${texteDevis.substring(0, 30000)}
───────────────────────────────────────

LISTE DES MATÉRIAUX T3E (cherche ici le produit qui correspond au devis) :
${listeMateriaux || '(aucun matériau disponible)'}

Retourne ce JSON avec UN PRODUIT PAR ENTRÉE dans le tableau "produits" :
{
  "NOM_DU_PROJET": "nom complet du projet (DEVIS)",
  "NUMERO_DU_PROJET": "numéro de référence (DEVIS)",
  "produits": [
    {
      "SECTION": "numéro de section (DEVIS)",
      "ARTICLE": "numéro article dans PARTIE 2 (DEVIS)",
      "TITRE": "nom exact produit (LISTE MATÉRIAUX T3E)",
      "FABRICANT": "fabricant (LISTE MATÉRIAUX T3E)",
      "FOURNISSEUR": "fournisseur (LISTE MATÉRIAUX T3E)",
      "REMARQUE": "résumé technique (IA)"
    }
  ]
}
IMPORTANT : Mets AUTANT de produits que tu trouves dans le devis. Cherche CHAQUE "Produit de référence :" ou matériau nommé.`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 2000,
      temperature: 0.1,
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
  if (!fabricant || !fs.existsSync(FT_DIR)) {
    console.log('[FT] Pas de fabricant ou dossier FT absent');
    return [];
  }

  let fabDir = path.join(FT_DIR, fabricant);

  if (!fs.existsSync(fabDir)) {
    const allDirs = [];
    try {
      for (const d of fs.readdirSync(FT_DIR)) {
        const full = path.join(FT_DIR, d);
        if (fs.statSync(full).isDirectory()) allDirs.push(d);
      }
    } catch (_) {}

    const fabLower = fabricant.toLowerCase();
    const match = allDirs.find(d => d.toLowerCase() === fabLower)
      || allDirs.find(d => d.toLowerCase().includes(fabLower.substring(0, 4)))
      || allDirs.find(d => fabLower.includes(d.toLowerCase().substring(0, 4)));

    if (!match) {
      console.log('[FT] Fabricant "' + fabricant + '" non trouvé parmi:', allDirs.join(', '));
      return [];
    }
    fabDir = path.join(FT_DIR, match);
    console.log('[FT] Fabricant matché: "' + fabricant + '" → "' + match + '"');
  }

  let pdfs;
  try { pdfs = fs.readdirSync(fabDir).filter(f => f.endsWith('.pdf')); } catch (_) { return []; }
  console.log('[FT] PDFs disponibles dans ' + path.basename(fabDir) + ':', pdfs.length);

  if (!titre || pdfs.length === 0) return pdfs.slice(0, 3).map(f => path.join(fabDir, f));

  const keywords = titre.toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûü0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the','des','les','pour','avec','type'].includes(w));

  console.log('[FT] Mots-clés de recherche:', keywords.join(', '));

  const scored = pdfs.map(f => {
    const fname = f.toLowerCase();
    const score = keywords.filter(k => fname.includes(k)).length;
    return { file: f, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    console.log('[FT] Meilleur match:', scored[0].file, '(score:', scored[0].score + ')');
    return [path.join(fabDir, scored[0].file)];
  }

  console.log('[FT] Aucun match par titre, retourne les 2 premiers PDFs');
  return pdfs.slice(0, 2).map(f => path.join(fabDir, f));
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
    }).slice(0, 80);

    const liste = pertinents.length > 0 ? pertinents : matRows.slice(0, 80);
    listeMateriaux = 'FORMAT: Produit (colonne E) | Fabricant (colonne C) | Fournisseur (colonne D)\n' +
      liste.map(m =>
        [m.nom, m.fabricant || '', m.fournisseur || ''].join(' | ')
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

  // 6. Extraire les produits (nouveau format multi-produits OU ancien format simple)
  let produits = [];
  const champsCommuns = {
    NOM_DU_PROJET: champsIA.NOM_DU_PROJET || nom_projet || '',
    NUMERO_DU_PROJET: champsIA.NUMERO_DU_PROJET || '',
    NOM: identification.NOM,
    SPECIALITE: identification.SPECIALITE,
    ADRESSE: identification.ADRESSE,
  };

  if (Array.isArray(champsIA.produits) && champsIA.produits.length > 0) {
    produits = champsIA.produits.map(p => ({
      SECTION: p.SECTION || '',
      ARTICLE: p.ARTICLE || '',
      TITRE: p.TITRE || '',
      FABRICANT: p.FABRICANT || '',
      FOURNISSEUR: p.FOURNISSEUR || '',
      REMARQUE: p.REMARQUE || '',
    }));
  } else {
    produits = [{
      SECTION: champsIA.SECTION || '',
      ARTICLE: champsIA.ARTICLE || '',
      TITRE: champsIA.TITRE || '',
      FABRICANT: champsIA.FABRICANT || '',
      FOURNISSEUR: champsIA.FOURNISSEUR || '',
      REMARQUE: champsIA.REMARQUE || '',
    }];
  }

  console.log('[analyser] IA:', produits.length, 'produits extraits');
  console.log('[analyser] Produits:', JSON.stringify(produits).substring(0, 500));

  // 6b. Pour chaque produit sans Titre/Fabricant, matcher dans la DB matériaux
  try {
    const matRows = (await db.execute('SELECT nom, fabricant, fournisseur FROM materiaux')).rows;
    const devisLower = texteDevis.toLowerCase();

    for (const prod of produits) {
      if (!prod.TITRE || !prod.FABRICANT) {
        let bestMatch = null;
        let bestScore = 0;
        const prodKeywords = (prod.REMARQUE || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);

        for (const m of matRows) {
          const mots = (m.nom || '').toLowerCase().replace(/[^a-zàâäéèêëîïôùûü0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
          let score = mots.filter(mot => devisLower.includes(mot)).length;
          score += mots.filter(mot => prodKeywords.some(k => k.includes(mot))).length;
          if (score > bestScore) { bestScore = score; bestMatch = m; }
        }

        if (bestMatch && bestScore >= 2) {
          if (!prod.TITRE) prod.TITRE = bestMatch.nom;
          if (!prod.FABRICANT) prod.FABRICANT = bestMatch.fabricant || '';
          if (!prod.FOURNISSEUR) prod.FOURNISSEUR = bestMatch.fournisseur || '';
          console.log('[analyser] Match DB:', prod.TITRE, '(score:', bestScore, ')');
        }
      }
    }
  } catch (e) {
    console.log('[analyser] Erreur match matériaux:', e.message);
  }

  // 7. Auto-match des fiches techniques pour chaque produit
  const ftParProduit = produits.map(p => trouverFichesTechniques(p.FABRICANT, p.TITRE));

  // 8. Sauvegarder en DB
  const r = await db.execute({
    sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, session_actif, cree_par, devis_texte, template_data)
          VALUES (?, ?, ?, 'brouillon', 1, ?, ?, ?)`,
    args: [
      champsCommuns.NUMERO_DU_PROJET || '',
      champsCommuns.NOM_DU_PROJET || 'Bordereau en cours',
      JSON.stringify({ champsCommuns, produits, ftParProduit, ia_erreur: iaErreur }),
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
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }

  // Support ancien format (champs unique) et nouveau (produits[])
  let champsCommuns, produits, ftParProduit;
  if (data.produits) {
    champsCommuns = data.champsCommuns || {};
    produits = data.produits || [];
    ftParProduit = data.ftParProduit || [];
  } else {
    const champs = data.champs || {};
    champsCommuns = { NOM_DU_PROJET: champs.NOM_DU_PROJET, NUMERO_DU_PROJET: champs.NUMERO_DU_PROJET, NOM: champs.NOM, SPECIALITE: champs.SPECIALITE, ADRESSE: champs.ADRESSE };
    produits = [{ SECTION: champs.SECTION, ARTICLE: champs.ARTICLE, TITRE: champs.TITRE, FABRICANT: champs.FABRICANT, FOURNISSEUR: champs.FOURNISSEUR, REMARQUE: champs.REMARQUE }];
    ftParProduit = [data.ft_chemins || []];
  }
  const iaErreur = data.ia_erreur || '';

  res.render('bordereau-reviser', {
    bordereau: row,
    champsCommuns,
    produits,
    ftParProduit: ftParProduit.map(chemins => (chemins || []).map(p => path.basename(p))),
    iaErreur,
  });
});

// ── GÉNÉRER — N bordereaux (1 par produit) + FT → 1 PDF final ──
router.post('/generer/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r2 = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r2.rows.length === 0) return res.status(404).send('Bordereau introuvable');

  const row = r2.rows[0];
  if (!row.template_data) {
    return res.status(400).send('Le template .docx est manquant. Veuillez recommencer.');
  }

  let bordereauBuffer;
  try {
    bordereauBuffer = Buffer.from(row.template_data, 'base64');
  } catch (e) {
    return res.status(500).send('Erreur décodage template : ' + e.message);
  }

  // 1. Récupérer les champs communs + produits du formulaire
  const champsCommuns = {
    NOM_DU_PROJET: req.body.NOM_DU_PROJET || '',
    NUMERO_DU_PROJET: req.body.NUMERO_DU_PROJET || '',
    NOM: req.body.NOM || 'Toitures Trois Étoiles',
    SPECIALITE: req.body.SPECIALITE || 'COUVREUR',
    ADRESSE: req.body.ADRESSE || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
  };

  // Récupérer les produits depuis le formulaire (produits[0][TITRE], produits[1][TITRE], etc.)
  let produits = [];
  if (req.body.produits && Array.isArray(req.body.produits)) {
    produits = req.body.produits.map(p => ({
      SECTION: p.SECTION || '', ARTICLE: p.ARTICLE || '',
      TITRE: p.TITRE || '', FABRICANT: p.FABRICANT || '',
      FOURNISSEUR: p.FOURNISSEUR || '', REMARQUE: p.REMARQUE || '',
    }));
  } else if (req.body.TITRE) {
    produits = [{
      SECTION: req.body.SECTION || '', ARTICLE: req.body.ARTICLE || '',
      TITRE: req.body.TITRE || '', FABRICANT: req.body.FABRICANT || '',
      FOURNISSEUR: req.body.FOURNISSEUR || '', REMARQUE: req.body.REMARQUE || '',
    }];
  }

  if (produits.length === 0) {
    return res.status(400).send('Aucun produit à générer.');
  }

  console.log('[generer]', produits.length, 'produits à générer');

  // 2. Pour chaque produit : remplir .docx + trouver FT
  const zip = new JSZip();
  const allFtChemins = [];

  for (let i = 0; i < produits.length; i++) {
    const prod = produits[i];
    const champs = {
      ...champsCommuns,
      TITRE: prod.TITRE,
      FABRICANT: prod.FABRICANT,
      FOURNISSEUR: prod.FOURNISSEUR,
      SECTION: prod.SECTION,
      ARTICLE: prod.ARTICLE,
      REMARQUE: prod.REMARQUE,
      NUMERO_DESSINS: '',
      NOMBRE_FEUILLES: '',
      REVISION: '',
      DESCRIPTION: '',
      DELAI: '',
    };

    console.log('[generer] Produit', i + 1, ':', prod.TITRE, '/', prod.FABRICANT);

    // 2a. Remplir le bordereau .docx
    try {
      const docxRempli = await remplirBordereau(champs, bordereauBuffer);
      const sectionClean = (prod.SECTION || 'produit-' + (i + 1)).replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30);
      zip.file(`Bordereau_${i + 1}_${sectionClean}.docx`, docxRempli);
      console.log('[generer] Bordereau', i + 1, 'OK:', docxRempli.length, 'octets');
    } catch (e) {
      console.error('[generer] Erreur produit', i + 1, ':', e.message);
    }

    // 2b. Trouver les FT pour ce produit
    try {
      const ftChemins = trouverFichesTechniques(prod.FABRICANT, prod.TITRE);
      ftChemins.forEach(c => { if (!allFtChemins.includes(c)) allFtChemins.push(c); });
      console.log('[generer] FT', i + 1, ':', ftChemins.length, 'fichiers');
    } catch (e) {
      console.error('[generer] Erreur FT', i + 1, ':', e.message);
    }
  }

  // 3. Fusionner TOUTES les FT en 1 seul PDF
  if (allFtChemins.length > 0) {
    try {
      const ftPdf = await fusionnerPDF(allFtChemins);
      if (ftPdf) zip.file('Fiches_Techniques.pdf', ftPdf);
    } catch (e) {
      console.error('[generer] Erreur fusion FT:', e.message);
    }
  }

  // 4. Mettre à jour la DB
  try {
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'approuve', session_actif = 0, numero_projet = ?, titre = ? WHERE id = ?`,
      args: [champsCommuns.NUMERO_DU_PROJET || '', champsCommuns.NOM_DU_PROJET || '', id],
    });
  } catch (e) {
    console.error('[generer] Erreur DB:', e.message);
  }

  // 5. Retourner le ZIP
  const section = (champsCommuns.NUMERO_DU_PROJET || 'T3E').replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Bordereaux_${section}_${Date.now()}.zip"`);
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
