const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { parseDevis, parsePdfBuffer } = require('../services/document-parser');
const { remplirBordereau } = require('../services/bordereau-filler');
const { convertirDocxEnPdf } = require('../services/docx-to-pdf');
const { convertirDocEnDocx, estDocLegacy, estDocxValide } = require('../services/doc-to-docx');
const { PDFDocument } = require('pdf-lib');
const JSZip = require('jszip');
const { downloadBuffer, uploadBuffer, removeFile, listFiles, stripAccents, sanitizeKey, ensureBucket, createSignedUrl, BUCKETS } = require('../services/storage');
const { listerRepresentants, obtenirRepresentant } = require('../services/representants');
const { INFOS_ENTREPRISE_T3E } = require('../services/infos-entreprise-t3e');

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
On te fournit un INDEX COMPACT du devis : pour chaque section réelle de CE devis, son numéro et la liste des TITRES d'articles de sa PARTIE 2 - PRODUITS (ex: "2.8 Couche de finition") — PAS le texte intégral des paragraphes (trop volumineux). Base-toi UNIQUEMENT sur ces titres pour choisir, pas sur ta mémoire générale de devis types.
Pour CHAQUE produit de la liste, dans l'ORDRE donné :
1. Trouve la SECTION (numéro 6 chiffres, ex: "07 52 00") dont le contenu correspond à la catégorie du produit. Le numéro VARIE d'un devis à l'autre (un projet peut utiliser "07 52 21", un autre "07 52 00" pour un contenu similaire) — ne réutilise JAMAIS un numéro "typique" que tu connais par ailleurs sans l'avoir vu explicitement dans l'index fourni.
2. Trouve l'ARTICLE dont le TITRE correspond le mieux à la fonction du produit (ex: un membrane de finition granulée → l'article dont le titre est "Couche de finition" ou équivalent). Les devis QUÉBÉCOIS NOMMENT RAREMENT LES MARQUES dans les titres d'article : ne t'attends PAS à voir "Soprastar" ou toute autre marque — c'est le TITRE FONCTIONNEL de l'article qui doit correspondre à la catégorie du produit (membrane de finition, pare-vapeur, isolant, adhésif, apprêt, sous-couche, drain, évent, etc.). C'est NORMAL et ATTENDU de devoir déduire à partir du titre plutôt que du nom exact. Choisis PARMI les articles listés dans l'index pour la section identifiée à l'étape 1 — n'invente jamais un numéro absent de l'index.
3. SECTION et ARTICLE sont OBLIGATOIRES pour chaque produit : chaque bordereau soumis DOIT référencer le devis. Choisis TOUJOURS la section et l'article de l'index qui correspondent le MIEUX au produit, même si la correspondance n'est qu'approximative (catégorie voisine, article générique de la même section). Ne retourne JAMAIS vide simplement parce que la marque n'est pas nommée mot pour mot — c'est la situation normale, pas une raison de renoncer (voir point 2). La chaîne vide n'est permise QUE dans le cas extrême où l'index ne contient AUCUNE section applicable de près ou de loin (ex: index totalement vide).
4. Compose un USAGE très court (une seule phrase courte, 3 à 10 mots, PAS un paragraphe) décrivant simplement ce qu'est le produit, du style "Une membrane de sous-couche", "Un panneau isolant thermique de polyisocyanurate", "Une bande de recouvrement"

