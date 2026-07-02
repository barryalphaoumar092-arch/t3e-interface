const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { parseDevis } = require('../services/document-parser');
const { remplirBordereau } = require('../services/bordereau-filler');
const { convertirDocxEnPdf } = require('../services/docx-to-pdf');
const { convertirDocEnDocx, estDocLegacy, estDocxValide } = require('../services/doc-to-docx');
const { PDFDocument } = require('pdf-lib');
const JSZip = require('jszip');
const { downloadBuffer, removeFile, listFiles, stripAccents, BUCKETS } = require('../services/storage');

// Les fichiers devis/bordereau sont uploades par le navigateur DIRECTEMENT
// vers Supabase Storage (bucket "uploads-temp", voir /api/upload-url) pour
// contourner la limite de 4.5 Mo par requete des fonctions serverless Vercel.
// On les rapatrie ici en fichier temporaire pour parseDevis()/remplirBordereau()
// puis on les supprime du bucket temp.
async function telechargerVersFichierTemp(bucket, key, nomOriginal) {
  const buf = await downloadBuffer(bucket, key);
  if (!buf) return null;
  const tmpPath = path.join(os.tmpdir(), `t3e_${crypto.randomBytes(6).toString('hex')}_${path.basename(nomOriginal || key)}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

// ══════════════════════════════════════════════════════════════
//  APPEL OPENAI GPT-4o — Contexte (section/article/remarque) pour
//  des produits DÉJÀ CHOISIS par l'utilisateur (plus de détection auto)
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT_CONTEXTE = `Tu es un chargé de projet SENIOR expert en couverture commerciale au Québec chez Toitures Trois Étoiles Inc. (T3E).
On te donne un devis de toiture ET une liste de produits DÉJÀ CHOISIS par l'estimateur (nom exact, fabricant, fournisseur — ne les remets pas en question).

=== TA MISSION ===
Pour CHAQUE produit de la liste, dans l'ORDRE donné :
1. Trouve dans L'EXTRAIT DE DEVIS FOURNI CI-DESSOUS (pas dans ta mémoire générale de devis types) la SECTION (numéro 6 chiffres + titre, ex: "07 52 21 — Couverture à membrane de bitume modifié") où ce produit ou sa catégorie est réellement traité. Le numéro de section VARIE d'un devis à l'autre (un projet peut utiliser "07 52 21", un autre "07 52 00" pour un contenu similaire) — ne réutilise JAMAIS un numéro "typique" que tu connais par ailleurs sans l'avoir vu explicitement dans CET extrait.
2. Trouve l'ARTICLE (sous-section Partie 2, ex: "2.2 Pare-vapeur") qui correspond le mieux à ce produit, EN LISANT la liste réelle des articles de cette section dans l'extrait fourni. Les devis QUÉBÉCOIS NOMMENT RAREMENT LES MARQUES : ne t'attends PAS à trouver "Soprastar" ou tout autre nom de marque écrit textuellement — le devis décrit une FONCTION ("membrane de finition", "pare-vapeur autocollant", etc.) que le produit remplit. C'est NORMAL et ATTENDU de devoir déduire l'article à partir de la fonction/catégorie du produit plutôt que de chercher son nom exact. Choisis l'article dont la description de fonction correspond le mieux, PARMI ceux qui existent réellement dans la section identifiée à l'étape 1 — n'invente jamais un numéro d'article absent de l'extrait.
3. Retourne une chaîne vide pour SECTION et ARTICLE UNIQUEMENT si aucune section de l'extrait ne traite, même en substance, la catégorie/fonction de ce produit (ex: un produit électrique alors que l'extrait ne couvre que la toiture). Ne retourne JAMAIS vide simplement parce que la marque n'est pas nommée mot pour mot — c'est la situation normale, pas une raison de renoncer (voir point 2).
4. Compose un USAGE très court (une seule phrase courte, 3 à 10 mots, PAS un paragraphe) décrivant simplement ce qu'est le produit, du style "Une membrane de sous-couche", "Un panneau isolant thermique de polyisocyanurate", "Une bande de recouvrement"

Aussi, extrais du devis :
- NOM_DU_PROJET : page de garde, en-tête, "Projet :", "Objet :"
- NUMERO_DU_PROJET : "N° projet", "Dossier", "N/Réf", "Projet no"
- NOM_ETABLISSEMENT : le nom du propriétaire/établissement/école/bâtiment (ex: "Polytechnique Montréal", "École Laval Senior Academy") — PAS le nom du projet lui-même, mais l'entité propriétaire. Vide si absent du devis.
- ARCHITECTE_FIRME : le nom de la firme d'architectes qui a préparé le devis (souvent en page de garde ou page des sceaux/signatures). Vide si absent.
- ARCHITECTE_CONTACT : le nom de la personne (architecte associé/responsable) si mentionné, sinon vide.

Beaucoup de bordereaux d'architectes tiers (différents du gabarit T3E) ont des champs comme "Nom de l'école ou de l'établissement" ou "ARCHITECTE" qui n'existent pas dans le gabarit T3E — ces informations, quand elles sont dans le devis, DOIVENT être extraites même si tu ne sais pas encore où elles seront utilisées.

=== RÈGLES ===
- Retourne EXACTEMENT un produit en sortie par produit en entrée, DANS LE MÊME ORDRE
- Ne change JAMAIS le nom/fabricant/fournisseur du produit, ils sont déjà corrects
- Retourne UNIQUEMENT du JSON valide`;

// Les devis font souvent 100+ pages : tronquer bêtement aux N premiers
// caractères (comportement précédent) laisse fréquemment la Division 07
// (couverture — ce qui nous intéresse) hors du texte envoyé à l'IA, qui doit
// alors DEVINER section/article plutôt que de les lire réellement dans CE
// devis précis. D'où des erreurs qui varient d'un devis à l'autre.
// On priorise : la table des matières (liste tous les VRAIS numéros de
// section de CE devis) + le contenu complet de chaque section de Division
// 05/06/07/08/09 (où se trouvent les matériaux de toiture et travaux connexes).
function extraireContextePertinent(texteDevis, budgetMax = 400000, capParSection = 30000) {
  const intro = [];

  // Page de garde / sceaux et signatures : c'est là que se trouvent le nom du
  // projet, son numéro, le propriétaire/établissement et la firme d'architectes.
  intro.push('=== DÉBUT DU DEVIS (page de garde, sceaux) ===\n' + texteDevis.substring(0, 4000));

  const tdmMatch = texteDevis.match(/TABLE DES MATI[EÈ]RES[\s\S]{0,6000}?FIN DE LA SECTION/i);
  if (tdmMatch) intro.push('=== TABLE DES MATIÈRES DU DEVIS ===\n' + tdmMatch[0]);

  // Marqueur fiable de DÉBUT de section, observé dans les devis québécois type
  // CIMAISE/AMCQ : "Section 07 52 21 ... Page 1 de 29" (seule la première page
  // d'une section porte "Page 1 de", les suivantes portent "Page 2 de", etc.)
  const debutSectionRegex = /Section\s+((?:0[5-9])\s?\d{2}\s?\d{2})[^\n]*\r?\n[^\n]*Page\s*1\s*de\s*\d+/gi;
  const positions = [];
  const vus = new Set();
  let m;
  while ((m = debutSectionRegex.exec(texteDevis))) {
    const numero = m[1].replace(/\s/g, '');
    if (vus.has(numero)) continue;
    vus.add(numero);
    positions.push({ numero, index: m.index });
  }

  if (positions.length === 0) {
    // Format de devis non standard (marqueurs "Page 1 de" introuvables) : pas
    // de sections détectées, on élargit plutôt le début du document pour
    // conserver une chance raisonnable de couvrir la Division 07, au lieu de
    // se limiter aux 4000 premiers caractères déjà pris pour la page de garde.
    intro.push(texteDevis.substring(4000, budgetMax));
    return intro.join('\n\n---\n\n').substring(0, budgetMax);
  }

  // Les sections de couverture font souvent 15-20 pages (~35-45k caractères) :
  // la PARTIE 2 - PRODUITS (numéros d'article) arrive après la PARTIE 1 -
  // GÉNÉRALITÉS (normes/références, parfois volumineuse) et démarre donc
  // souvent bien après les 15 premiers milliers de caractères. Un plafond par
  // section trop bas coupait la section EXACTEMENT avant la liste d'articles.
  positions.sort((a, b) => a.index - b.index);
  const sections = positions.map((pos, i) => {
    const debut = pos.index;
    const fin = i + 1 < positions.length ? positions[i + 1].index : Math.min(texteDevis.length, debut + capParSection);
    return { numero: pos.numero, texte: texteDevis.substring(debut, Math.min(fin, debut + capParSection)) };
  });

  // Priorité Division 07 (couverture — le cœur du métier de T3E), puis 06/08
  // (charpenterie/ouvertures, souvent connexes), puis 05/09 en dernier — pour
  // que la troncature finale au budget, si elle doit arriver, coupe les
  // divisions les moins pertinentes plutôt que la 07.
  const rang = (numero) => {
    const div = numero.substring(0, 2);
    if (div === '07') return 0;
    if (div === '06' || div === '08') return 1;
    return 2;
  };
  sections.sort((a, b) => rang(a.numero) - rang(b.numero));

  const morceaux = [...intro, ...sections.map(s => s.texte)];
  return morceaux.join('\n\n---\n\n').substring(0, budgetMax);
}

async function appelIAContexte(texteDevis, produitsSelectionnes) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const listeProduits = produitsSelectionnes.map((p, i) =>
    `${i + 1}. ${p.nom} (Fabricant: ${p.fabricant || 'inconnu'}, Fournisseur: ${p.fournisseur || 'inconnu'})`
  ).join('\n');

  const userContent = `EXTRAIT DU DEVIS (table des matières + sections de Division 05-09 pertinentes — PAS le début brut du fichier) :
───────────────────────────────────────
${extraireContextePertinent(texteDevis)}
───────────────────────────────────────

PRODUITS DÉJÀ CHOISIS PAR L'ESTIMATEUR (dans cet ordre) :
${listeProduits}

Retourne ce JSON :
{
  "NOM_DU_PROJET": "nom complet du projet (du DEVIS)",
  "NUMERO_DU_PROJET": "numéro de référence (du DEVIS)",
  "NOM_ETABLISSEMENT": "nom du propriétaire/établissement (du DEVIS), ou chaîne vide si absent",
  "ARCHITECTE_FIRME": "nom de la firme d'architectes (du DEVIS), ou chaîne vide si absent",
  "ARCHITECTE_CONTACT": "nom de la personne architecte (du DEVIS), ou chaîne vide si absent",
  "produits": [
    { "SECTION": "...", "ARTICLE": "...", "USAGE": "..." }
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
//  AUTO-MATCH FICHES TECHNIQUES — bucket Supabase "fiches-techniques",
//  organise en dossiers virtuels {Fabricant}/{fichier}.pdf
// ══════════════════════════════════════════════════════════════
let _ftFoldersCache = null;
let _ftFoldersCacheAt = 0;

async function listerDossiersFT() {
  const now = Date.now();
  if (_ftFoldersCache && now - _ftFoldersCacheAt < 5 * 60 * 1000) return _ftFoldersCache;
  let entries = [];
  try { entries = await listFiles(BUCKETS.FICHES_TECHNIQUES, ''); } catch (e) {
    console.error('[FT] Erreur listage dossiers:', e.message);
  }
  _ftFoldersCache = entries.filter(e => e.id === null).map(e => e.name);
  _ftFoldersCacheAt = now;
  return _ftFoldersCache;
}

async function listerPdfsDossierFT(dossier) {
  let entries = [];
  try { entries = await listFiles(BUCKETS.FICHES_TECHNIQUES, dossier); } catch (_) { return []; }
  return entries.filter(e => e.id !== null && e.name.toLowerCase().endsWith('.pdf')).map(e => e.name);
}

async function trouverFichesTechniques(fabricant, titre) {
  if (!fabricant) return [];

  const allDirs = await listerDossiersFT();
  const fabLower = stripAccents(fabricant).toLowerCase();
  const match = allDirs.find(d => stripAccents(d).toLowerCase() === fabLower)
    || allDirs.find(d => stripAccents(d).toLowerCase().includes(fabLower.substring(0, 4)))
    || allDirs.find(d => fabLower.includes(stripAccents(d).toLowerCase().substring(0, 4)));

  if (!match) return [];

  const pdfs = await listerPdfsDossierFT(match);
  if (!titre || pdfs.length === 0) return pdfs.slice(0, 1).map(f => `${match}/${f}`);

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
    return [`${match}/${meilleur.file}`];
  }

  console.log('[FT] Aucun match par titre pour "' + titre + '" dans ' + match + ', fallback sur les 2 premiers PDFs');
  return pdfs.slice(0, 2).map(f => `${match}/${f}`);
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

// Si l'IA a extrait un nom de firme d'architectes du devis, on tente de le
// recouper avec la base de connaissances (table architectes) pour obtenir des
// coordonnées plus completes/fiables que ce que le devis mentionne seul.
async function obtenirArchitecteMatch(db, firme) {
  if (!firme) return null;
  try {
    const firmeLower = stripAccents(firme).toLowerCase().trim();
    const r = await db.execute({ sql: 'SELECT firme, ville, adresse, telephone, email, contact FROM architectes', args: [] });
    const match = r.rows.find(a => stripAccents(a.firme || '').toLowerCase().trim() === firmeLower)
      || r.rows.find(a => stripAccents(a.firme || '').toLowerCase().includes(firmeLower))
      || r.rows.find(a => firmeLower.includes(stripAccents(a.firme || '').toLowerCase()) && a.firme);
    return match || null;
  } catch (e) {
    console.error('[architectes] Erreur lookup:', e.message);
    return null;
  }
}

// Compose une valeur texte unique et lisible pour le champ ARCHITECTE, en
// combinant ce que le devis mentionne avec l'enrichissement de la base de
// connaissances quand une firme correspondante y est trouvée.
function composerTexteArchitecte(firmeDevis, contactDevis, matchDb) {
  const parties = [];
  const firme = (matchDb && matchDb.firme) || firmeDevis || '';
  if (firme) parties.push(firme);
  const contact = contactDevis || (matchDb && matchDb.contact) || '';
  if (contact) parties.push(contact);
  if (matchDb) {
    if (matchDb.telephone) parties.push(matchDb.telephone);
    if (matchDb.email) parties.push(matchDb.email);
    if (matchDb.adresse) parties.push(matchDb.adresse);
  }
  return parties.join(' — ');
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

// Résout les FT d'un produit : 1) bucket Supabase fiches-techniques, 2) lien_fiche_technique (web)
async function resoudreFichesTechniques(db, fabricant, titre) {
  const buffers = [];

  const clesLocales = await trouverFichesTechniques(fabricant, titre);
  for (const key of clesLocales) {
    const buf = await downloadBuffer(BUCKETS.FICHES_TECHNIQUES, key);
    if (buf) buffers.push(buf);
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
    const safeKey = selection.split('/').filter(seg => seg && seg !== '..').join('/');
    const buf = safeKey ? await downloadBuffer(BUCKETS.FICHES_TECHNIQUES, safeKey) : null;
    if (buf) {
      console.log('[FT] Sélection manuelle utilisée:', safeKey);
      return [buf];
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
async function listerFTParFabricant() {
  const result = {};
  const dirs = await listerDossiersFT();
  for (const d of dirs) {
    const pdfs = (await listerPdfsDossierFT(d)).sort((a, b) => a.localeCompare(b));
    if (pdfs.length > 0) result[d] = pdfs;
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
  const ftParFab = await listerFTParFabricant();
  for (const f of Object.keys(ftParFab)) fabSet.add(f);

  return {
    fabricants: [...fabSet].filter(Boolean).sort((a, b) => a.localeCompare(b)),
    fournisseurs: [...fourSet].filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };
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

// Cles generees exclusivement par /api/upload-url : jamais de separateur de
// chemin. On rejette tout ce qui y ressemblerait (defense en profondeur, le
// bucket temp etant partage entre tous les utilisateurs de l'outil).
function cleTempValide(key) {
  return typeof key === 'string' && key.length > 0 && !key.includes('/') && !key.includes('..');
}

// ── ANALYSER : upload devis + bordereau + matériaux SÉLECTIONNÉS PAR L'UTILISATEUR → révision ──
router.post('/analyser', async (req, res) => {
  const db = req.db;
  const { nom_entrepreneur, specialite, adresse, nom_projet } = req.body;

  const devisKey = req.body.devis_key, devisName = req.body.devis_name;
  const bordereauKey = req.body.bordereau_key, bordereauName = req.body.bordereau_name;
  if (!cleTempValide(devisKey)) return res.status(400).send('Veuillez importer le devis PDF.');
  if (!cleTempValide(bordereauKey)) return res.status(400).send('Veuillez importer le bordereau .docx.');

  const materiauIds = [].concat(req.body.materiau_id || [])
    .map(id => parseInt(id))
    .filter(id => !isNaN(id));

  if (materiauIds.length === 0) {
    await removeFile(BUCKETS.UPLOADS_TEMP, devisKey).catch(() => {});
    await removeFile(BUCKETS.UPLOADS_TEMP, bordereauKey).catch(() => {});
    return res.status(400).send('Veuillez sélectionner au moins un matériau dans la barre de recherche.');
  }

  let devisTempPath = null;
  let texteDevis = '';
  try {
    devisTempPath = await telechargerVersFichierTemp(BUCKETS.UPLOADS_TEMP, devisKey, devisName);
    if (!devisTempPath) throw new Error('fichier introuvable dans le stockage');
    const parsed = await parseDevis(devisTempPath, devisName);
    texteDevis = parsed.text || '';
  } catch (e) {
    return res.status(400).send('Impossible de lire le devis : ' + e.message);
  } finally {
    if (devisTempPath) { try { fs.unlinkSync(devisTempPath); } catch (_) {} }
    await removeFile(BUCKETS.UPLOADS_TEMP, devisKey).catch(() => {});
  }

  if (!texteDevis.trim()) {
    await removeFile(BUCKETS.UPLOADS_TEMP, bordereauKey).catch(() => {});
    return res.status(400).send('Le devis semble vide ou illisible.');
  }

  let bordereauBuffer = await downloadBuffer(BUCKETS.UPLOADS_TEMP, bordereauKey);
  await removeFile(BUCKETS.UPLOADS_TEMP, bordereauKey).catch(() => {});
  if (!bordereauBuffer) return res.status(400).send('Impossible de lire le bordereau .docx.');

  // Certains gabarits d'architectes sont encore envoyes en .doc (Word 97-2003,
  // format OLE binaire) plutot qu'en .docx (zip OOXML) — bordereau-filler.js ne
  // sait lire que du .docx. On convertit automatiquement via LibreOffice pour
  // que le bordereau soit quand meme rempli, peu importe le format soumis.
  if (estDocLegacy(bordereauBuffer)) {
    try {
      bordereauBuffer = await convertirDocEnDocx(bordereauBuffer);
    } catch (e) {
      return res.status(400).send('Le bordereau est en ancien format .doc (Word 97-2003) et sa conversion automatique en .docx a échoué : ' + e.message + '. Réenregistrez-le en .docx depuis Word puis réessayez.');
    }
  }
  if (!estDocxValide(bordereauBuffer)) {
    return res.status(400).send('Le fichier de bordereau n\'est pas un .docx valide. Réenregistrez-le en .docx depuis Word (Fichier > Enregistrer sous > Word Document .docx) puis réessayez.');
  }

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

  // Champs additionnels que le devis contient parfois mais que le gabarit T3E
  // n'a pas (donc absents des 16 libellés fixes) — utiles pour les gabarits
  // d'architectes tiers qui ont leurs propres sections (ex: "Nom de l'école
  // ou de l'établissement", "ARCHITECTE"). Voir aussi bordereau-filler.js.
  const architecteMatch = await obtenirArchitecteMatch(db, iaResult.ARCHITECTE_FIRME);
  const architecteTexte = composerTexteArchitecte(iaResult.ARCHITECTE_FIRME, iaResult.ARCHITECTE_CONTACT, architecteMatch);

  const identification = {
    NOM: nom_entrepreneur?.trim() || 'Toitures Trois Étoiles',
    SPECIALITE: specialite?.trim() || 'COUVREUR',
    ADRESSE: adresse?.trim() || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
    NOM_ETABLISSEMENT: iaResult.NOM_ETABLISSEMENT || '',
    ARCHITECTE: architecteTexte,
  };

  const produits = [];
  for (let i = 0; i < produitsBase.length; i++) {
    const mat = produitsBase[i];
    const ctx = contexteProduits[i] || {};
    const p = {
      TITRE: mat.nom,
      FABRICANT: mat.fabricant || '',
      FOURNISSEUR: mat.fournisseur || '',
      SECTION: ctx.SECTION || '',
      ARTICLE: ctx.ARTICLE || '',
      DESCRIPTION: mat.nom,
      USAGE: ctx.USAGE || '',
      REMARQUE: '',
      ft_url: mat.lien_fiche_technique || '',
    };
    p.ft_chemins = await trouverFichesTechniques(p.FABRICANT, p.TITRE);
    p.ft_noms = p.ft_chemins.map(c => path.basename(c));
    if (p.ft_noms.length === 0 && p.ft_url) {
      p.ft_noms = [nomFichierDepuisUrl(p.ft_url) + ' (web)'];
    }
    p.ft_selection = p.ft_chemins.length > 0 ? p.ft_chemins[0] : '__AUTO__';
    produits.push(p);
  }

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
        DESCRIPTION: c.TITRE || '',
        USAGE: c.REMARQUE || '',
        REMARQUE: '',
        ft_noms: data.ft_chemins ? data.ft_chemins.map(p => path.basename(p)) : [],
        ft_selection: data.ft_chemins && data.ft_chemins.length > 0 ? data.ft_chemins[0] : '__AUTO__',
      }],
      ia_erreur: data.ia_erreur || '',
    };
  }

  // S'assurer que chaque produit a une selection FT (anciens enregistrements)
  for (const p of (data.produits || [])) {
    if (!p.ft_selection) p.ft_selection = '__AUTO__';
  }

  const { fabricants, fournisseurs } = await listerFabricantsEtFournisseurs(req.db);
  const ftParFabricant = await listerFTParFabricant();

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
  // Champs sans equivalent dans le gabarit T3E, mais presents sur beaucoup de
  // gabarits d'architectes tiers (ex: "Nom de l'ecole ou de l'etablissement",
  // "ARCHITECTE") — extraits du devis a l'etape /analyser, editables ici.
  const nomEtablissement = req.body.NOM_ETABLISSEMENT || '';
  const architecte = req.body.ARCHITECTE || '';

  // Les champs produit arrivent comme tableaux (TITRE[], FABRICANT[], etc.)
  const titres = [].concat(req.body.TITRE || []);
  const fabricants = [].concat(req.body.FABRICANT || []);
  const fournisseurs = [].concat(req.body.FOURNISSEUR || []);
  const sections = [].concat(req.body.SECTION || []);
  const articles = [].concat(req.body.ARTICLE || []);
  const descriptions = [].concat(req.body.DESCRIPTION || []);
  const usages = [].concat(req.body.USAGE || []);
  const ftSelections = [].concat(req.body.FT_FICHIER || []);

  const nbProduits = titres.length;
  console.log('[generer] Génération de', nbProduits, 'bordereaux pour', nomProjet);

  const zip = new JSZip();
  const ts = Date.now();
  const diagnostic = [];

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
      USAGE: usages[i] || '',
      REMARQUE: '',
      NOM_ETABLISSEMENT: nomEtablissement,
      ARCHITECTE: architecte,
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

    // Étape 1 — Remplir le .docx
    let docxBuf = null;
    try {
      docxBuf = await remplirBordereau(champs, bordereauBuffer);
    } catch (e) {
      console.error(`[generer] ${num} Erreur remplissage:`, e.message);
    }

    // Étape 2 — Charger les FT
    let ftBuffers = [];
    try {
      ftBuffers = await resoudreFichesTechniquesAvecSelection(db, champs.FABRICANT, champs.TITRE, ftSelections[i]);
      if (ftBuffers.length === 0) console.log(`[generer] ${num} Aucune FT pour`, champs.TITRE, '/', champs.FABRICANT);
    } catch (e) {
      console.error(`[generer] ${num} Erreur FT:`, e.message);
    }

    // Étape 3 — Convertir le .docx en PDF via LibreOffice
    let bordereauPdfBuf = null;
    if (docxBuf) {
      try {
        bordereauPdfBuf = await convertirDocxEnPdf(docxBuf);
        console.log(`[generer] ${num} LibreOffice OK: ${titres[i]}`);
      } catch (e) {
        console.error(`[generer] ${num} LibreOffice KO:`, e.message);
        diagnostic.push(`${num} (${titres[i] || ''}) — conversion PDF échouée : ${e.message}`);
      }
    }

    // Étape 4 — Construire le ZIP
    if (bordereauPdfBuf) {
      // LibreOffice a marché : bordereau PDF + FT fusionnés en un seul PDF
      const merged = await PDFDocument.create();
      for (const buf of [bordereauPdfBuf, ...ftBuffers]) {
        try {
          const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
          (await merged.copyPages(doc, doc.getPageIndices())).forEach(pg => merged.addPage(pg));
        } catch (_) {}
      }
      if (merged.getPageCount() > 0) {
        zip.file(`${num}_${nomFichier}.pdf`, Buffer.from(await merged.save()));
        console.log(`[generer] ${num} PDF OK (bordereau + ${ftBuffers.length} FT): ${titres[i]}`);
      }
    } else if (docxBuf) {
      // LibreOffice KO : .docx bordereau + FT PDF séparés (toujours utilisable)
      zip.file(`${num}_${nomFichier}/Bordereau_${nomFichier}.docx`, docxBuf);
      if (ftBuffers.length > 0) {
        const merged = await PDFDocument.create();
        for (const buf of ftBuffers) {
          try {
            const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
            (await merged.copyPages(doc, doc.getPageIndices())).forEach(pg => merged.addPage(pg));
          } catch (_) {}
        }
        if (merged.getPageCount() > 0)
          zip.file(`${num}_${nomFichier}/FT_${nomFichier}.pdf`, Buffer.from(await merged.save()));
      }
      console.log(`[generer] ${num} Fallback .docx + FT: ${titres[i]}`);
    }
  }

  // Fichier temporaire de diagnostic (à retirer une fois la conversion PDF
  // distante confirmée stable) — permet de voir la cause exacte sans logs.
  if (diagnostic.length > 0) {
    zip.file('_DIAGNOSTIC.txt', diagnostic.join('\n'));
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
