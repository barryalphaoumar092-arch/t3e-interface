const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseDevis } = require('../services/document-parser');
const { remplirBordereau } = require('../services/bordereau-filler');
const { convertirDocxEnPdf, convertirPdfEnDocx } = require('../services/docx-to-pdf');
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
//  APPEL OPENAI GPT-4o — Contexte (section/article/remarque) pour
//  des produits DÉJÀ CHOISIS par l'utilisateur (plus de détection auto)
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT_CONTEXTE = `Tu es un chargé de projet SENIOR expert en couverture commerciale au Québec chez Toitures Trois Étoiles Inc. (T3E).
On te donne un devis de toiture ET une liste de produits DÉJÀ CHOISIS par l'estimateur (nom exact, fabricant, fournisseur — ne les remets pas en question).

=== TA MISSION ===
Pour CHAQUE produit de la liste, dans l'ORDRE donné :
1. Trouve dans le devis la SECTION (numéro 6 chiffres + titre, ex: "07 52 21 — Couverture à membrane de bitume modifié") où ce produit ou sa catégorie est traité
2. Trouve l'ARTICLE (sous-section Partie 2, ex: "2.2 Pare-vapeur") qui correspond le mieux à ce produit. Si le produit exact n'est pas nommé, déduis l'article le plus probable selon sa fonction (pare-vapeur, isolant, membrane, sous-couche, adhésif, apprêt, drain, évent, etc.)
3. Compose une REMARQUE technique courte (1-2 phrases) : fonction du produit + contexte pertinent du projet

Aussi, extrais du devis :
- NOM_DU_PROJET : page de garde, en-tête, "Projet :", "Objet :"
- NUMERO_DU_PROJET : "N° projet", "Dossier", "N/Réf", "Projet no"

=== RÈGLES ===
- Retourne EXACTEMENT un produit en sortie par produit en entrée, DANS LE MÊME ORDRE
- Ne change JAMAIS le nom/fabricant/fournisseur du produit, ils sont déjà corrects
- Retourne UNIQUEMENT du JSON valide`;

async function appelIAContexte(texteDevis, produitsSelectionnes) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const listeProduits = produitsSelectionnes.map((p, i) =>
    `${i + 1}. ${p.nom} (Fabricant: ${p.fabricant || 'inconnu'}, Fournisseur: ${p.fournisseur || 'inconnu'})`
  ).join('\n');

  const userContent = `TEXTE COMPLET DU DEVIS :
───────────────────────────────────────
${texteDevis.substring(0, 40000)}
───────────────────────────────────────

PRODUITS DÉJÀ CHOISIS PAR L'ESTIMATEUR (dans cet ordre) :
${listeProduits}

Retourne ce JSON :
{
  "NOM_DU_PROJET": "nom complet du projet (du DEVIS)",
  "NUMERO_DU_PROJET": "numéro de référence (du DEVIS)",
  "produits": [
    { "SECTION": "...", "ARTICLE": "...", "REMARQUE": "..." }
  ]
}

IMPORTANT : "produits" doit contenir EXACTEMENT ${produitsSelectionnes.length} entrée(s), dans le même ordre que la liste ci-dessus.`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 6000,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_CONTEXTE },
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

    if (!match) return [];
    fabDir = path.join(FT_DIR, match);
  }

  let pdfs;
  try { pdfs = fs.readdirSync(fabDir).filter(f => f.endsWith('.pdf')); } catch (_) { return []; }
  if (!titre || pdfs.length === 0) return pdfs.slice(0, 1).map(f => path.join(fabDir, f));

  const keywords = titre.toLowerCase()
    .replace(/[^a-zàâäéèêëîïôùûü0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'des', 'les', 'pour', 'avec', 'type'].includes(w));

  const scored = pdfs.map(f => {
    const fname = f.toLowerCase();
    const score = keywords.filter(k => fname.includes(k)).length;
    return { file: f, score };
  }).sort((a, b) => b.score - a.score);

  const meilleur = scored[0];
  if (meilleur && meilleur.score > 0) {
    console.log('[FT] Match par titre:', meilleur.file, '(score:', meilleur.score + ')');
    return [path.join(fabDir, meilleur.file)];
  }

  console.log('[FT] Aucun match par titre pour "' + titre + '" dans ' + path.basename(fabDir) + ', fallback sur les 2 premiers PDFs');
  return pdfs.slice(0, 2).map(f => path.join(fabDir, f));
}