Aussi, extrais du devis :
- NOM_DU_PROJET : page de garde, en-tête, "Projet :", "Objet :"
- NUMERO_DU_PROJET : "N° projet", "Dossier", "N/Réf", "Projet no"
- NOM_ETABLISSEMENT : le nom du propriétaire/établissement/école/bâtiment (ex: "Polytechnique Montréal", "École Laval Senior Academy") — PAS le nom du projet lui-même, mais l'entité propriétaire. Vide si absent du devis.
- ARCHITECTE_FIRME : le nom de la firme d'architectes qui a préparé le devis (souvent en page de garde ou page des sceaux/signatures). Vide si absent.
- ARCHITECTE_CONTACT : le nom de la personne (architecte associé/responsable) si mentionné, sinon vide.
- ENTREPRENEUR_GENERAL : nom (+ adresse et téléphone si mentionnés) de l'entrepreneur GÉNÉRAL du chantier, sous la forme "Nom — Adresse — Téléphone" (compose ce que tu trouves). Souvent absent des devis d'architecte — vide si absent. NE JAMAIS y mettre T3E/Toitures Trois Étoiles (T3E est le sous-traitant couvreur, pas l'entrepreneur général).
- INGENIEUR : nom de la firme d'ingénierie (+ coordonnées si mentionnées) si le devis en mentionne une, sinon vide.

Beaucoup de bordereaux d'architectes tiers (différents du gabarit T3E) ont des champs comme "Nom de l'école ou de l'établissement" ou "ARCHITECTE" qui n'existent pas dans le gabarit T3E — ces informations, quand elles sont dans le devis, DOIVENT être extraites même si tu ne sais pas encore où elles seront utilisées.

=== RÈGLES ===
- Retourne EXACTEMENT un produit en sortie par produit en entrée, DANS LE MÊME ORDRE
- Ne change JAMAIS le nom/fabricant/fournisseur du produit, ils sont déjà corrects
- Retourne UNIQUEMENT du JSON valide`;

// Les devis font souvent 100+ pages, et le compte OpenAI de T3E a une limite
// stricte de 30 000 tokens/minute (~115 000 caractères) — envoyer le texte
// intégral des sections (même limité par section) dépasse systématiquement
// cette limite sur les gros devis (ex: 220 000 caractères ≈ 58 000 tokens,
// refusé par l'API en erreur 429, ce qui viDAIT TOUS les champs, pas
// seulement SECTION/ARTICLE).
// Solution : au lieu du texte complet, on construit un INDEX COMPACT —
// juste les numéros + titres d'article de PARTIE 2 (PRODUITS), sans les
// paragraphes descriptifs. Pour un devis de 551 pages, cet index tient en
// ~6 000 caractères (au lieu de 220 000+) tout en donnant à l'IA une vue
// fidèle et complète des VRAIS numéros de section/article de CE devis.
function extraireContextePertinent(texteDevis) {
  const morceaux = [];

  // Page de garde / sceaux et signatures : c'est là que se trouvent le nom du
  // projet, son numéro, le propriétaire/établissement et la firme d'architectes.
  morceaux.push('=== DÉBUT DU DEVIS (page de garde, sceaux) ===\n' + texteDevis.substring(0, 3000));

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
    const avantTitre = texteDevis.substring(Math.max(0, m.index - 90), m.index)
      .replace(/\s+/g, ' ').replace(/FIN DE LA SECTION/gi, '').trim();
    positions.push({ numero, index: m.index, titre: avantTitre.slice(-60) });
  }

  if (positions.length === 0) {
    // Format de devis non standard (marqueurs "Page 1 de" introuvables) : pas
    // de sections détectées, on retombe sur un extrait brut limité (mieux que
    // rien, mais moins fiable que l'index par section).
    morceaux.push(texteDevis.substring(3000, 20000));
    return morceaux.join('\n\n---\n\n');
  }

  positions.sort((a, b) => a.index - b.index);
  const numeroLisible = (n) => n.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3');

  morceaux.push('=== INDEX DES SECTIONS ET ARTICLES (PARTIE 2 - PRODUITS) DE CE DEVIS ===\n' +
    '(Titres uniquement, pas le texte complet — les numéros et titres ci-dessous sont les VRAIS numéros de CE devis)');

  for (let i = 0; i < positions.length; i++) {
    const debut = positions[i].index;
    const fin = i + 1 < positions.length ? positions[i + 1].index : texteDevis.length;
    const bloc = texteDevis.substring(debut, fin);

    // PARTIE 2 = PRODUITS/MATÉRIAUX dans la quasi-totalité des devis
    // québécois (convention AMCQ/CSTC) — c'est la seule partie utile pour
    // faire correspondre un produit à un numéro d'article.
    const articles = [];
    const vusArt = new Set();

    // Convention A (gabarit T3E et certains devis AMCQ) : articles numérotés
    // directement "2.1", "2.2"... (le "2" indique déjà la PARTIE 2).
    const articleRegexA = /\n\s*(2\.\d{1,2})\s+([A-ZÉÈÀÇ][^\n.]{2,50})/g;
    let am;
    while ((am = articleRegexA.exec(bloc))) {
      if (vusArt.has(am[1])) continue;
      vusArt.add(am[1]);
      articles.push(`${am[1]} ${am[2].trim()}`);
    }

    // Convention B (devis d'architectes type CIMAISE, observée en 2026-07) :
    // "PARTIE 2 PRODUITS" est un en-tête séparé, et les articles repartent à
    // "1.", "2.", "3."... (pas de préfixe "2."). Restreindre la recherche au
    // texte ENTRE "PARTIE 2 ... PRODUITS" et "PARTIE 3" pour ne pas capturer
    // les articles de la PARTIE 1 ou 3 (numérotés pareil). Les VRAIS titres
    // d'article de premier niveau sont en MAJUSCULES (ex: "ISOLANT RIGIDE |
    // MURS EXTÉRIEURS...") — les sous-points imbriqués sous un article
    // (texte descriptif, ex: "Pour l'ensemble des panneaux...") contiennent
    // des minuscules et sont exclus par ce filtre.
    const partieMatch = /PARTIE\s*2\b[\s\S]{0,30}?PRODUITS/i.exec(bloc);
    if (partieMatch) {
      const debutPartie2 = partieMatch.index + partieMatch[0].length;
      const finPartie2Match = /PARTIE\s*3\b/i.exec(bloc.substring(debutPartie2));
      const finPartie2 = finPartie2Match ? debutPartie2 + finPartie2Match.index : bloc.length;
      const blocPartie2 = bloc.substring(debutPartie2, finPartie2);
      const articleRegexB = /\n\s*(\d{1,2})\.\s+([^\n]{2,80})/g;
      let bm;
      while ((bm = articleRegexB.exec(blocPartie2))) {
        const titre = bm[2].trim();
        if (/[a-zàâäéèêëîïôùûüÿœæç]/.test(titre)) continue;
        if (vusArt.has(bm[1])) continue;
        vusArt.add(bm[1]);
        articles.push(`${bm[1]} ${titre}`);
      }
    }

    if (articles.length === 0) continue; // section sans PARTIE 2 identifiable (ex: administrative)

    morceaux.push(`SECTION ${numeroLisible(positions[i].numero)} (${positions[i].titre}) : ${articles.join(' | ')}`);
  }

  return morceaux.join('\n');
}

// ── Filet de sécurité SECTION/ARTICLE ───────────────────────────────────────
// Un bordereau doit TOUJOURS référencer le devis (demande utilisateur) : si
// l'IA a laissé SECTION ou ARTICLE vide pour un produit, on choisit
// nous-mêmes, dans l'index compact du devis (même source que l'IA), la
// section et l'article dont le TITRE partage le plus de mots avec le nom du
// produit — à défaut, la première section/le premier article de l'index.
// Résultat garanti : jamais vide dès que le devis contient au moins une
// section indexée.
function parserIndexSections(indexTexte) {
  const sections = [];
  const ligneRegex = /^SECTION (\d{2} \d{2} \d{2}) \((.*?)\) : (.*)$/gm;
  let m;
  while ((m = ligneRegex.exec(indexTexte))) {
    const articles = m[3].split(' | ').map((a) => {
      const am = a.trim().match(/^(\S+)\s+(.*)$/);
      return am ? { numero: am[1], titre: am[2] } : { numero: a.trim(), titre: '' };
    }).filter((a) => a.numero);
    if (articles.length > 0) sections.push({ numero: m[1], titre: m[2], articles });
  }
  return sections;
}

function motsCles(texte) {
  return String(texte || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

function completerSectionArticle(indexTexte, produitsBase, contexteProduits) {
  const sections = parserIndexSections(indexTexte);
  if (sections.length === 0) return; // devis sans index exploitable — rien à garantir

  for (let i = 0; i < produitsBase.length; i++) {
    const ctx = contexteProduits[i] = contexteProduits[i] || {};

    // La SECTION renvoyée par l'IA n'est fiable QUE si elle correspond à une
    // VRAIE section de l'index de CE devis — l'IA hallucine parfois un
    // numéro "typique" du MasterFormat qu'elle connaît par ailleurs (ex:
    // "07 53 00", numéro générique pour "membrane élastomère") au lieu du
    // numéro réellement utilisé dans ce devis précis (ex: "07 52 16").
    const sectionReelle = ctx.SECTION
      ? sections.find((s) => s.numero.replace(/\s/g, '') === String(ctx.SECTION).replace(/\s/g, ''))
      : null;

    // L'ARTICLE n'est fiable que s'il contient un numéro qui existe VRAIMENT
    // dans la section identifiée — sinon c'est un titre générique hallucine
    // (ex: "Couche de finition" sans aucun chiffre, qui finirait sinon écrit
    // tel quel dans le bordereau au lieu d'un numéro).
    const articleNumBrut = (String(ctx.ARTICLE || '').match(/\d+(?:\.\d+)*/) || [''])[0];
    const articleFiable = !!(sectionReelle && articleNumBrut &&
      sectionReelle.articles.some((a) => a.numero.replace(/\s/g, '') === articleNumBrut));

    if (sectionReelle && articleFiable) continue; // SECTION et ARTICLE confirmés réels, rien à faire

    const motsProduit = motsCles(`${produitsBase[i]?.nom || ''} ${ctx.USAGE || ''}`);
    const score = (titre) => {
      const mots = new Set(motsCles(titre));
      return motsProduit.reduce((n, w) => n + (mots.has(w) ? 1 : 0), 0);
    };

    // Si l'IA a donné une SECTION réelle (même sans article fiable dans
    // cette section), on reste dans SA section plutôt que de rechercher
    // dans tout le devis.
    const candidates = sectionReelle ? [sectionReelle] : sections;

    let meilleur = { section: candidates[0], article: candidates[0].articles[0], points: -1 };
    for (const s of candidates) {
      for (const a of s.articles) {
        const points = score(a.titre) * 2 + score(s.titre);
        if (points > meilleur.points) meilleur = { section: s, article: a, points };
      }
    }

    // On écrase (pas seulement complète) : un SECTION/ARTICLE non confirmé
    // réel dans l'index ne doit jamais rester tel quel dans le bordereau.
    ctx.SECTION = meilleur.section.numero;
    ctx.ARTICLE = meilleur.article.numero;
    console.log(`[analyser] SECTION/ARTICLE ${sectionReelle && articleFiable ? 'confirmés' : 'complétés/corrigés'} par correspondance de mots pour "${produitsBase[i]?.nom}" → ${ctx.SECTION} / ${ctx.ARTICLE}`);
  }
}

// Schéma strict (Structured Outputs OpenAI) : sans lui, response_format
// "json_object" laisse le modèle libre d'omettre des clés ou de mal
// structurer un produit dans le tableau — observé en production : USAGE
// rempli mais SECTION/ARTICLE absents pour certains produits, sans erreur
// HTTP. Le mode "strict: true" garantit que CHAQUE produit retourné possède
// les 3 clés (même vides), donc jamais silencieusement absentes.
const SCHEMA_CONTEXTE = {
  type: 'object',
  properties: {
    NOM_DU_PROJET: { type: 'string' },
    NUMERO_DU_PROJET: { type: 'string' },
    NOM_ETABLISSEMENT: { type: 'string' },
    ARCHITECTE_FIRME: { type: 'string' },
    ARCHITECTE_CONTACT: { type: 'string' },
    ENTREPRENEUR_GENERAL: { type: 'string' },
    INGENIEUR: { type: 'string' },
    produits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          SECTION: { type: 'string' },
          ARTICLE: { type: 'string' },
          USAGE: { type: 'string' },
        },
        required: ['SECTION', 'ARTICLE', 'USAGE'],
        additionalProperties: false,
      },
    },
  },
  required: ['NOM_DU_PROJET', 'NUMERO_DU_PROJET', 'NOM_ETABLISSEMENT', 'ARCHITECTE_FIRME', 'ARCHITECTE_CONTACT', 'ENTREPRENEUR_GENERAL', 'INGENIEUR', 'produits'],
  additionalProperties: false,
};

async function appelIAContexte(texteDevis, produitsSelectionnes) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY manquante. Ajoutez-la sur Render.');

  const listeProduits = produitsSelectionnes.map((p, i) =>
    `${i + 1}. ${p.nom} (Fabricant: ${p.fabricant || 'inconnu'}, Fournisseur: ${p.fournisseur || 'inconnu'})`
  ).join('\n');

  const userContent = `INDEX DU DEVIS (page de garde + numéros/titres d'articles réels de ce devis — PAS le texte intégral) :
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
  "ENTREPRENEUR_GENERAL": "entrepreneur général du chantier (du DEVIS), ou chaîne vide si absent",
  "INGENIEUR": "firme d'ingénierie (du DEVIS), ou chaîne vide si absent",
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
      // L'index compact remplace le texte intégral (voir extraireContextePertinent) :
      // la sortie JSON reste petite (quelques champs courts par produit), 2000
      // tokens est largement suffisant même pour une longue liste de produits.
      // Réduit aussi la consommation du quota strict de 30 000 tokens/minute
      // du compte OpenAI de T3E (limite Tier 1) — les tokens de complétion y
      // comptent aussi.
      max_tokens: 2000,
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'contexte_bordereau', schema: SCHEMA_CONTEXTE, strict: true },
      },
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
//  TITRE/DESCRIPTION depuis le CONTENU réel d'une fiche technique — pour
//  les produits "FT seule" (pas encore catalogués comme matériau), dont le
//  nom ne doit PAS venir du nom de fichier (qui contient souvent des codes
//  internes du fabricant : XXX, FR/EN, TDS/PUB/PDS, numéros de référence)
//  mais du produit tel qu'affiché sur sa propre fiche.
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT_FT = `Tu extrais deux informations depuis le texte d'une fiche technique (FT) de produit de construction/toiture.

TITRE : le nom du produit tel qu'affiché sur la fiche (ex: "Torchflex TP-HD-Cap", "Cambridge", "Mystique", "S.A.M. Adhesive"). RÈGLES :
- N'inclus JAMAIS le nom du fabricant (IKO, BP, Soprema, Canleaf, etc.) — celui-ci est déjà connu séparément.
- N'inclus JAMAIS de codes internes : "XXX" (code couleur), "FR"/"EN" (langue), "TDS"/"PUB"/"PDS" (type de document), numéros de référence isolés qui ne font pas partie du nom commercial.
- Le nom commercial peut lui-même contenir un modèle qui en fait partie (ex: "Mystique 42 po (RL621)" → garde seulement "Mystique", le format/numéro de référence n'est pas le nom commercial) — utilise ton jugement pour ne garder que le nom réellement distinctif du produit.

DESCRIPTION : UNE SEULE phrase courte tirée ou déduite du texte de la fiche qui décrit ce qu'est le produit (ex: "Membrane de finition thermosoudée", "Sous-couche de toiture autocollante résistante aux hautes températures", "Bardeau d'asphalte laminé"). Ne recopie PAS une liste de caractéristiques, un slogan marketing, ni le nom du fabricant.

Réponds UNIQUEMENT en JSON valide : {"TITRE": "...", "DESCRIPTION": "..."}
Si le texte ne permet vraiment pas de déterminer un champ, retourne une chaîne vide pour ce champ.`;

