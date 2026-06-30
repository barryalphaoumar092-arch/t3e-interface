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
//  APPEL OPENAI GPT-4o — Extraction de TOUS les produits
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Tu es un chargé de projet SENIOR expert en couverture commerciale au Québec chez Toitures Trois Étoiles Inc. (T3E).
Tu analyses un devis de toiture pour remplir des BORDEREAUX DE TRANSMISSION DE FICHES TECHNIQUES.

=== TA MISSION ===
Tu dois trouver TOUS les "Produit de référence" mentionnés dans le devis.
Chaque produit distinct = 1 bordereau séparé.

Exemples de produits à trouver : pare-vapeur, membrane de finition, sous-couche, isolant, panneau support, adhésif, apprêt, drain, évent, panneau de gypse, vis et plaques, solins, etc.

=== OÙ CHERCHER CHAQUE INFO ===

SOURCE 1 — DEVIS PDF :
- NOM_DU_PROJET : page de garde, en-tête, "Projet :", "Objet :"
- NUMERO_DU_PROJET : "N° projet", "Dossier", "N/Réf", "Projet no"
- SECTION : numéro de section 6 chiffres + titre (ex: "07 52 21 — Couverture à membrane de bitume modifié")
- ARTICLE : sous-section Partie 2 qui décrit CE produit spécifique (ex: "2.2 Pare-vapeur")

SOURCE 2 — LISTE DES MATÉRIAUX T3E (fournie ci-dessous) :
- TITRE : nom EXACT du produit dans la liste T3E (colonne E)
- FABRICANT : fabricant de la liste T3E (colonne C)
- FOURNISSEUR : fournisseur de la liste T3E (colonne D)
Si le produit n'est pas dans la liste T3E, utilise le nom commercial du devis.

SOURCE 3 — IA (tu composes) :
- REMARQUE : note technique courte (1-2 phrases) décrivant le produit et sa fonction

=== RÈGLES ===
- Cherche CHAQUE "Produit de référence :" dans le devis, section par section
- Cherche aussi les produits mentionnés sans le label "Produit de référence" (drains, évents, adhésifs, apprêts, etc.)
- NE retourne PAS de doublons (même produit mentionné 2 fois)
- TITRE, FABRICANT, FOURNISSEUR viennent de la LISTE MATÉRIAUX T3E quand possible
- Retourne UNIQUEMENT du JSON valide`;

async function appelIA(texteDevis, listeMateriaux) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const userContent = `TEXTE COMPLET DU DEVIS :
───────────────────────────────────────
${texteDevis.substring(0, 30000)}
───────────────────────────────────────

LISTE DES MATÉRIAUX T3E :
${listeMateriaux || '(aucun matériau disponible)'}

Retourne ce JSON avec TOUS les produits trouvés :
{
  "NOM_DU_PROJET": "nom complet du projet (du DEVIS)",
  "NUMERO_DU_PROJET": "numéro de référence (du DEVIS)",
  "produits": [
    {
      "SECTION": "07 52 21 — titre de la section",
      "ARTICLE": "2.X — sous-article Partie 2",
      "TITRE": "nom exact du produit (LISTE T3E ou devis)",
      "FABRICANT": "fabricant (LISTE T3E)",
      "FOURNISSEUR": "fournisseur (LISTE T3E)",
      "REMARQUE": "note technique courte"
    }
  ]
}