// ══════════════════════════════════════════════════════════════
//  SOURCE AUTORITAIRE — base de matériaux T3E (lien_fiche_technique)
// ══════════════════════════════════════════════════════════════
let _materiauxCache = null;
let _materiauxCacheAt = 0;

async function chargerTousMateriaux(db) {
  const now = Date.now();
  if (_materiauxCache && now - _materiauxCacheAt < 5 * 60 * 1000) return _materiauxCache;
  const r = await db.execute('SELECT nom, fabricant, fournisseur, lien_fiche_technique FROM materiaux');
  _materiauxCache = r.rows;
  _materiauxCacheAt = now;
  return _materiauxCache;
}

function normaliserTexte(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // enlever accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function motsSignificatifs(s) {
  return normaliserTexte(s).split(' ').filter(w => w.length >= 4);
}

// Matching conservateur : exige soit un nom identique, soit 2+ mots specifiques
// partages, soit 1 mot specifique + meme fabricant. Evite les faux positifs sur
// des mots generiques (ex: "ultra") qui assigneraient le mauvais fabricant.
function matcherMateriau(matRows, titre, fabricant) {
  if (!titre || !matRows || matRows.length === 0) return null;

  const titreNorm = normaliserTexte(titre);
  if (!titreNorm) return null;

  const exact = matRows.find(m => normaliserTexte(m.nom) === titreNorm);
  if (exact) return exact;

  const titreMots = motsSignificatifs(titre);
  if (titreMots.length === 0) return null;
  const fabNorm = normaliserTexte(fabricant);

  let best = null;
  let bestScore = 0;

  for (const m of matRows) {
    const nomMots = motsSignificatifs(m.nom);
    const partages = titreMots.filter(w => nomMots.includes(w));
    if (partages.length === 0) continue;
    const fabMatch = !!(fabNorm && m.fabricant && normaliserTexte(m.fabricant) === fabNorm);
    if (partages.length < 2 && !fabMatch) continue;
    const score = partages.length + (fabMatch ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }

  return best;
}

async function obtenirMateriauMatch(db, titre, fabricant) {
  try {
    const matRows = await chargerTousMateriaux(db);
    const match = matcherMateriau(matRows, titre, fabricant);
    if (match) console.log('[materiaux] Match:', titre, '->', match.nom, '(' + match.fabricant + ')');
    else console.log('[materiaux] Aucun match pour titre="' + titre + '" fabricant="' + fabricant + '"');
    return match;
  } catch (e) {
    console.error('[materiaux] Erreur lookup:', e.message);
    return null;
  }
}

function nomFichierDepuisUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    let last = decodeURIComponent(parts[parts.length - 1] || 'fiche-technique.pdf');
    if (!last.toLowerCase().endsWith('.pdf')) last += '.pdf';
    return last;
  } catch (_) {
    return 'fiche-technique.pdf';
  }
}

// Télécharge la fiche technique depuis lien_fiche_technique (URL web de la DB matériaux)
async function telechargerFT(url) {
  if (!url) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      console.log('[FT-web] HTTP', resp.status, 'pour', url);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100 || buf.subarray(0, 4).toString('latin1') !== '%PDF') {
      console.log('[FT-web] Réponse non-PDF pour', url);
      return null;
    }
    return buf;
  } catch (e) {
    console.log('[FT-web] Erreur téléchargement', url, ':', e.message);
    return null;
  }
}