async function extraireTitreDescriptionFT(bufferFT) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_API_KEY || !bufferFT) return null;

  let texte = '';
  try {
    const parsed = await parsePdfBuffer(bufferFT);
    texte = (parsed.text || '').trim();
  } catch (e) {
    console.warn('[FT-extraction] Lecture PDF échouée:', e.message);
    return null;
  }
  if (!texte) return null;

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'titre_description_ft',
            schema: {
              type: 'object',
              properties: { TITRE: { type: 'string' }, DESCRIPTION: { type: 'string' } },
              required: ['TITRE', 'DESCRIPTION'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_FT },
          { role: 'user', content: texte.substring(0, 6000) },
        ],
      }),
    });
    if (!resp.ok) {
      console.warn('[FT-extraction] OpenAI', resp.status, (await resp.text()).substring(0, 200));
      return null;
    }
    const data = await resp.json();
    const out = JSON.parse(data.choices[0].message.content);
    return {
      TITRE: (out.TITRE || '').trim(),
      DESCRIPTION: (out.DESCRIPTION || '').trim(),
    };
  } catch (e) {
    console.warn('[FT-extraction] Appel IA échoué:', e.message);
    return null;
  }
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

// Cache par dossier (5 min, meme principe que _ftFoldersCache) — sans ca,
// rechercherProduitsEtFT() relistait TOUS les dossiers fabricants (21 appels
// Supabase sequentiels) a CHAQUE frappe dans la barre de recherche, assez
// lent pour depasser le delai d'une fonction serverless (504 observe en
// production).
const _ftPdfsCache = new Map(); // dossier -> { pdfs, at }
async function listerPdfsDossierFT(dossier) {
  const now = Date.now();
  const cached = _ftPdfsCache.get(dossier);
  if (cached && now - cached.at < 5 * 60 * 1000) return cached.pdfs;
  let entries = [];
  try { entries = await listFiles(BUCKETS.FICHES_TECHNIQUES, dossier); } catch (_) { return []; }
  const pdfs = entries.filter(e => e.id !== null && e.name.toLowerCase().endsWith('.pdf')).map(e => e.name);
  _ftPdfsCache.set(dossier, { pdfs, at: now });
  return pdfs;
}

