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
Tu remplis un bordereau de transmission de fiches techniques. Lis CHAQUE LIGNE du devis attentivement.

=== OÙ CHERCHER CHAQUE INFO (SOURCES) ===

SOURCE 1 — DEVIS PDF (extraire du texte du devis) :
1. NOM_DU_PROJET — En-tête, page de garde, "Projet :", "Objet :", titre du document.
   Exemple : "Réfection des toitures – phase 6, Polytechnique Montréal"
2. NUMERO_DU_PROJET — En-tête, "N° projet", "Dossier", "N/Réf", "Projet no".
   Prends le numéro principal du propriétaire.
   Exemple : "53-0486"
3. SECTION — Numéro de section à 6 chiffres + titre complet.
   Cherche dans "Section", "Division", table des matières.
   Exemple : "07 52 21 — Couverture à membrane de bitume modifié"
4. ARTICLE — Sous-section qui décrit le PRODUIT PRINCIPAL, dans la Partie 2 — Produits.
   Exemple : "2.5 Membrane et solin de finition élastomère SBS"

SOURCE 2 — LISTE DES MATÉRIAUX T3E (la liste Excel fournie ci-dessous) :
5. TITRE — Cherche dans la LISTE DES MATÉRIAUX T3E le produit qui correspond à ce que le devis décrit.
   NE PAS inventer un nom — prends le nom EXACT de la colonne E (Nom du produit) de la liste.
   Exemple : "Soprastar Flam GR FR"
6. FABRICANT — Prends le fabricant de la LISTE DES MATÉRIAUX T3E (colonne C) pour le produit trouvé.
   Exemple : "Soprema"
7. FOURNISSEUR — Prends le fournisseur de la LISTE DES MATÉRIAUX T3E (colonne D).
   Exemple : "Soprema"

SOURCE 3 — IA (tu composes) :
8. REMARQUE — Compose une note professionnelle avec : contexte du projet, spécifications clés du produit, conditions de mise en œuvre, garantie.
   Exemple : "Membrane élastomère SBS, armature polyester/fibre de verre, granulée blanche. Réfection phase 6 — bâtiment institutionnel. Conforme CAN/CGSB 37.56-M."

SOURCE 4 — LAISSER VIDE (retourne "") :
9. DESCRIPTION — Retourne ""
10. NUMERO_DESSINS — Retourne ""

=== RÈGLES ===
- TITRE, FABRICANT, FOURNISSEUR viennent de la LISTE MATÉRIAUX, PAS du devis
- Si la liste matériaux est vide ou ne contient pas le produit, cherche le nom commercial dans le devis (Soprastar, Sopralene, etc.)
- NOM_DU_PROJET, NUMERO_DU_PROJET, SECTION, ARTICLE : extrais EXACTEMENT comme écrit dans le devis
- DESCRIPTION et NUMERO_DESSINS : toujours vides ("")
- Retourne UNIQUEMENT du JSON valide`;

async function appelIA(texteDevis, listeMateriaux) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const userContent = `TEXTE COMPLET DU DEVIS (lis CHAQUE ligne attentivement) :
───────────────────────────────────────
${texteDevis.substring(0, 40000)}
───────────────────────────────────────

LISTE DES MATÉRIAUX T3E (cherche ici le produit qui correspond au devis) :
${listeMateriaux || '(aucun matériau disponible)'}

IMPORTANT: Le devis contient PLUSIEURS produits de référence. Retourne un JSON avec TOUS les produits trouvés.
Cherche CHAQUE "Produit de référence :" ou matériau nommé dans PARTIE 2 — PRODUITS.