// Résout les FT d'un produit : 1) dossier local documents/FT/, 2) lien_fiche_technique (web)
async function resoudreFichesTechniques(db, fabricant, titre) {
  const buffers = [];

  const cheminsLocaux = trouverFichesTechniques(fabricant, titre);
  for (const p of cheminsLocaux) {
    if (fs.existsSync(p)) buffers.push(fs.readFileSync(p));
  }
  if (buffers.length > 0) return buffers;

  const match = await obtenirMateriauMatch(db, titre, fabricant);
  if (match && match.lien_fiche_technique) {
    const buf = await telechargerFT(match.lien_fiche_technique);
    if (buf) buffers.push(buf);
  }

  return buffers;
}

// Comme resoudreFichesTechniques, mais respecte une sélection manuelle faite par
// l'utilisateur sur la page de révision (valeur du <select> FT_FICHIER)
async function resoudreFichesTechniquesAvecSelection(db, fabricant, titre, selection) {
  if (selection === '__NONE__') return [];
  if (selection && selection !== '__AUTO__') {
    const fullPath = path.resolve(FT_DIR, selection);
    if (fullPath.startsWith(path.resolve(FT_DIR)) && fs.existsSync(fullPath)) {
      console.log('[FT] Sélection manuelle utilisée:', selection);
      return [fs.readFileSync(fullPath)];
    }
    console.log('[FT] Sélection manuelle introuvable:', selection, '- fallback auto');
  }
  return resoudreFichesTechniques(db, fabricant, titre);
}

async function fusionnerPdfBuffers(buffers) {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
      (await merged.copyPages(doc, doc.getPageIndices())).forEach(pg => merged.addPage(pg));
    } catch (e) {
      console.error('[fusionnerPdfBuffers] Erreur chargement PDF:', e.message);
    }
  }
  return merged.getPageCount() > 0 ? Buffer.from(await merged.save()) : null;
}

// ══════════════════════════════════════════════════════════════
//  LISTES POUR LES MENUS DÉROULANTS (fabricant / fournisseur / FT)
// ══════════════════════════════════════════════════════════════
function listerFTParFabricant() {
  const result = {};
  if (!fs.existsSync(FT_DIR)) return result;
  let dirs;
  try { dirs = fs.readdirSync(FT_DIR); } catch (_) { return result; }
  for (const d of dirs) {
    const full = path.join(FT_DIR, d);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      const pdfs = fs.readdirSync(full).filter(f => f.toLowerCase().endsWith('.pdf')).sort((a, b) => a.localeCompare(b));
      if (pdfs.length > 0) result[d] = pdfs;
    } catch (_) {}
  }
  return result;
}

async function listerFabricantsEtFournisseurs(db) {
  const matRows = await chargerTousMateriaux(db);
  const fabSet = new Set();
  const fourSet = new Set();
  for (const m of matRows) {
    if (m.fabricant) fabSet.add(m.fabricant.trim());
    if (m.fournisseur) fourSet.add(m.fournisseur.trim());
  }
  const ftParFab = listerFTParFabricant();
  for (const f of Object.keys(ftParFab)) fabSet.add(f);

  return {
    fabricants: [...fabSet].filter(Boolean).sort((a, b) => a.localeCompare(b)),
    fournisseurs: [...fourSet].filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };
}

function cheminRelatifFT(absPath) {
  if (!absPath) return '';
  return path.relative(FT_DIR, absPath).split(path.sep).join('/');
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  const r = await req.db.execute(
    "SELECT id, titre, numero_projet, cree_par, created_at FROM bordereaux WHERE (session_actif = 0 OR session_actif IS NULL) ORDER BY created_at DESC"
  );
  res.render('bordereaux', { bordereaux: r.rows });
});

router.get('/nouveau', (req, res) => {
  res.render('bordereau-nouveau');
});