// Mots-clés fixes de tout nom de fichier FT (préfixe fabricant/langue/type de
// document, communs à TOUS les PDF d'un même dossier) — à exclure du scoring
// par mots-clés. Sans ça, un mot-clé COURT extrait du titre (ex. "sopra", issu
// de "Sopra-Iso") est une SOUS-CHAÎNE d'un mot plus long présent dans un AUTRE
// nom de fichier (ex. "soprasmart") : avec un matching par `includes()`, les
// deux fichiers matchaient également et le mauvais gagnait selon l'ordre de
// listage du bucket — constaté en production (dossier Ville de Laval 17525 :
// "Sopra-Iso" → "Soprasmart ISO HD" retourné à la place).
const MOTS_VIDES_NOM_FICHIER_FT = new Set([
  'sopca', 'tds', 'pub', 'ca', 'fr', 'en', 'the', 'des', 'les', 'pour', 'avec', 'type',
]);

// Certains PDF fabricant emploient un mot ANGLAIS dans un nom de fichier par
// ailleurs français (ex. Soprema : "...-hd-sanded.pdf" pour la variante
// "Sablé", jamais "-sable"/"-sablee") — sans cette équivalence, le mot-clé
// "sable" (extrait du titre français) ne correspond jamais au fichier et le
// matching retombe sur la variante standard — constaté en production
// (dossier Ville de Laval 17525 : "Soprasmart ISO HD Sablé" → variante
// standard/thermofusible retournée à la place).
const SYNONYMES_MOTS_CLES_FT = {
  sable: ['sanded'], sablee: ['sanded'], sablees: ['sanded'],
};

