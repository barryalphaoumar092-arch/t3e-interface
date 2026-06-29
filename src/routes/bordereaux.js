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
Tu remplis un bordereau de transmission de fiches techniques avec une PRÉCISION MAXIMALE.

Tu dois FOUILLER EN PROFONDEUR le devis pour extraire un maximum d'informations. Lis chaque ligne du devis attentivement.
Prends ton temps, la qualité est plus importante que la vitesse.

CHAMPS À REMPLIR — cherche dans TOUT le texte du devis :

1. NOM_DU_PROJET — Le nom complet du projet tel qu'écrit dans le devis.
   Cherche dans : en-tête, page de garde, premières lignes, mentions "Projet :", "Objet :", titre du document.
   Exemple : "Réfection des toitures – phase 6, Polytechnique Montréal"

2. NUMERO_DU_PROJET — Le numéro de référence / dossier du projet.
   Cherche dans : en-tête, "N° projet", "Dossier", "Référence", "N/Réf", "Projet no", "No contrat".
   Il peut y avoir PLUSIEURS numéros (propriétaire, architecte, entrepreneur). Prends le numéro principal.
   Exemple : "53-0486"

3. SECTION — La section du devis avec numéro ET titre complet.
   Cherche dans : "Section", "Division", le numéro de section à 6 chiffres (ex: 07 52 21).
   INCLURE le titre descriptif complet après le numéro.
   Exemple : "07 52 21 — Couverture à membrane de bitume modifié"

4. ARTICLE — L'article spécifique avec numéro ET description complète.
   Cherche dans : "Article", "Partie", sous-sections numérotées (2.1, 2.5, 3.2, etc.).
   Identifie l'article qui décrit le PRODUIT PRINCIPAL mentionné dans le devis.
   Exemple : "2.5 Membrane et solin de finition élastomère SBS, armature polyester/fibre de verre"

5. TITRE — Le nom EXACT du produit/matériau principal.
   PRIORITÉ : cherche d'abord dans la LISTE DES MATÉRIAUX T3E un produit qui correspond à ce que le devis décrit.
   Cherche les noms de produits commerciaux dans le devis : Soprastar, Sopralene, Colply, Elastocol, Stormtite, etc.
   Si le devis dit "membrane SBS armature polyester granulée" → cherche dans la liste un produit qui match.
   Exemple : "Soprastar Flam GR FR"

6. FABRICANT — Le fabricant du produit.
   PRIORITÉ : utilise le fabricant de la LISTE DES MATÉRIAUX T3E pour le produit trouvé au point 5.
   Sinon cherche dans le devis : "Fabricant", "Manufacturier", ou le nom de la compagnie (Soprema, IKO, BP, Tremco...).
   Exemple : "Soprema"

7. FOURNISSEUR — Le fournisseur du produit.
   PRIORITÉ : utilise le fournisseur de la LISTE DES MATÉRIAUX T3E.
   Souvent le même que le fabricant au Québec.
   Exemple : "Soprema"

8. DESCRIPTION — Description technique du produit/travail.
   COMPOSE une description détaillée à partir du devis : type de membrane, armature, épaisseur, finition, norme applicable, méthode de pose.
   Ne laisse JAMAIS vide si le devis contient des spécifications techniques.
   Exemple : "Membrane élastomère SBS de finition, armature polyester/fibre de verre, surface granulée, posée au chalumeau, conforme à CAN/CGSB 37.56-M"

9. NUMERO_DESSINS — Numéro des dessins/plans référencés.
   Cherche dans : "Dessin", "Plan", "Détail", "Annexe", "Figure", références croisées.
   Si non trouvé, laisse vide.

10. REMARQUE — Note DÉTAILLÉE et professionnelle.
    COMPOSE une remarque complète incluant :
    - Le contexte du projet (type de bâtiment, phase des travaux)
    - Les spécifications clés du produit (norme, épaisseur, armature, finition)
    - Les conditions de mise en œuvre mentionnées dans le devis
    - Toute information pertinente pour le chantier (garantie, restrictions, conditions)
    Exemple : "Membrane de finition élastomère SBS, armature polyester/fibre de verre composite, surface granulée. Posée au chalumeau sur membrane de base. Projet de réfection phase 6 — bâtiment institutionnel. Conforme aux exigences CAN/CGSB 37.56-M. Garantie Soprema applicable."

