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
const BUDGET_TOTAL = 140000;
const CAP_PAR_DOCUMENT = 60000;

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

// documents: [{ nom_fichier, categorie: 'appel_offre'|'plans'|'addenda', buffer }]
// Les addendas sont places en PREMIER dans le contexte (priorite en cas de
// contradiction, meme convention que le prompt d'analyserExigencesAppelOffre).
async function construireContexte(documents) {
  const ordre = { addenda: 0, appel_offre: 1, plans: 2 };
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
    const extrait = texte.substring(0, cap);
    morceaux.push(`===== DOCUMENT: ${doc.nom_fichier} (${doc.categorie}) =====\n${extrait}`);
    budgetRestant -= extrait.length;
  }

  return {
    contexte: morceaux.join('\n\n'),
    documentsVides, // ex: plans scannes/vectoriels sans texte extractible — a signaler, pas une erreur
  };
}

module.exports = { construireContexte };