function tokeniserNomFichierFT(nomFichier) {
  return stripAccents(nomFichier)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !MOTS_VIDES_NOM_FICHIER_FT.has(t));
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

  const keywords = stripAccents(titre).toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'des', 'les', 'pour', 'avec', 'type'].includes(w));

  const scored = pdfs.map(f => {
    const tokensFichier = new Set(tokeniserNomFichierFT(f));
    // Mot exact (pas sous-chaîne) : "sopra" ne matche plus "soprasmart".
    const matches = keywords.filter(k => tokensFichier.has(k)
      || (SYNONYMES_MOTS_CLES_FT[k] || []).some(s => tokensFichier.has(s))).length;
    // À nombre de correspondances égal, préfère le nom de fichier le plus
    // proche du titre cherché (moins de mots additionnels non demandés) —
    // évite qu'une variante ("...-plus", "...-tapered") gagne à tort face au
    // produit de base.
    const ratio = tokensFichier.size > 0 ? matches / tokensFichier.size : 0;
    // Site destiné à un usage exclusivement francophone (voir CLAUDE.md) :
    // entre deux fiches par ailleurs équivalentes, toujours préférer la
    // version FR à la EN (bonus minime, ne sert qu'à départager une égalité).
    const versionFrancaise = /(^|[^a-z])fr([^a-z]|$)/.test(f.toLowerCase());
    const score = matches + ratio + (versionFrancaise ? 0.01 : 0);
    return { file: f, matches, score };
  }).sort((a, b) => b.score - a.score);

  const meilleur = scored[0];
  if (meilleur && meilleur.matches > 0) {
    console.log('[FT] Match par titre:', meilleur.file, '(matches:', meilleur.matches + ', score:', meilleur.score.toFixed(3) + ')');
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

// Traçabilité #4 : le produit est-il effectivement mentionné dans le devis
// fourni, ou a-t-il ete ajoute a la selection sans base textuelle dans ce
// devis precis (ex: piece standard toujours utilisee, ajoutee de memoire) ?
// Verification simple par mots-cles significatifs, pas un nouvel appel IA.
function produitDetecteDansDevis(texteDevis, titre) {
  const mots = motsSignificatifs(titre);
  if (mots.length === 0) return false;
  const texteNorm = normaliserTexte(texteDevis);
  const trouves = mots.filter(w => texteNorm.includes(w)).length;
  return trouves >= Math.min(2, mots.length);
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
  // Fiche importee specifiquement pour ce projet (priorité #4, "Confirmé
  // projet") -- stockee dans un bucket dedie, jamais mele a la bibliotheque
  // partagee "fiches-techniques".
  if (selection && selection.startsWith('__PROJET__:')) {
    const cle = selection.slice('__PROJET__:'.length);
    const safeKey = cle.split('/').filter(seg => seg && seg !== '..').join('/');
    const buf = safeKey ? await downloadBuffer(BUCKETS.BORDEREAUX_FT_PROJET, safeKey) : null;
    if (buf) {
      console.log('[FT] Fiche importée pour ce projet utilisée:', safeKey);
      return [buf];
    }
    console.log('[FT] Fiche importée pour ce projet introuvable:', cle, '- fallback auto');
  } else if (selection && selection !== '__AUTO__') {
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
//  RECHERCHE PRODUITS (barre de recherche de /bordereaux/nouveau) — combine
//  les matériaux catalogués (source fiable) ET les fiches techniques
//  présentes dans le bucket "fiches-techniques" mais jamais ajoutées comme
//  matériau. Sans ça, un produit dont seule la FT existe (ex : gammes de
//  bardeaux résidentiels IKO comme "Dynasty"/"Cambridge"/"Stormtite", non
//  couvertes par les 23 matériaux IKO déjà catalogués — ceux-ci ne couvrant
//  que les membranes commerciales) reste introuvable dans la recherche, alors
//  que sa fiche technique existe bel et bien. Les entrées "FT seule" sont
//  clairement identifiées (source: 'ft') et n'ont pas d'id numérique réel.
function nomLisibleDepuisFichierFT(fichier) {
  return (fichier || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\d+[.\-_]?\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function rechercherProduitsEtFT(db, q) {
  const like = `%${q}%`;
  const matRes = await db.execute({
    sql: `SELECT id, nom, fabricant, fournisseur, lien_fiche_technique FROM materiaux
          WHERE nom LIKE ? OR fabricant LIKE ? ORDER BY fabricant, nom LIMIT 40`,
    args: [like, like],
  });
  const materiauxTrouves = matRes.rows.map(r => ({ ...r, source: 'materiau' }));

  const motsQuery = motsSignificatifs(q);
  if (motsQuery.length === 0) return materiauxTrouves;

  const tousMateriaux = await chargerTousMateriaux(db);
  const dirs = await listerDossiersFT();
  // Liste TOUS les dossiers EN PARALLELE (au lieu d'un for..await sequentiel)
  // — le premier appel non cache par dossier (voir listerPdfsDossierFT)
  // dominait sinon le temps de reponse, jusqu'a depasser le delai serverless.
  const pdfsParDossier = await Promise.all(dirs.map(d => listerPdfsDossierFT(d)));
  const ftVirtuelles = [];

  for (let i = 0; i < dirs.length; i++) {
    const dossier = dirs[i];
    const dossierNorm = normaliserTexte(dossier);
    const pdfs = pdfsParDossier[i];
    for (const fichier of pdfs) {
      const fichierNorm = normaliserTexte(fichier);
      const correspond = motsQuery.every(w => fichierNorm.includes(w) || dossierNorm.includes(w));
      if (!correspond) continue;

      const nomPropose = nomLisibleDepuisFichierFT(fichier);
      const matsDuFabricant = tousMateriaux.filter(m => normaliserTexte(m.fabricant) === dossierNorm);
      if (matcherMateriau(matsDuFabricant, nomPropose, dossier)) continue; // deja catalogue comme materiau

      ftVirtuelles.push({
        id: 'ft:' + dossier + '/' + fichier,
        nom: nomPropose,
        fabricant: dossier,
        fournisseur: '',
        lien_fiche_technique: null,
        source: 'ft',
      });
    }
  }

  return materiauxTrouves.concat(ftVirtuelles).slice(0, 40);
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/api/rechercher-produits', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    res.json(await rechercherProduitsEtFT(req.db, q));
  } catch (e) {
    console.error('[rechercher-produits] Erreur:', e.message);
    res.json([]);
  }
});

router.get('/', async (req, res) => {
  const r = await req.db.execute(
    "SELECT id, titre, numero_projet, cree_par, statut, approuve_par, created_at FROM bordereaux WHERE (session_actif = 0 OR session_actif IS NULL) ORDER BY created_at DESC"
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

  // materiau_id contient soit un vrai id numerique (table materiaux), soit
  // une entree virtuelle "ft:{fabricant}/{fichier}" choisie depuis une fiche
  // technique presente dans le stockage mais jamais cataloguee comme materiau
  // (voir rechercherProduitsEtFT / GET /api/rechercher-produits) — les deux
  // sont fusionnes plus bas EN CONSERVANT L'ORDRE DE SELECTION.
  const materiauIdsBrut = [].concat(req.body.materiau_id || []);
  const materiauIds = materiauIdsBrut.map(id => parseInt(id)).filter(id => !isNaN(id));
  const ftVirtuellesBrut = materiauIdsBrut.filter(id => typeof id === 'string' && id.startsWith('ft:'));

  if (materiauIds.length === 0 && ftVirtuellesBrut.length === 0) {
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
  let matRows = [];
  if (materiauIds.length > 0) {
    const placeholders = materiauIds.map(() => '?').join(',');
    matRows = (await db.execute({
      sql: `SELECT id, nom, fabricant, fournisseur, lien_fiche_technique FROM materiaux WHERE id IN (${placeholders})`,
      args: materiauIds,
    })).rows;
  }

  // Entrees "fiche technique seule" (pas encore un materiau catalogue) : on
  // connait deja le chemin exact du fichier, donc pas besoin de re-matcher
  // par mots-cles plus bas (voir _ftCheminConnu).
  const ftVirtuelles = ftVirtuellesBrut.map((idBrut) => {
    const chemin = idBrut.slice('ft:'.length); // "{fabricant}/{fichier}"
    const sepIdx = chemin.indexOf('/');
    const fabricant = sepIdx === -1 ? chemin : chemin.slice(0, sepIdx);
    const fichier = sepIdx === -1 ? '' : chemin.slice(sepIdx + 1);
    return {
      id: idBrut,
      nom: nomLisibleDepuisFichierFT(fichier),
      fabricant,
      fournisseur: '',
      lien_fiche_technique: null,
      _ftCheminConnu: chemin,
    };
  });

  // Conserver l'ordre de sélection de l'utilisateur (numeriques + virtuelles confondus)
  const produitsBase = materiauIdsBrut
    .map(idBrut => matRows.find(m => m.id === parseInt(idBrut)) || ftVirtuelles.find(v => v.id === idBrut))
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

  if (iaErreur) {
    console.error('[analyser] Appel IA contexte échoué:', iaErreur);
  } else if (contexteProduits.length !== produitsBase.length) {
    console.warn(`[analyser] Décalage IA: ${contexteProduits.length} contexte(s) reçu(s) pour ${produitsBase.length} produit(s) — les produits en trop n'auront pas de SECTION/ARTICLE.`);
  }
  contexteProduits.forEach((c, i) => {
    if (!c.SECTION && !c.ARTICLE) {
      console.warn(`[analyser] SECTION/ARTICLE vides pour "${produitsBase[i]?.nom}" — l'IA n'a trouvé aucune correspondance dans l'index du devis.`);
    }
  });

  // Garantie : SECTION/ARTICLE toujours remplis depuis le devis quand son
  // index contient au moins une section — couvre les vides laissés par l'IA
  // ET les produits au-delà du décalage (contexteProduits plus court).
  try {
    completerSectionArticle(extraireContextePertinent(texteDevis), produitsBase, contexteProduits);
  } catch (e) {
    console.error('[analyser] Filet SECTION/ARTICLE échoué:', e.message);
  }

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
    ENTREPRENEUR_GENERAL: iaResult.ENTREPRENEUR_GENERAL || '',
    INGENIEUR: iaResult.INGENIEUR || '',
  };

  const produits = [];
  for (let i = 0; i < produitsBase.length; i++) {
    const mat = produitsBase[i];
    const ctx = contexteProduits[i] || {};

    // Le TITRE catalogué (matériau) ou dérivé du nom de fichier (FT seule)
    // n'est pas fiable comme DESCRIPTION courte, et peut lui-même être
    // incomplet/bourré de codes internes (XXX/FR/TDS) — on lit le contenu
    // RÉEL de la fiche technique et on en tire le TITRE et la DESCRIPTION
    // tels qu'affichés sur la fiche. S'applique à TOUS les produits (pas
    // seulement les FT seules) : le nom catalogué en base peut lui aussi
    // être incomplet (ex: "Armourbond Flash" au lieu de "Armourbond Flash
    // Sand HD"), et il n'a de toute façon jamais de description utilisable.
    // Repli sur le nom d'origine si l'extraction échoue, si aucune FT n'est
    // trouvée, ou si OPENAI_API_KEY est absente (voir extraireTitreDescriptionFT).
    let titre = mat.nom;
    let description = mat.nom;
    try {
      const buffersFT = mat._ftCheminConnu
        ? [await downloadBuffer(BUCKETS.FICHES_TECHNIQUES, mat._ftCheminConnu)].filter(Boolean)
        : await resoudreFichesTechniques(db, mat.fabricant, mat.nom);
      if (buffersFT.length > 0) {
        const extrait = await extraireTitreDescriptionFT(buffersFT[0]);
        if (extrait?.TITRE) titre = extrait.TITRE;
        if (extrait?.DESCRIPTION) description = extrait.DESCRIPTION;
      }
    } catch (e) {
      console.warn('[analyser] Extraction TITRE/DESCRIPTION FT échouée pour', mat.nom, ':', e.message);
    }

    const p = {
      TITRE: titre,
      FABRICANT: mat.fabricant || '',
      FOURNISSEUR: mat.fournisseur || '',
      SECTION: ctx.SECTION || '',
      // Numéro seul (« 2.4.1.2 », « 5 ») même si l'IA a renvoyé le numéro
      // suivi du titre de l'article — même règle que bordereau-filler.
      ARTICLE: ((ctx.ARTICLE || '').match(/\d+(?:\.\d+)*/) || [ctx.ARTICLE || ''])[0],
      DESCRIPTION: description,
      USAGE: ctx.USAGE || '',
      REMARQUE: '',
      ft_url: mat.lien_fiche_technique || '',
    };
    p.ft_chemins = mat._ftCheminConnu ? [mat._ftCheminConnu] : await trouverFichesTechniques(p.FABRICANT, p.TITRE);
    p.ft_noms = p.ft_chemins.map(c => path.basename(c));
    if (p.ft_noms.length === 0 && p.ft_url) {
      p.ft_noms = [nomFichierDepuisUrl(p.ft_url) + ' (web)'];
    }
    p.ft_selection = p.ft_chemins.length > 0 ? p.ft_chemins[0] : '__AUTO__';
    // Traçabilité (priorité utilisateur #4) : le produit vient de la
    // selection de l'utilisateur (source fiable, voir plus haut) -- on
    // verifie EN PLUS s'il est effectivement mentionne dans le devis fourni,
    // pour distinguer "confirme par le devis" de "ajoute sans base au devis".
    p.detecte_devis = produitDetecteDansDevis(texteDevis, p.TITRE);
    p.ft_projet_key = null;
    p.ft_projet_nom = null;
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

  // S'assurer que chaque produit a une selection FT + les champs de
  // traçabilité #4 (anciens enregistrements créés avant cette fonctionnalité)
  for (const p of (data.produits || [])) {
    if (!p.ft_selection) p.ft_selection = '__AUTO__';
    if (typeof p.detecte_devis !== 'boolean') p.detecte_devis = null; // inconnu, pas "non"
    if (p.ft_projet_key === undefined) p.ft_projet_key = null;
    if (p.ft_projet_nom === undefined) p.ft_projet_nom = null;
  }

  const { fabricants, fournisseurs } = await listerFabricantsEtFournisseurs(req.db);
  const ftParFabricant = await listerFTParFabricant();
  const historique = (await req.db.execute({
    sql: 'SELECT action, ancien_statut, nouveau_statut, commentaire, effectue_par, created_at FROM historique_bordereaux WHERE bordereau_id = ? ORDER BY created_at DESC, id DESC',
    args: [row.id],
  })).rows;

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
    historique,
    representants: listerRepresentants(),
    generation: data.generation || null,
  });
});

// ── CONFIRMATION APRÈS GÉNÉRATION — étape de contrôle obligatoire avant
// l'approbation finale (priorité utilisateur #3). "Oui" (modifications
// nécessaires) renvoie le bordereau en Brouillon avec un commentaire
// obligatoire ; "Non" l'approuve. Toujours consigné dans historique_bordereaux.
router.post('/confirmer/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT statut FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau introuvable');
  if (r.rows[0].statut !== 'revise') return res.redirect('/bordereaux/reviser/' + id);

  const reponse = req.body.reponse === 'oui' ? 'oui' : 'non';
  const confirmePar = (req.body.confirme_par || '').trim();
  const commentaire = (req.body.commentaire || '').trim();

  if (reponse === 'oui') {
    if (!commentaire) return res.status(400).send('Un commentaire est obligatoire pour indiquer quelles modifications sont nécessaires.');
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'brouillon', modifie_par = ? WHERE id = ?`,
      args: [confirmePar || null, id],
    });
    await db.execute({
      sql: `INSERT INTO historique_bordereaux (bordereau_id, action, ancien_statut, nouveau_statut, commentaire, effectue_par) VALUES (?, 'modifications_demandees', 'revise', 'brouillon', ?, ?)`,
      args: [id, commentaire, confirmePar || null],
    });
  } else {
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'approuve', approuve_par = ? WHERE id = ?`,
      args: [confirmePar || null, id],
    });
    await db.execute({
      sql: `INSERT INTO historique_bordereaux (bordereau_id, action, ancien_statut, nouveau_statut, commentaire, effectue_par) VALUES (?, 'approuve', 'revise', 'approuve', ?, ?)`,
      args: [id, commentaire || null, confirmePar || null],
    });
  }

  res.redirect('/bordereaux/reviser/' + id);
});