{
  "NOM_DU_PROJET": "nom du projet (DEVIS)",
  "NUMERO_DU_PROJET": "numéro référence (DEVIS)",
  "produits": [
    {
      "SECTION": "numéro section (DEVIS)",
      "ARTICLE": "article dans PARTIE 2 (DEVIS)",
      "TITRE": "nom produit (LISTE MATÉRIAUX T3E)",
      "FABRICANT": "fabricant (LISTE MATÉRIAUX T3E)",
      "FOURNISSEUR": "fournisseur (LISTE MATÉRIAUX T3E)",
      "REMARQUE": "résumé technique (IA)"
    }
  ]
}
Mets AUTANT de produits que tu trouves (pare-vapeur, isolant, membrane, drain, solin, etc.)`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4096,
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

  // 6. Extraire les produits — nouveau format (produits[]) ou ancien (champs unique)
  const champsCommuns = {
    NOM_DU_PROJET: champsIA.NOM_DU_PROJET || nom_projet || '',
    NUMERO_DU_PROJET: champsIA.NUMERO_DU_PROJET || '',
    NOM: identification.NOM,
    SPECIALITE: identification.SPECIALITE,
    ADRESSE: identification.ADRESSE,
  };

  let produits = [];
  if (Array.isArray(champsIA.produits) && champsIA.produits.length > 0) {
    produits = champsIA.produits;
  } else {
    produits = [{ SECTION: champsIA.SECTION || '', ARTICLE: champsIA.ARTICLE || '', TITRE: champsIA.TITRE || '', FABRICANT: champsIA.FABRICANT || '', FOURNISSEUR: champsIA.FOURNISSEUR || '', REMARQUE: champsIA.REMARQUE || '' }];
  }

  console.log('[analyser]', produits.length, 'produit(s) trouvés par IA');

  // 6b. Pour chaque produit sans Titre/Fabricant → matcher dans la DB
  try {
    const matRows = (await db.execute('SELECT nom, fabricant, fournisseur FROM materiaux')).rows;
    const devisLower = texteDevis.toLowerCase();
    for (const prod of produits) {
      if (!prod.TITRE || !prod.FABRICANT) {
        let best = null, bestScore = 0;
        for (const m of matRows) {
          const mots = (m.nom || '').toLowerCase().replace(/[^a-zàâäéèêëîïôùûü0-9]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
          const score = mots.filter(mot => devisLower.includes(mot)).length;
          if (score > bestScore) { bestScore = score; best = m; }
        }
        if (best && bestScore >= 2) {
          if (!prod.TITRE) prod.TITRE = best.nom;
          if (!prod.FABRICANT) prod.FABRICANT = best.fabricant || '';
          if (!prod.FOURNISSEUR) prod.FOURNISSEUR = best.fournisseur || '';
        }
      }
    }
  } catch (e) { console.log('[analyser] Erreur match matériaux:', e.message); }

  // 7. Auto-match FT pour chaque produit
  const ftParProduit = produits.map(p => trouverFichesTechniques(p.FABRICANT || '', p.TITRE || ''));

  console.log('[analyser] Produits:', produits.map(p => p.TITRE || '?').join(', '));

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

  // Compat ancien format (1 produit) et nouveau (N produits)
  let champsCommuns, produits, ftParProduit;
  if (data.produits) {
    champsCommuns = data.champsCommuns || {};
    produits = data.produits;
    ftParProduit = (data.ftParProduit || []).map(arr => (arr || []).map(p => path.basename(p)));
  } else {
    const c = data.champs || {};
    champsCommuns = { NOM_DU_PROJET: c.NOM_DU_PROJET, NUMERO_DU_PROJET: c.NUMERO_DU_PROJET, NOM: c.NOM, SPECIALITE: c.SPECIALITE, ADRESSE: c.ADRESSE };
    produits = [{ SECTION: c.SECTION, ARTICLE: c.ARTICLE, TITRE: c.TITRE, FABRICANT: c.FABRICANT, FOURNISSEUR: c.FOURNISSEUR, REMARQUE: c.REMARQUE }];
    ftParProduit = [(data.ft_chemins || []).map(p => path.basename(p))];
  }

  res.render('bordereau-reviser', {
    bordereau: row,
    champsCommuns,
    produits,
    ftParProduit,
    iaErreur: data.ia_erreur || '',
  });
});

// ── GÉNÉRER — remplir le .docx + fusionner FT → télécharger ──
router.post('/generer/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau introuvable');

  const row = r.rows[0];

  if (!row.template_data) {
    return res.status(400).send('Le template .docx est manquant pour ce bordereau. Veuillez recommencer depuis le début.');
  }

  // 1. Champs communs
  const champsCommuns = {
    NOM_DU_PROJET: req.body.NOM_DU_PROJET || '',
    NUMERO_DU_PROJET: req.body.NUMERO_DU_PROJET || '',
    NOM: req.body.NOM || 'Toitures Trois Étoiles',
    SPECIALITE: req.body.SPECIALITE || 'COUVREUR',
    ADRESSE: req.body.ADRESSE || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
  };

  // 2. Récupérer les produits (nouveau format tableau OU ancien format simple)
  let produits = [];
  if (req.body.produits && Array.isArray(req.body.produits)) {
    produits = req.body.produits;
  } else if (req.body.TITRE) {
    produits = [{ SECTION: req.body.SECTION, ARTICLE: req.body.ARTICLE, TITRE: req.body.TITRE, FABRICANT: req.body.FABRICANT, FOURNISSEUR: req.body.FOURNISSEUR, REMARQUE: req.body.REMARQUE }];
  }
  if (produits.length === 0) return res.status(400).send('Aucun produit.');

  let bordereauBuffer;
  try {
    bordereauBuffer = Buffer.from(row.template_data, 'base64');
  } catch (e) {
    return res.status(500).send('Erreur décodage template : ' + e.message);
  }

  console.log('[generer]', produits.length, 'produit(s) à générer');

  const { creerBordereauPdf } = require('../services/bordereau-pdf');

  // 3. Pour CHAQUE produit : créer bordereau PDF + FT PDF → fusionner en 1 seul PDF
  const allPdfBuffers = [];

  for (let i = 0; i < produits.length; i++) {
    const p = produits[i];
    const champs = { ...champsCommuns, TITRE: p.TITRE || '', FABRICANT: p.FABRICANT || '', FOURNISSEUR: p.FOURNISSEUR || '', SECTION: p.SECTION || '', ARTICLE: p.ARTICLE || '', REMARQUE: p.REMARQUE || '' };

    // 3a. Créer le bordereau en PDF
    try {
      const bordPdf = await creerBordereauPdf(champs);
      allPdfBuffers.push(bordPdf);
      console.log('[generer] Bordereau PDF', i + 1, ':', (p.TITRE || '?'));
    } catch (e) {
      console.error('[generer] Erreur bordereau PDF', i + 1, ':', e.message);
    }

    // 3b. Trouver et ajouter les FT de CE produit (à la suite du bordereau)
    try {
      console.log('[generer] Recherche FT: fabricant="' + (p.FABRICANT || '') + '", titre="' + (p.TITRE || '') + '"');
      let ft = trouverFichesTechniques(p.FABRICANT || '', p.TITRE || '');
      if (ft.length === 0 && p.TITRE) {
        const fabricantsConnus = ['Soprema', 'IKO', 'BP', 'Tremco', 'CGC', 'Murphco', 'Ventilation Maximum', 'Henry Bakor', 'Securpan', 'Sico'];
        for (const fab of fabricantsConnus) {
          if (p.TITRE.toLowerCase().includes(fab.toLowerCase().substring(0, 4)) || (p.REMARQUE || '').toLowerCase().includes(fab.toLowerCase().substring(0, 4))) {
            ft = trouverFichesTechniques(fab, p.TITRE);
            if (ft.length > 0) { console.log('[generer] FT fallback via', fab); break; }
          }
        }
      }
      if (ft.length > 0) {
        const ftPdf = await fusionnerPDF(ft);
        if (ftPdf) {
          allPdfBuffers.push(ftPdf);
          console.log('[generer] FT', i + 1, ':', ft.length, 'fichiers, à la suite');
        }
      }
    } catch (e) { console.error('[generer] Erreur FT', i + 1, ':', e.message); }
  }

  // 4. Fusionner TOUT en 1 seul PDF : Bord1 + FT1 + Bord2 + FT2 + ...
  const finalPdf = await PDFDocument.create();
  for (const buf of allPdfBuffers) {
    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = await finalPdf.copyPages(doc, doc.getPageIndices());
      pages.forEach(pg => finalPdf.addPage(pg));
    } catch (e) { console.error('[generer] Erreur fusion page:', e.message); }
  }
  const finalBuffer = Buffer.from(await finalPdf.save());

  // 5. DB update
  try {
    await db.execute({ sql: `UPDATE bordereaux SET statut = 'approuve', session_actif = 0, numero_projet = ?, titre = ? WHERE id = ?`, args: [champsCommuns.NUMERO_DU_PROJET || '', champsCommuns.NOM_DU_PROJET || '', id] });
  } catch (e) { console.error('[generer] Erreur DB:', e.message); }

  // 6. Retourner 1 SEUL PDF
  const nom = (champsCommuns.NUMERO_DU_PROJET || 'T3E').replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Bordereaux_FT_${nom}_${Date.now()}.pdf"`);
  res.send(finalBuffer);
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