IMPORTANT : retourne un produit par entrée. Trouve-en le MAXIMUM.`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 8000,
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
async function obtenirMateriauMatch(db, titre, fabricant) {
  if (!titre) return null;
  try {
    let r = await db.execute({
      sql: 'SELECT nom, fabricant, fournisseur, lien_fiche_technique FROM materiaux WHERE nom = ? COLLATE NOCASE LIMIT 1',
      args: [titre],
    });
    if (r.rows.length === 0 && fabricant) {
      r = await db.execute({
        sql: 'SELECT nom, fabricant, fournisseur, lien_fiche_technique FROM materiaux WHERE nom LIKE ? AND fabricant LIKE ? LIMIT 1',
        args: ['%' + titre + '%', '%' + fabricant + '%'],
      });
    }
    if (r.rows.length === 0) {
      r = await db.execute({
        sql: 'SELECT nom, fabricant, fournisseur, lien_fiche_technique FROM materiaux WHERE nom LIKE ? LIMIT 1',
        args: ['%' + titre + '%'],
      });
    }
    return r.rows.length > 0 ? r.rows[0] : null;
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

// ── ANALYSER : upload devis + bordereau → IA extrait N produits → révision ──
router.post('/analyser', uploadFields, async (req, res) => {
  const db = req.db;
  const { nom_entrepreneur, specialite, adresse, nom_projet } = req.body;

  const devisFile = req.files?.devis?.[0];
  const bordereauFile = req.files?.bordereau?.[0];
  if (!devisFile) return res.status(400).send('Veuillez importer le devis PDF.');
  if (!bordereauFile) return res.status(400).send('Veuillez importer le bordereau .docx.');

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

  // Charger les matériaux pour l'IA
  let listeMateriaux = '';
  try {
    const STOP = new Set(['pour', 'dans', 'avec', 'sont', 'cette', 'leur', 'plus', 'tout', 'bien', 'sous', 'même', 'autre', 'être', 'fait', 'donc', 'très', 'peut', 'sans', 'dont', 'sera', 'avoir', 'nous', 'vous', 'type', 'selon', 'voir', 'afin']);
    const mots = texteDevis.toLowerCase().match(/[a-zàâäéèêëîïôùûü]{4,}/g) || [];
    const keywords = [...new Set(mots)].filter(m => !STOP.has(m)).slice(0, 80);

    const matRows = (await db.execute('SELECT nom, fabricant, fournisseur, type_produit FROM materiaux ORDER BY fabricant, nom')).rows;
    const pertinents = matRows.filter(m => {
      const txt = `${m.nom} ${m.fabricant || ''} ${m.fournisseur || ''} ${m.type_produit || ''}`.toLowerCase();
      return keywords.some(k => txt.includes(k));
    }).slice(0, 100);

    const liste = pertinents.length > 0 ? pertinents : matRows.slice(0, 100);
    listeMateriaux = 'FORMAT: Produit | Fabricant | Fournisseur\n' +
      liste.map(m => [m.nom, m.fabricant || '', m.fournisseur || ''].join(' | ')).join('\n');
  } catch (_) {}

  // Appel IA GPT-4o — extraction de TOUS les produits
  let iaResult = {};
  let iaErreur = '';
  try {
    iaResult = await appelIA(texteDevis, listeMateriaux);
  } catch (e) {
    iaErreur = e.message;
  }

  const nomProjet = iaResult.NOM_DU_PROJET || nom_projet || '';
  const numProjet = iaResult.NUMERO_DU_PROJET || '';
  let produits = iaResult.produits || [];

  // Si l'IA retourne l'ancien format (1 seul produit, pas de tableau)
  if (produits.length === 0 && iaResult.TITRE) {
    produits = [{
      SECTION: iaResult.SECTION || '',
      ARTICLE: iaResult.ARTICLE || '',
      TITRE: iaResult.TITRE || '',
      FABRICANT: iaResult.FABRICANT || '',
      FOURNISSEUR: iaResult.FOURNISSEUR || '',
      REMARQUE: iaResult.REMARQUE || '',
    }];
  }

  // Pour chaque produit, trouver la FT
  const identification = {
    NOM: nom_entrepreneur?.trim() || 'Toitures Trois Étoiles',
    SPECIALITE: specialite?.trim() || 'COUVREUR',
    ADRESSE: adresse?.trim() || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
  };

  for (const p of produits) {
    // Source autoritaire : DB matériaux T3E (Excel importé) — écrase le devinage de l'IA
    const match = await obtenirMateriauMatch(db, p.TITRE, p.FABRICANT);
    if (match) {
      p.TITRE = match.nom || p.TITRE;
      p.FABRICANT = match.fabricant || p.FABRICANT;
      p.FOURNISSEUR = match.fournisseur || p.FOURNISSEUR;
      p.ft_url = match.lien_fiche_technique || '';
    } else {
      p.ft_url = '';
    }

    p.ft_chemins = trouverFichesTechniques(p.FABRICANT, p.TITRE);
    p.ft_noms = p.ft_chemins.map(c => path.basename(c));
    if (p.ft_noms.length === 0 && p.ft_url) {
      p.ft_noms = [nomFichierDepuisUrl(p.ft_url) + ' (web)'];
    }
  }

  console.log('[analyser] IA trouvé', produits.length, 'produits pour', nomProjet);

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
        FOURNISSEUR: c.FOURNISSEUR || '', REMARQUE: c.REMARQUE || '',
        ft_noms: data.ft_chemins ? data.ft_chemins.map(p => path.basename(p)) : [],
      }],
      ia_erreur: data.ia_erreur || '',
    };
  }

  res.render('bordereau-reviser', {
    bordereau: row,
    nomProjet: data.nomProjet || '',
    numProjet: data.numProjet || '',
    identification: data.identification || {},
    produits: data.produits || [],
    iaErreur: data.ia_erreur || '',
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
  const remarques = [].concat(req.body.REMARQUE || []);

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
      REMARQUE: remarques[i] || '',
    };

    const num = String(i + 1).padStart(2, '0');
    const nomFichier = (titres[i] || 'Produit').replace(/[^a-zA-Z0-9àâäéèêëîïôùûüÀÉ _-]/g, '').substring(0, 40).trim();

    // 1. Remplir le .docx avec JSZip (exact même code que bordereau-filler.js)
    try {
      const docxBuf = await remplirBordereau(champs, bordereauBuffer);
      zip.file(`${num}_${nomFichier}/Bordereau_${nomFichier}.docx`, docxBuf);
      console.log(`[generer] ${num} .docx OK: ${titres[i]}`);
    } catch (e) {
      console.error(`[generer] ${num} Erreur .docx:`, e.message);
    }

    // 2. Trouver et ajouter la FT — dossier local d'abord, puis lien_fiche_technique (DB matériaux) en fallback
    try {
      const ftBuffers = await resoudreFichesTechniques(db, champs.FABRICANT, champs.TITRE);
      if (ftBuffers.length > 0) {
        const merged = await PDFDocument.create();
        for (const ftBuf of ftBuffers) {
          try {
            const ftDoc = await PDFDocument.load(ftBuf, { ignoreEncryption: true });
            const pages = await merged.copyPages(ftDoc, ftDoc.getPageIndices());
            pages.forEach(pg => merged.addPage(pg));
          } catch (e) {
            console.error(`[generer] ${num} Erreur chargement PDF FT:`, e.message);
          }
        }
        if (merged.getPageCount() > 0) {
          const ftPdf = Buffer.from(await merged.save());
          zip.file(`${num}_${nomFichier}/FT_${nomFichier}.pdf`, ftPdf);
          console.log(`[generer] ${num} FT OK: ${ftBuffers.length} fichier(s), ${merged.getPageCount()} pages`);
        }
      } else {
        console.log(`[generer] ${num} Aucune FT trouvee (ni locale ni web) pour`, champs.TITRE, '/', champs.FABRICANT);
      }
    } catch (e) {
      console.error(`[generer] ${num} Erreur FT:`, e.message);
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