// ── IMPORTER UNE FICHE TECHNIQUE POUR CE PROJET — priorité #4, "Confirmé
// projet" : quand la bibliothèque T3E n'a pas la fiche d'un produit, permet
// d'en attacher une propre à ce bordereau (jamais mêlée à la bibliothèque
// partagée "fiches-techniques"). Le fichier est déjà uploadé côté navigateur
// vers le bucket "uploads-temp" (voir /api/upload-url), cette route ne
// reçoit que les métadonnées + la clé temporaire.
router.post('/importer-ft/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const produitIndex = parseInt(req.body.produit_index);
  const cleTemp = req.body.cle_temp;
  const nomFichier = req.body.nom_fichier || 'fiche-technique.pdf';
  if (!cleTempValide(cleTemp)) return res.status(400).send('Fichier introuvable dans le stockage temporaire.');

  const r = await db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau introuvable');

  let data;
  try { data = JSON.parse(r.rows[0].contenu); } catch (_) { data = {}; }
  const produits = data.produits || [];
  if (isNaN(produitIndex) || produitIndex < 0 || produitIndex >= produits.length) {
    return res.status(400).send('Produit invalide.');
  }

  const buf = await downloadBuffer(BUCKETS.UPLOADS_TEMP, cleTemp);
  if (!buf) return res.status(400).send('Fichier introuvable dans le stockage temporaire.');

  await ensureBucket(BUCKETS.BORDEREAUX_FT_PROJET);
  const cle = sanitizeKey(`${id}/${produitIndex}-${Date.now()}-${path.basename(nomFichier)}`);
  await uploadBuffer(BUCKETS.BORDEREAUX_FT_PROJET, cle, buf, 'application/pdf');
  await removeFile(BUCKETS.UPLOADS_TEMP, cleTemp).catch(() => {});

  produits[produitIndex].ft_projet_key = cle;
  produits[produitIndex].ft_projet_nom = nomFichier;
  produits[produitIndex].ft_selection = '__PROJET__:' + cle;
  data.produits = produits;

  await db.execute({
    sql: 'UPDATE bordereaux SET contenu = ? WHERE id = ?',
    args: [JSON.stringify(data), id],
  });
  await db.execute({
    sql: `INSERT INTO historique_bordereaux (bordereau_id, action, commentaire, effectue_par) VALUES (?, 'ft_importee_projet', ?, ?)`,
    args: [id, `Produit « ${produits[produitIndex].TITRE || ''} » — fichier « ${nomFichier} »`, (req.body.importe_par || '').trim() || null],
  });

  res.redirect('/bordereaux/reviser/' + id);
});