// ── ANALYSER : upload devis + bordereau + matériaux SÉLECTIONNÉS PAR L'UTILISATEUR → révision ──
router.post('/analyser', uploadFields, async (req, res) => {
  const db = req.db;
  const { nom_entrepreneur, specialite, adresse, nom_projet } = req.body;

  const devisFile = req.files?.devis?.[0];
  const bordereauFile = req.files?.bordereau?.[0];
  if (!devisFile) return res.status(400).send('Veuillez importer le devis PDF.');
  if (!bordereauFile) return res.status(400).send('Veuillez importer le bordereau .docx.');

  const materiauIds = [].concat(req.body.materiau_id || [])
    .map(id => parseInt(id))
    .filter(id => !isNaN(id));

  if (materiauIds.length === 0) {
    try { fs.unlinkSync(devisFile.path); } catch (_) {}
    try { fs.unlinkSync(bordereauFile.path); } catch (_) {}
    return res.status(400).send('Veuillez sélectionner au moins un matériau dans la barre de recherche.');
  }

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

  const bordereauBuffer = fs.readFileSync(bordereauFile.path);
  try { fs.unlinkSync(bordereauFile.path); } catch (_) {}

  // Charger les matériaux EXACTEMENT choisis par l'utilisateur (source 100% fiable,
  // plus de devinage par l'IA pour TITRE/FABRICANT/FOURNISSEUR)
  const placeholders = materiauIds.map(() => '?').join(',');
  const matRows = (await db.execute({
    sql: `SELECT id, nom, fabricant, fournisseur, lien_fiche_technique FROM materiaux WHERE id IN (${placeholders})`,
    args: materiauIds,
  })).rows;

  // Conserver l'ordre de sélection de l'utilisateur
  const produitsBase = materiauIds
    .map(id => matRows.find(m => m.id === id))
    .filter(Boolean);

  // Appel IA GPT-4o — uniquement pour situer chaque produit dans le devis (section/article/remarque)
  let iaResult = {};
  let iaErreur = '';
  try {
    iaResult = await appelIAContexte(texteDevis, produitsBase);
  } catch (e) {
    iaErreur = e.message;
  }

  const nomProjet = iaResult.NOM_DU_PROJET || nom_projet || '';
  const numProjet = iaResult.NUMERO_DU_PROJET || '';
  const contexteProduits = iaResult.produits || [];

  const identification = {
    NOM: nom_entrepreneur?.trim() || 'Toitures Trois Étoiles',
    SPECIALITE: specialite?.trim() || 'COUVREUR',
    ADRESSE: adresse?.trim() || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
  };

  const produits = produitsBase.map((mat, i) => {
    const ctx = contexteProduits[i] || {};
    const p = {
      TITRE: mat.nom,
      FABRICANT: mat.fabricant || '',
      FOURNISSEUR: mat.fournisseur || '',
      SECTION: ctx.SECTION || '',
      ARTICLE: ctx.ARTICLE || '',
      DESCRIPTION: ctx.REMARQUE || '',
      REMARQUE: '',
      ft_url: mat.lien_fiche_technique || '',
    };
    p.ft_chemins = trouverFichesTechniques(p.FABRICANT, p.TITRE);
    p.ft_noms = p.ft_chemins.map(c => path.basename(c));
    if (p.ft_noms.length === 0 && p.ft_url) {
      p.ft_noms = [nomFichierDepuisUrl(p.ft_url) + ' (web)'];
    }
    p.ft_selection = p.ft_chemins.length > 0 ? cheminRelatifFT(p.ft_chemins[0]) : '__AUTO__';
    return p;
  });

  console.log('[analyser]', produits.length, 'produits sélectionnés par l\'utilisateur pour', nomProjet);

  // Sauvegarder en DB
  const contenu = JSON.stringify({
    nomProjet, numProjet, identification, produits, ia_erreur: iaErreur,
  });

  const r = await db.execute({
    sql: `INSERT INTO bordereaux (numero_projet, titre, contenu, statut, session_actif, cree_par, devis_texte, template_data)
          VALUES (?, ?, ?, 'brouillon', 1, ?, ?, ?)`,
    args: [
      numProjet,
      nomProjet || 'Bordereau en cours',
      contenu,
      identification.NOM,
      texteDevis.substring(0, 10000),
      bordereauBuffer.toString('base64'),
    ],
  });

  res.redirect('/bordereaux/reviser/' + (r.lastInsertRowid || 0));
});