RÈGLES STRICTES :
- Lis le TEXTE COMPLET du devis, pas seulement le début
- Extrais les valeurs textuelles EXACTEMENT comme dans le devis (pas de reformulation pour NOM_DU_PROJET, NUMERO_DU_PROJET, SECTION, ARTICLE)
- DESCRIPTION et REMARQUE : compose-les à partir des infos du devis, sois DÉTAILLÉ et PROFESSIONNEL
- Pour le match matériaux avec la liste : choisis le produit LE PLUS SPÉCIFIQUE. Si le devis dit "membrane élastomère SBS granulée" et que la liste a "Soprastar Flam GR" et "Soprastar GR", choisis "Soprastar Flam GR" (flam = posée au chalumeau)
- NE LAISSE JAMAIS un champ vide si l'information existe quelque part dans le devis
- Retourne UNIQUEMENT du JSON valide`;

async function appelIA(texteDevis, listeMateriaux) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const userContent = `TEXTE COMPLET DU DEVIS (lis CHAQUE ligne attentivement) :
───────────────────────────────────────
${texteDevis.substring(0, 12000)}
───────────────────────────────────────

LISTE DES MATÉRIAUX T3E (cherche ici le produit qui correspond au devis) :
${listeMateriaux || '(aucun matériau disponible)'}

Analyse le devis en profondeur et retourne ce JSON avec TOUS les champs remplis au maximum :
{
  "NOM_DU_PROJET": "nom complet du projet",
  "NUMERO_DU_PROJET": "numéro de référence",
  "SECTION": "numéro + titre complet de la section",
  "ARTICLE": "numéro + description complète de l'article",
  "TITRE": "nom exact du produit (de la liste matériaux si possible)",
  "FABRICANT": "nom du fabricant",
  "FOURNISSEUR": "nom du fournisseur",
  "DESCRIPTION": "description technique détaillée du produit/travail",
  "NUMERO_DESSINS": "références des dessins/plans si trouvées",
  "REMARQUE": "note professionnelle détaillée avec contexte, spécifications, conditions"
}`;

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
    NUMERO_DESSINS: champsIA.NUMERO_DESSINS || '',
    NOMBRE_FEUILLES: '',
    REVISION: '',
    DESCRIPTION: champsIA.DESCRIPTION || '',
    FOURNISSEUR: champsIA.FOURNISSEUR || '',
    FABRICANT: champsIA.FABRICANT || '',
    SECTION: champsIA.SECTION || '',
    ARTICLE: champsIA.ARTICLE || '',
    DELAI: '',
    REMARQUE: champsIA.REMARQUE || '',
  };

  console.log('[analyser] IA champs extraits:', JSON.stringify(champsIA).substring(0, 500));

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

  if (!row.template_data) {
    return res.status(400).send('Le template .docx est manquant pour ce bordereau. Veuillez recommencer depuis le début.');
  }

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

  console.log('[generer] Champs:', JSON.stringify(champs).substring(0, 300));
  console.log('[generer] template_data length:', row.template_data.length);

  // 2. Remplir le .docx — suit les étapes exactes :
  //    normalizeXmlText → remplirChampDansXml (NBSP + indexOf + labels longs d'abord)
  let bordereauBuffer;
  try {
    bordereauBuffer = Buffer.from(row.template_data, 'base64');
    console.log('[generer] Buffer .docx:', bordereauBuffer.length, 'octets');
  } catch (e) {
    return res.status(500).send('Erreur décodage template : ' + e.message);
  }

  let docxBuffer;
  try {
    docxBuffer = await remplirBordereau(champs, bordereauBuffer);
    console.log('[generer] .docx rempli:', docxBuffer.length, 'octets');
  } catch (e) {
    console.error('[generer] Erreur remplissage:', e);
    return res.status(500).send('Erreur remplissage .docx : ' + e.message);
  }

  // 3. Auto-match FT (recalculer au cas où l'utilisateur a changé FABRICANT/TITRE)
  let ftChemins = [];
  try {
    ftChemins = trouverFichesTechniques(champs.FABRICANT, champs.TITRE);
    console.log('[generer] FT trouvees:', ftChemins.length, ftChemins);
  } catch (e) {
    console.error('[generer] Erreur FT match:', e);
  }

  // 4. Fusionner les FT en un seul PDF
  let ftPdfBuffer = null;
  try {
    if (ftChemins.length > 0) ftPdfBuffer = await fusionnerPDF(ftChemins);
    console.log('[generer] FT PDF:', ftPdfBuffer ? ftPdfBuffer.length + ' octets' : 'aucune');
  } catch (e) {
    console.error('[generer] Erreur fusion PDF:', e);
  }

  // 5. Mettre à jour la DB
  const section = (champs.SECTION || champs.NUMERO_DU_PROJET || 'T3E').replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30);
  try {
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'approuve', session_actif = 0, numero_projet = ?, titre = ?, contenu = ? WHERE id = ?`,
      args: [
        champs.NUMERO_DU_PROJET || '',
        champs.NOM_DU_PROJET || '',
        JSON.stringify({ champs, ft_chemins: ftChemins }),
        id,
      ],
    });
  } catch (e) {
    console.error('[generer] Erreur DB update:', e);
  }

  // 6. Retourner le résultat
  const ts = Date.now();

  if (!ftPdfBuffer) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Bordereau_${section}_${ts}.docx"`);
    return res.send(docxBuffer);
  }

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