// ── GÉNÉRATION COMPLÈTE (remplir N .docx + FT → ZIP) — même principe que
// genererEtSauvegarderManuel (manuel-generateur.js) : la requête de génération
// est sauvegardée dans contenu.generation_requete par POST /generer/:id, puis
// cette fonction fait tout le travail lourd (téléchargements FT, conversions
// LibreOffice, fusions pdf-lib) et dépose le ZIP dans Supabase Storage. Elle
// peut donc tourner soit en synchrone (dev local / repli), soit en
// ARRIÈRE-PLAN sur l'instance Render via /internal/generer-bordereaux
// (server.js) — la boucle séquentielle dépassait le plafond dur de 60 s des
// fonctions Vercel dès ~3-4 produits (un aller-retour Render par conversion) :
// FUNCTION_INVOCATION_TIMEOUT signalé par l'utilisateur avec 8 produits.
// Ne lève jamais d'exception : { ok, erreur? }, et consigne l'échec dans
// contenu.generation pour la page de révision.
async function genererEtSauvegarderBordereaux(db, id) {
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return { ok: false, erreur: 'Bordereau introuvable' };
  const row = r.rows[0];

  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }
  const requete = data.generation_requete;

  async function marquerErreur(message) {
    console.error('[bordereaux] Echec generation', id, ':', message);
    try {
      await db.execute({
        sql: `UPDATE bordereaux SET contenu = ? WHERE id = ?`,
        args: [JSON.stringify({ ...data, generation: { statut: 'erreur', erreur: message, quand: new Date().toISOString() } }), id],
      });
    } catch (_) {}
    return { ok: false, erreur: message };
  }

  if (!requete) return marquerErreur('Requête de génération introuvable (relancez « Générer »).');
  if (!row.template_data) return marquerErreur('Le template .docx est manquant. Veuillez recommencer.');

  const bordereauBuffer = Buffer.from(row.template_data, 'base64');

  const {
    nomProjet = '', numProjet = '', nom = 'Toitures Trois Étoiles',
    specialite = 'COUVREUR', adresse = '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
    nomEtablissement = '', architecte = '', entrepreneurGeneral = '', ingenieur = '',
    soumisPar = '', telephoneRepresentant = '', recuEntrepreneurDate = '',
    titres = [], fabricants = [], fournisseurs = [], sections = [], articles = [],
    descriptions = [], usages = [], ftSelections = [],
  } = requete;

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
      SOUMIS_PAR: soumisPar,
      RECU_ENTREPRENEUR_DATE: recuEntrepreneurDate,
      NOM_ETABLISSEMENT: nomEtablissement,
      ARCHITECTE: architecte,
      ENTREPRENEUR_GENERAL: entrepreneurGeneral,
      INGENIEUR: ingenieur,
      // Coordonnées du bloc SOUS-TRAITANT sur les gabarits tiers (fiche
      // d'identification) : tél. du représentant choisi, téléc. corporatif T3E.
      TELEPHONE: telephoneRepresentant,
      TELECOPIEUR: INFOS_ENTREPRISE_T3E.TELECOPIEUR_ENTREPRISE,
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

    // Étape 1 — Charger les FT D'ABORD : certains gabarits tiers (fiche
    // d'identification) ont un champ « NBRE DE PAGES » qui doit refléter le
    // document soumis (bordereau + FT) — on compte donc les pages FT avant
    // de remplir le .docx.
    let ftBuffers = [];
    try {
      ftBuffers = await resoudreFichesTechniquesAvecSelection(db, champs.FABRICANT, champs.TITRE, ftSelections[i]);
      if (ftBuffers.length === 0) console.log(`[generer] ${num} Aucune FT pour`, champs.TITRE, '/', champs.FABRICANT);
    } catch (e) {
      console.error(`[generer] ${num} Erreur FT:`, e.message);
    }
    let nbPagesFT = 0;
    for (const buf of ftBuffers) {
      try {
        const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
        nbPagesFT += doc.getPageCount();
      } catch (_) {}
    }
    champs.NB_PAGES_FT = nbPagesFT;

    // Étape 2 — Remplir le .docx
    let docxBuf = null;
    try {
      docxBuf = await remplirBordereau(champs, bordereauBuffer);
    } catch (e) {
      console.error(`[generer] ${num} Erreur remplissage:`, e.message);
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

  // Déposer le ZIP dans Supabase Storage (le disque Vercel/Render est
  // éphémère, et la réponse HTTP de l'appelant est peut-être déjà terminée
  // dans le mode arrière-plan) — clé fixe par bordereau : une regénération
  // remplace simplement le ZIP précédent.
  const section = (numProjet || nomProjet || 'T3E').replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30);
  const nomZip = `Bordereaux_${section}_${ts}.zip`;
  let zipBuffer;
  try {
    zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await ensureBucket(BUCKETS.BORDEREAUX_GENERES);
    await uploadBuffer(BUCKETS.BORDEREAUX_GENERES, `${id}/bordereaux.zip`, zipBuffer, 'application/zip');
  } catch (e) {
    return marquerErreur('Sauvegarde du ZIP échouée : ' + e.message);
  }

  // Mettre à jour la DB — la génération place le bordereau "En révision"
  // plutôt que directement "Approuvé" : une vraie étape de contrôle (voir
  // POST /confirmer/:id) est désormais nécessaire avant l'approbation.
  // Tracabilite : le representant choisi (ou, a defaut, le nom libre) — meme
  // valeur que "Soumis par" pour rester coherent dans l'historique.
  const generePar = soumisPar;
  try {
    await db.execute({
      sql: `UPDATE bordereaux SET statut = 'revise', session_actif = 0, numero_projet = ?, titre = ?, contenu = ? WHERE id = ?`,
      args: [numProjet, nomProjet, JSON.stringify({
        ...data,
        generation: { statut: 'termine', nom_fichier: nomZip, quand: new Date().toISOString(), diagnostic: diagnostic.join('\n') || null },
      }), id],
    });
    await db.execute({
      sql: `INSERT INTO historique_bordereaux (bordereau_id, action, ancien_statut, nouveau_statut, commentaire, effectue_par) VALUES (?, 'genere', ?, 'revise', ?, ?)`,
      args: [id, row.statut || 'brouillon', diagnostic.length > 0 ? diagnostic.join('\n').substring(0, 500) : null, generePar || null],
    });
  } catch (_) {}

  return { ok: true, nomFichier: nomZip };
}