// ── PAGE DE RÉVISION — affiche N produits ──
router.get('/reviser/:id', async (req, res) => {
  const r = await req.db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [parseInt(req.params.id)] });
  if (r.rows.length === 0) return res.redirect('/bordereaux');

  const row = r.rows[0];
  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }

  // Compatibilité ancien format
  if (data.champs && !data.produits) {
    const c = data.champs;
    data = {
      nomProjet: c.NOM_DU_PROJET || '',
      numProjet: c.NUMERO_DU_PROJET || '',
      identification: { NOM: c.NOM || '', SPECIALITE: c.SPECIALITE || '', ADRESSE: c.ADRESSE || '' },
      produits: [{
        SECTION: c.SECTION || '', ARTICLE: c.ARTICLE || '',
        TITRE: c.TITRE || '', FABRICANT: c.FABRICANT || '',
        FOURNISSEUR: c.FOURNISSEUR || '',
        DESCRIPTION: c.REMARQUE || '',
        REMARQUE: '',
        ft_noms: data.ft_chemins ? data.ft_chemins.map(p => path.basename(p)) : [],
        ft_selection: data.ft_chemins && data.ft_chemins.length > 0 ? cheminRelatifFT(data.ft_chemins[0]) : '__AUTO__',
      }],
      ia_erreur: data.ia_erreur || '',
    };
  }

  // S'assurer que chaque produit a une selection FT (anciens enregistrements)
  for (const p of (data.produits || [])) {
    if (!p.ft_selection) p.ft_selection = '__AUTO__';
  }

  const { fabricants, fournisseurs } = await listerFabricantsEtFournisseurs(req.db);
  const ftParFabricant = listerFTParFabricant();

  res.render('bordereau-reviser', {
    bordereau: row,
    nomProjet: data.nomProjet || '',
    numProjet: data.numProjet || '',
    identification: data.identification || {},
    produits: data.produits || [],
    iaErreur: data.ia_erreur || '',
    fabricantsListe: fabricants,
    fournisseursListe: fournisseurs,
    ftParFabricant,
  });
});

