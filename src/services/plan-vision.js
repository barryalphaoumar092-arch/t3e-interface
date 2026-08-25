// Analyse visuelle des plans pour combler les champs qu'une soumission privee
// n'a pas trouves dans le texte (voir soumission-parser.js/documentsVides —
// un plan vectoriel/scanne a souvent peu ou pas de texte extractible, mais
// l'information (superficie, pontage, etc.) peut y etre visible : tableaux,
// legendes, cartouches).
//
// Rendu PDF -> image : ni pdftoppm/poppler ni node-canvas ne sont disponibles
// en environnement serverless Vercel (voir CLAUDE.md — meme contrainte que la
// conversion docx->pdf, qui doit deleguer a un service Render avec
// LibreOffice). Le viewer PDF integre de Chromium headless (deja utilise en
// production par seao-scraper.js, voir navigateur-headless.js) suffit pour un
// rendu fidele sans ajouter de dependance native.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { lancerNavigateurHeadless } = require('./navigateur-headless');
const { parsePdfBuffer } = require('./document-parser');
const { analyserPlansVision } = require('./claude-client');

const LARGEUR_VUE = 1400;
const HAUTEUR_VUE = 1800;
const TIMEOUT_PAGE_MS = 15000;
// Plafonds volontairement bas : chaque page rendue + appel vision coute du
// temps (fonction serverless plafonnee, voir vercel.json) et des tokens —
// mieux vaut se limiter aux pages les plus susceptibles de porter
// l'information cherchee (debut de chaque document de plans, ou se trouvent
// generalement cartouches/tableaux sommaires) que de tout rendre.
const MAX_PAGES_TOTAL = 6;
const MAX_PAGES_PAR_DOCUMENT = 4;

// Rend les numeros de page demandes (1-indexes) d'un PDF en images PNG
// (base64). Un seul navigateur/onglet est reutilise pour toutes les pages —
// relancer Chromium par page serait beaucoup trop lent.
async function rendrePagesEnImages(buffer, numerosPages) {
  if (!numerosPages.length) return [];
  const tmpPath = path.join(os.tmpdir(), `t3e_plan_${crypto.randomBytes(6).toString('hex')}.pdf`);
  fs.writeFileSync(tmpPath, buffer);

  let browser;
  const images = [];
  try {
    browser = await lancerNavigateurHeadless();
    const page = await browser.newPage({ viewport: { width: LARGEUR_VUE, height: HAUTEUR_VUE } });
    for (const numero of numerosPages) {
      try {
        await page.goto(`file://${tmpPath}#page=${numero}&zoom=page-fit`, { waitUntil: 'load', timeout: TIMEOUT_PAGE_MS });
        await page.waitForTimeout(400); // laisse le viewer PDF de Chromium finir de se stabiliser
        const buf = await page.screenshot({ type: 'png' });
        images.push({ page: numero, base64: buf.toString('base64') });
      } catch (e) {
        console.error(`[plan-vision] Rendu page ${numero} échoué:`, e.message);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
  return images;
}

// Complete `champs` (resultat de analyserProjetSoumissionPrivee) avec une
// analyse visuelle des documents "plans" — ne touche JAMAIS un champ deja
// confirme par le texte, ne comble que ceux au statut "non_trouve". Jamais
// bloquant : une erreur ici ne doit pas faire echouer la generation, l'appel
// est enrobe dans un try/catch par le code appelant.
async function completerAvecVisionPlans(champs, documentsPlans, systeme) {
  const clesManquantes = Object.keys(champs).filter((cle) => {
    const c = champs[cle];
    return c && typeof c === 'object' && c.statut === 'non_trouve';
  });
  if (clesManquantes.length === 0 || documentsPlans.length === 0) return champs;

  const images = [];
  for (const doc of documentsPlans) {
    if (images.length >= MAX_PAGES_TOTAL) break;
    let nbPages = 1;
    try {
      const parsed = await parsePdfBuffer(doc.buffer);
      nbPages = parsed.pages || 1;
    } catch (_) { /* PDF illisible par pdf-parse — on tente quand meme la page 1 */ }

    const placesRestantes = MAX_PAGES_TOTAL - images.length;
    const nbARendre = Math.min(nbPages, MAX_PAGES_PAR_DOCUMENT, placesRestantes);
    const pagesARendre = Array.from({ length: nbARendre }, (_, i) => i + 1);

    const rendues = await rendrePagesEnImages(doc.buffer, pagesARendre);
    rendues.forEach((r) => images.push({ ...r, nomFichier: doc.nom_fichier }));
  }
  if (images.length === 0) return champs;

  let resultatVision;
  try {
    resultatVision = await analyserPlansVision(images, systeme, clesManquantes);
  } catch (e) {
    console.error('[plan-vision] Analyse vision échouée:', e.message);
    return champs;
  }
  if (!resultatVision || resultatVision.error) return champs;

  const misAJour = { ...champs };
  for (const cle of clesManquantes) {
    const v = resultatVision[cle];
    if (v && v.statut && v.statut !== 'non_trouve' && v.valeur) {
      misAJour[cle] = v;
    }
  }
  return misAJour;
}

module.exports = { rendrePagesEnImages, completerAvecVisionPlans };