// Déclenche la génération en ARRIÈRE-PLAN sur l'instance Render (voir
// /internal/generer-bordereaux dans server.js) — même mécanique que
// declencherGenerationDistante des manuels : on n'attend que l'accusé de
// réception (202), le traitement continue côté Render (service persistant,
// pas de plafond 60 s).
async function declencherGenerationDistanteBordereaux(id) {
  const url = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!url || !secret) throw new Error('service distant non configuré (CONVERT_SERVICE_URL/SECRET manquant)');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/internal/generer-bordereaux', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-convert-secret': secret },
      body: JSON.stringify({ bordereauId: id }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const corps = await resp.text().catch(() => '');
      throw new Error(`service distant a répondu ${resp.status}: ${corps.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ── GÉNÉRER — sauvegarde la requête puis délègue à Render (ou génère sur place) ──
router.post('/generer/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const db = req.db;
  const id = parseInt(req.params.id);
  const r = await db.execute({ sql: 'SELECT * FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau introuvable');

  const row = r.rows[0];
  if (!row.template_data) {
    return res.status(400).send('Le template .docx est manquant. Veuillez recommencer.');
  }

  // "Soumis par" (bas de page) : le representant T3E qui soumet le bordereau,
  // choisi dans le menu deroulant de la page de revision (les 4 profils de
  // representants.js — memes personnes que pour les soumissions SEAO). Si aucun
  // representant n'est selectionne, on retombe sur le nom libre saisi pour
  // l'historique (genere_par). "Reçu de l'entrepreneur le" : date du jour.
  const representant = obtenirRepresentant(req.body.representant_id);
  const soumisPar = representant
    ? `${representant.prenom} ${representant.nom}`
    : (req.body.genere_par || '').trim();

  // Tout ce dont la génération a besoin est figé ici (les champs produit
  // arrivent comme tableaux : TITRE[], FABRICANT[], etc.) — la fonction
  // genererEtSauvegarderBordereaux relit cette requête depuis la DB, qu'elle
  // tourne ici même ou en arrière-plan sur Render.
  const requete = {
    nomProjet: req.body.NOM_DU_PROJET || '',
    numProjet: req.body.NUMERO_DU_PROJET || '',
    nom: req.body.NOM || 'Toitures Trois Étoiles',
    specialite: req.body.SPECIALITE || 'COUVREUR',
    adresse: req.body.ADRESSE || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
    // Champs sans equivalent dans le gabarit T3E, mais presents sur beaucoup
    // de gabarits d'architectes tiers — extraits du devis a l'etape /analyser.
    nomEtablissement: req.body.NOM_ETABLISSEMENT || '',
    architecte: req.body.ARCHITECTE || '',
    entrepreneurGeneral: req.body.ENTREPRENEUR_GENERAL || '',
    ingenieur: req.body.INGENIEUR || '',
    soumisPar,
    telephoneRepresentant: representant ? representant.telephone : '',
    recuEntrepreneurDate: new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' }),
    titres: [].concat(req.body.TITRE || []),
    fabricants: [].concat(req.body.FABRICANT || []),
    fournisseurs: [].concat(req.body.FOURNISSEUR || []),
    sections: [].concat(req.body.SECTION || []),
    articles: [].concat(req.body.ARTICLE || []),
    descriptions: [].concat(req.body.DESCRIPTION || []),
    usages: [].concat(req.body.USAGE || []),
    ftSelections: [].concat(req.body.FT_FICHIER || []),
  };

  let data;
  try { data = JSON.parse(row.contenu); } catch (_) { data = {}; }
  // Marque "en cours" AVANT de déclencher, pour que la page de révision
  // (rechargée juste après la redirection) affiche le bon statut même si
  // Render n'a pas encore commencé.
  await db.execute({
    sql: `UPDATE bordereaux SET contenu = ? WHERE id = ?`,
    args: [JSON.stringify({
      ...data,
      generation_requete: requete,
      generation: { statut: 'en_cours', demarre_le: new Date().toISOString() },
    }), id],
  });

  if (process.env.VERCEL) {
    try {
      await declencherGenerationDistanteBordereaux(id);
      return res.redirect('/bordereaux/reviser/' + id);
    } catch (e) {
      console.error('[bordereaux] Délégation Render impossible, tentative en local :', e.message);
      // On continue en synchrone plutôt que d'échouer — un petit bordereau
      // (1-2 produits) passe sous les 60 s, et l'échec sera visible sinon.
    }
  }

  const resultat = await genererEtSauvegarderBordereaux(db, id);
  if (!resultat.ok) return res.status(500).send('Erreur : ' + resultat.erreur);
  res.redirect('/bordereaux/zip/' + id);
});

// Télécharge le dernier ZIP généré (déposé dans Supabase Storage par
// genererEtSauvegarderBordereaux) via une URL signée temporaire.
router.get('/zip/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const r = await req.db.execute({ sql: 'SELECT contenu FROM bordereaux WHERE id = ?', args: [id] });
  if (r.rows.length === 0) return res.status(404).send('Bordereau introuvable');
  let data;
  try { data = JSON.parse(r.rows[0].contenu); } catch (_) { data = {}; }
  const nomZip = (data.generation && data.generation.nom_fichier) || `Bordereaux_${id}.zip`;
  try {
    const url = await createSignedUrl(BUCKETS.BORDEREAUX_GENERES, `${id}/bordereaux.zip`, 300, nomZip);
    res.redirect(url);
  } catch (e) {
    res.status(404).send('ZIP introuvable ou pas encore généré.');
  }
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

// ── SUPPRESSION MULTIPLE — évite de devoir supprimer un par un ──
router.post('/supprimer-plusieurs', express.urlencoded({ extended: true }), async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(id => parseInt(id)).filter(id => !isNaN(id));
  for (const id of ids) {
    try { await req.db.execute({ sql: 'DELETE FROM historique_bordereaux WHERE bordereau_id = ?', args: [id] }); } catch (_) {}
    await req.db.execute({ sql: 'DELETE FROM bordereaux WHERE id = ?', args: [id] });
  }
  res.redirect('/bordereaux');
});

module.exports = router;
// Exposée pour l'endpoint interne /internal/generer-bordereaux (server.js) —
// même mécanique que genererEtSauvegarderManuel (manuel-generateur.js).
module.exports.genererEtSauvegarderBordereaux = genererEtSauvegarderBordereaux;