// ── GÉNÉRER — remplir N .docx + FT → ZIP ──
router.post('/generer/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau introuvable');

  const row = r.rows[0];
  if (!row.template_data) {
    return res.status(400).send('Le template .docx est manquant. Veuillez recommencer.');
  }

  const bordereauBuffer = Buffer.from(row.template_data, 'base64');

  // Récupérer les champs du formulaire pour chaque produit
  const nomProjet = req.body.NOM_DU_PROJET || '';
  const numProjet = req.body.NUMERO_DU_PROJET || '';
  const nom = req.body.NOM || 'Toitures Trois Étoiles';
  const specialite = req.body.SPECIALITE || 'COUVREUR';
  const adresse = req.body.ADRESSE || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1';

  // Les champs produit arrivent comme tableaux (TITRE[], FABRICANT[], etc.)
  const titres = [].concat(req.body.TITRE || []);
  const fabricants = [].concat(req.body.FABRICANT || []);
  const fournisseurs = [].concat(req.body.FOURNISSEUR || []);
  const sections = [].concat(req.body.SECTION || []);
  const articles = [].concat(req.body.ARTICLE || []);
  const descriptions = [].concat(req.body.DESCRIPTION || []);
  const ftSelections = [].concat(req.body.FT_FICHIER || []);

  const nbProduits = titres.length;
  console.log('[generer] Génération de', nbProduits, 'bordereaux pour', nomProjet);

  const zip = new JSZip();
  const ts = Date.now();

  for (let i = 0; i < nbProduits; i++) {
    const champs = {
      NOM_DU_PROJET: nomProjet,
      NUMERO_DU_PROJET: numProjet,
      NOM: nom,
      SPECIALITE: specialite,
      ADRESSE: adresse,
      TITRE: titres[i] || '',
      FABRICANT: fabricants[i] || '',
      FOURNISSEUR: fournisseurs[i] || '',
      SECTION: sections[i] || '',
      ARTICLE: articles[i] || '',
      DESCRIPTION: descriptions[i] || '',
      REMARQUE: '',
    };

    // Compléter FABRICANT/FOURNISSEUR si vides, via la DB matériaux (filet de sécurité)
    if (champs.TITRE && (!champs.FABRICANT || !champs.FOURNISSEUR)) {
      const match = await obtenirMateriauMatch(db, champs.TITRE, champs.FABRICANT);
      if (match) {
        champs.FABRICANT = champs.FABRICANT || match.fabricant || '';
        champs.FOURNISSEUR = champs.FOURNISSEUR || match.fournisseur || '';
      }
    }

    const num = String(i + 1).padStart(2, '0');
    const nomFichier = (titres[i] || 'Produit').replace(/[^a-zA-Z0-9àâäéèêëîïôùûüÀÉ _-]/g, '').substring(0, 40).trim();

    // 1. Remplir le template (DOCX ou PDF), convertir en PDF, puis fusionner
    //    avec la fiche technique en UN SEUL PDF (bordereau + FT à la suite)
    try {
      const estPdfTemplate = bordereauBuffer.length >= 4 &&
        bordereauBuffer.slice(0, 4).toString('latin1') === '%PDF';

      let docxBuf;
      if (estPdfTemplate) {
        console.log(`[generer] ${num} Template PDF détecté → conversion PDF→DOCX via LibreOffice`);
        const docxTemplate = await convertirPdfEnDocx(bordereauBuffer);
        docxBuf = await remplirBordereau(champs, docxTemplate);
      } else {
        docxBuf = await remplirBordereau(champs, bordereauBuffer);
      }

      let ftBuffers = [];
      try {
        ftBuffers = await resoudreFichesTechniquesAvecSelection(db, champs.FABRICANT, champs.TITRE, ftSelections[i]);
        if (ftBuffers.length === 0) {
          console.log(`[generer] ${num} Aucune FT trouvee (ni locale ni web) pour`, champs.TITRE, '/', champs.FABRICANT);
        }
      } catch (eFt) {
        console.error(`[generer] ${num} Erreur FT:`, eFt.message);
      }

      let bordereauPdfBuf = null;
      let erreurPdf = null;
      try {
        bordereauPdfBuf = await convertirDocxEnPdf(docxBuf);
      } catch (ePdf) {
        console.error(`[generer] ${num} Erreur conversion PDF:`, ePdf.message);
        erreurPdf = ePdf;
      }

      if (bordereauPdfBuf) {
        // Bordereau PDF + FT = 1 seul document PDF
        const finalPdf = await fusionnerPdfBuffers([bordereauPdfBuf, ...ftBuffers]);
        if (finalPdf) {
          zip.file(`${num}_${nomFichier}.pdf`, finalPdf);
          console.log(`[generer] ${num} PDF fusionné OK (bordereau + ${ftBuffers.length} FT): ${titres[i]}`);
        }
      } else {
        // Filet de sécurité : conversion PDF échouée → .docx + FT séparée
        zip.file(`${num}_${nomFichier}.docx`, docxBuf);
        zip.file(`${num}_${nomFichier}_ERREUR_conversion_PDF.txt`, 'La conversion en PDF a échoué :\n' + (erreurPdf ? erreurPdf.stack : 'erreur inconnue'));
        const ftPdf = await fusionnerPdfBuffers(ftBuffers);
        if (ftPdf) zip.file(`${num}_${nomFichier}_FT.pdf`, ftPdf);
      }
    } catch (e) {
      console.error(`[generer] ${num} Erreur remplissage:`, e.message);
      zip.file(`${num}_${nomFichier}/ERREUR_remplissage.txt`, 'Le remplissage du bordereau a échoué :\n' + e.stack);
    }
  }

  // Mettre à jour la DB
  try {
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'approuve', session_actif = 0, numero_projet = ?, titre = ? WHERE id = ?`,
      args: [numProjet, nomProjet, id],
    });
  } catch (_) {}

  const section = (numProjet || nomProjet || 'T3E').replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Bordereaux_${section}_${ts}.zip"`);
  res.send(zipBuffer);
});

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

router.post('/supprimer/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try { await req.db.execute({ sql: 'DELETE FROM historique_bordereaux WHERE bordereau_id = ?', args: [id] }); } catch (_) {}
  await req.db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [id] });
  res.redirect('/bordereaux');
});

module.exports = router;
