// Assemble le contexte multi-documents (appel d'offre + plans + addendas)
// envoye a l'IA pour remplir une soumission privee. Reutilise document-parser.js
// pour l'extraction de texte et reprend la convention de marqueurs de
// seao-exigences.js (===== DOCUMENT: ... =====, --- page N ---) pour que
// chaque champ extrait puisse citer sa source exacte (voir champSourceSchema
// dans claude-client.js). Les plans sont souvent des PDF vectoriels/scannes
// avec peu ou pas de texte extractible : un texte quasi vide pour un plan
// est attendu, pas une erreur.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseDevis, texteParPage } = require('./document-parser');

// Budget total de caracteres envoyes a l'IA, reparti entre documents par
// ordre de priorite (addendas d'abord — ils priment en cas de contradiction
// avec l'appel d'offre ou les plans — meme regle que seao-exigences.js).
// Le compte OpenAI a une limite de 500000 tokens/minute sur gpt-5 (verifie
// via les en-tetes x-ratelimit-*) — les TOKENS ne sont plus le facteur
// limitant. MAIS un contexte plus gros = plus de temps de traitement pour
// le modele, et le vrai plafond restant est le delai de 60s de la fonction
// Vercel (voir vercel.json) : teste et CONSTATE en depassement avec 220000/
// 90000 des que 2 documents ou plus sont combines (meme sans plans/vision).
// CAP_PAR_DOCUMENT reste a 90000 (beneficie un devis technique unique volumineux,
// deja teste avec succes en ~55s) mais BUDGET_TOTAL redescend a 140000 pour
// que la combinaison de plusieurs documents reste sous 60s.
const BUDGET_TOTAL = 140000;
const CAP_PAR_DOCUMENT = 90000;

// Marqueur du DEBUT de la section technique de toiture (division CSI 07)
// dans un devis de construction — un gros devis commence typiquement par des
// dizaines de pages de conditions generales/administratives avant
// d'atteindre les sections techniques ; une simple troncature depuis le
// debut du texte peut donc couper AVANT la section toiture. Constate sur un
// vrai devis (projet 25-190-01, École Laval Senior Academy, 175 pages) :
// les champs administratifs (client, adresse, date) etaient tous extraits
// correctement mais TOUS les champs de composition (pontage, isolant,
// membrane, plis...) restaient non_trouve.
//
// PIÈGE #1 : le mot "SECTION" est OBLIGATOIRE dans ce marqueur. Une première
// version sans ce prefixe (juste "07 5X XX" ou "couverture") matchait la
// TABLE DES MATIÈRES ("07 52 00            Couvertures à membrane...", vers
// le tout début du document) ou même "Couverture de devis" (page de garde,
// section 00 00 00) — ces faux positifs tombaient sous le seuil de 0.6 et
// faisaient retomber sur la troncature simple, sans aucun effet réel.
//
// PIÈGE #2 : la regex doit être SENSIBLE À LA CASSE (pas de /i). Un devis
// contient presque toujours des renvois narratifs du genre "se référer à
// la section 07 52 00" (minuscule, dans une phrase d'une AUTRE section)
// AVANT le vrai en-tête — avec /i, ce renvoi est trouvé en premier (position
// ~273000 sur le devis 25-190-01) et le fix "saute" pile avant le vrai
// contenu (qui commence ~68000 caractères plus loin, à ~341000), ratant
// entièrement les produits nommés (Sopralene, Sopra-Iso, Soprastar...)
// malgré un idx apparemment valide. Les vrais en-têtes de page répétés dans
// la section utilisent TOUJOURS "SECTION" en majuscules ; les renvois
// narratifs utilisent presque toujours "section" en minuscules — la casse
// est donc un signal fiable pour les distinguer.
const MARQUEUR_SECTION_TOITURE = /\bSECTION\s*07\s*5\d\s*\d\d|\bSECTION\s*07\s*6\d\s*\d\d/;

// Si le marqueur n'est pas trouve, ou tombe deja dans la portion qu'une
// simple troncature aurait couverte, le comportement precedent (troncature
// simple depuis le debut) suffit — pas de risque de regression.
function extraireTexteUtile(texte, capMax) {
  if (texte.length <= capMax) return texte;
  const idx = texte.search(MARQUEUR_SECTION_TOITURE);
  if (idx === -1 || idx < capMax * 0.6) return texte.substring(0, capMax);

  const longueurPrefixe = Math.min(4000, Math.floor(capMax * 0.15));
  const prefixe = texte.substring(0, longueurPrefixe);
  const budgetRestant = capMax - longueurPrefixe;
  const suite = texte.substring(idx, idx + budgetRestant);
  return prefixe + '\n[...sections générales/administratives omises...]\n' + suite;
}

async function texteDuFichier(buffer, nomFichier) {
  const ext = path.extname(nomFichier).toLowerCase();
  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  try {
    if (ext === '.pdf') {
      const pages = await texteParPage(buffer);
      return pages.map((p, i) => `--- page ${i + 1} ---\n${p}`).join('\n');
    }
    const parsed = await parseDevis(tmpPath, nomFichier);
    return parsed.text || '';
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// documents: [{ nom_fichier, categorie: 'appel_offre'|'devis'|'plans'|'addendas', buffer }]
// Les addendas sont places en PREMIER dans le contexte (priorite en cas de
// contradiction, meme convention que le prompt d'analyserExigencesAppelOffre).
// appel_offre et devis sont au meme palier (documents de base du projet).
async function construireContexte(documents) {
  const ordre = { addendas: 0, addenda: 0, appel_offre: 1, devis: 1, plans: 2 };
  const tries = [...documents].sort((a, b) => (ordre[a.categorie] ?? 9) - (ordre[b.categorie] ?? 9));

  let budgetRestant = BUDGET_TOTAL;
  const morceaux = [];
  const documentsVides = [];

  for (const doc of tries) {
    if (budgetRestant <= 0) break;
    let texte = '';
    try {
      texte = await texteDuFichier(doc.buffer, doc.nom_fichier);
    } catch (e) {
      texte = '';
    }
    texte = (texte || '').trim();
    if (!texte) {
      documentsVides.push(doc.nom_fichier);
      continue;
    }
    const cap = Math.min(CAP_PAR_DOCUMENT, budgetRestant);
    const extrait = extraireTexteUtile(texte, cap);
    morceaux.push(`===== DOCUMENT: ${doc.nom_fichier} (${doc.categorie}) =====\n${extrait}`);
    budgetRestant -= extrait.length;
  }

  return {
    contexte: morceaux.join('\n\n'),
    documentsVides, // ex: plans scannes/vectoriels sans texte extractible — a signaler, pas une erreur
  };
}

module.exports = { construireContexte };
