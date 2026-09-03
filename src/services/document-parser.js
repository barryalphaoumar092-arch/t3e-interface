const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

async function parseDevis(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.pdf') {
    return await parsePdf(filePath);
  } else if (ext === '.xlsx' || ext === '.xls') {
    return parseExcel(filePath);
  } else if (ext === '.docx') {
    return await parseDocx(filePath);
  } else if (ext === '.doc') {
    return await parseDoc(filePath);
  }

  return { text: '', tables: [], type: ext };
}

async function parseTemplate(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.pdf') {
    return await parsePdf(filePath);
  } else if (ext === '.docx') {
    return await parseDocx(filePath);
  } else if (ext === '.doc') {
    return await parseDoc(filePath);
  }

  return { text: '', type: ext };
}

async function parsePdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  return parsePdfBuffer(buffer);
}

// Variante sans fichier temporaire — pour parser un PDF déjà en mémoire
// (ex: une fiche technique téléchargée depuis Supabase Storage), cohérent
// avec la contrainte "disque éphémère" du projet (voir CLAUDE.md).
async function parsePdfBuffer(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return {
    text: data.text || '',
    pages: data.numpages,
    type: 'pdf',
  };
}

function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const allText = [];
  const tables = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws);
    if (rows.length > 0) {
      tables.push({
        sheet: sheetName,
        colonnes: Object.keys(rows[0]),
        donnees: rows.slice(0, 100),
      });
      for (const row of rows) {
        allText.push(Object.values(row).join(' '));
      }
    }
  }

  return {
    text: allText.join('\n'),
    tables,
    type: 'excel',
  };
}

async function parseDocx(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return {
    text: result.value || '',
    type: 'docx',
  };
}

async function parseDoc(filePath) {
  const WordExtractor = require('word-extractor');
  const extractor = new WordExtractor();
  const doc = await extractor.extract(filePath);
  return {
    text: doc.getBody() || '',
    type: 'doc',
  };
}

function extractProjectInfo(text) {
  const info = { numero: '', client: '', adresse: '', architecte: '', date: '', ville: '', code_postal: '' };

  const numMatch = text.match(/(?:projet|project|no\.?|num[ée]ro|dossier)\s*[:#]?\s*([A-Z0-9][\w.-]{1,20})/i);
  if (numMatch) info.numero = numMatch[1].trim();

  const archMatch = text.match(/(?:architecte|arch\.?|professionnel)\s*[:#]?\s*([^\n\r]{3,60})/i);
  if (archMatch) info.architecte = archMatch[1].trim().replace(/[,;.]+$/, '');

  // Client : plusieurs patterns courants dans les devis québécois
  const clientPatterns = [
    /(?:client|propri[ée]taire|donneur d'ordre|destinataire|attention|à l'attention de)\s*[:#]?\s*([^\n\r]{3,80})/i,
    /(?:syndicat de copropri[ée]t[ée]|condo|r[ée]sidence|immeuble|b[aâ]timent)\s*[^\n\r]{0,20}\n?\s*([^\n\r]{3,60})/i,
  ];
  for (const pat of clientPatterns) {
    const m = text.match(pat);
    if (m) { info.client = m[1].trim().replace(/[,;.]+$/, ''); break; }
  }

  const adresseMatch = text.match(/(?:adresse|lieu|site|emplacement|address|location)\s*[:#]?\s*([^\n\r]{5,100})/i);
  if (adresseMatch) info.adresse = adresseMatch[1].trim().replace(/[,;.]+$/, '');

  // Code postal québécois (ex: H2X 1A1 ou H2X1A1)
  const cpMatch = text.match(/\b([A-Za-z]\d[A-Za-z])[\s-]?(\d[A-Za-z]\d)\b/);
  if (cpMatch) info.code_postal = (cpMatch[1] + ' ' + cpMatch[2]).toUpperCase();

  // Ville : ligne avant ou après le code postal
  if (cpMatch) {
    const idx = text.indexOf(cpMatch[0]);
    const avant = text.substring(Math.max(0, idx - 60), idx);
    const villeMatch = avant.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s-]{2,30})\s*(?:,\s*(?:QC|Québec|Quebec|ON|AB|BC))?\s*$/i);
    if (villeMatch) info.ville = villeMatch[1].trim();
  }

  const dateMatch = text.match(/(?:date|émis|issued)\s*[:#]?\s*(\d{4}[-/]\d{2}[-/]\d{2}|\d{1,2}\s+\w+\s+\d{4})/i);
  if (dateMatch) info.date = dateMatch[1].trim();

  return info;
}

// Texte par page (tableau, dans l'ordre) d'un PDF déjà en mémoire — utilisé
// pour localiser de façon fiable une page précise dans un PDF assemblé dont
// certaines sections ont une longueur variable (ex: retrouver la page de
// début de chaque section du manuel de fin de chantier en cherchant son
// titre exact, plutôt que de supposer un nombre de pages fixe par section).
async function texteParPage(buffer) {
  const pdfParse = require('pdf-parse');
  const pages = [];
  const pagerender = (pageData) => {
    return pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      .then((textContent) => {
        let lastY;
        let text = '';
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || lastY === undefined) {
            text += item.str;
          } else {
            text += '\n' + item.str;
          }
          lastY = item.transform[5];
        }
        pages.push(text);
        return text;
      });
  };
  await pdfParse(buffer, { pagerender });
  return pages;
}

// Extrait une description COURTE (quelques mots, jamais une phrase complète
// si elle peut être évitée) à partir du texte brut d'une fiche technique —
// repli SANS IA utilisé quand l'extraction IA échoue ou est indisponible
// (voir bordereaux.js/extraireTitreDescriptionFT). Ne renvoie JAMAIS le
// titre lui-même : mieux vaut une chaîne vide qu'une duplication.
function extraireDescriptionCourteSansIA(texte, titre) {
  if (!texte) return '';
  const titreNorm = String(titre || '').trim().toLowerCase();
  const lignes = texte.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const estBruit = (l) => {
    if (!l || l.toLowerCase() === titreNorm) return true;
    if (l.length < 8 || l.length > 160) return true;
    // Specs/valeurs (unites, pourcentages, prix) plutot qu'une phrase descriptive.
    if (/^\d/.test(l) || /\d+\s*(mm|cm|po|pi|kg|lb|%|\$)\b/i.test(l)) return true;
    const nbChiffres = (l.match(/\d/g) || []).length;
    if (nbChiffres > l.length * 0.3) return true;
    if (!/[a-zàâäéèêëîïôöùûüç]{3}/i.test(l)) return true; // pas assez de vraies lettres
    return false;
  };

  // 1) Label explicite "Description" / "Description du produit" — la ligne
  // utile suit alors ce label sur l'une des lignes suivantes.
  const idxLabel = lignes.findIndex((l) => /^description(\s+du\s+produit)?\s*:?$/i.test(l));
  let candidate = null;
  if (idxLabel !== -1) {
    for (let i = idxLabel + 1; i < Math.min(idxLabel + 4, lignes.length); i++) {
      if (!estBruit(lignes[i])) { candidate = lignes[i]; break; }
    }
  }
  // 2) Sinon, premiere ligne substantielle apres l'occurrence du titre.
  if (!candidate) {
    const idxTitre = lignes.findIndex((l) => l.toLowerCase() === titreNorm);
    const depart = idxTitre !== -1 ? idxTitre + 1 : 0;
    for (let i = depart; i < Math.min(depart + 10, lignes.length); i++) {
      if (!estBruit(lignes[i])) { candidate = lignes[i]; break; }
    }
  }
  if (!candidate) return '';

  // Reste COURT : garde la 1ere clause (avant point/point-virgule). Si elle
  // depasse ~12 mots, coupe a la DERNIERE VIRGULE avant la limite plutot que
  // sur un compte de mots brut — sinon on tronque en pleine enumeration
  // (constate : "adhésif à faible expansion, à deux composants, à base" —
  // coupe avant "de [polyurethane]", une phrase incomplete plutot qu'un
  // fragment court mais complet).
  let court = candidate.split(/[.;]/)[0].trim();
  const mots = court.split(/\s+/);
  if (mots.length > 12) {
    const positionMot12 = mots.slice(0, 12).join(' ').length;
    const virguleUtile = [...court.matchAll(/,/g)].map((m) => m.index).filter((i) => i <= positionMot12).pop();
    court = virguleUtile !== undefined ? court.slice(0, virguleUtile) : mots.slice(0, 12).join(' ');
  }
  return court.replace(/[,:;]\s*$/, '').trim();
}

module.exports = { parseDevis, parseTemplate, parsePdfBuffer, texteParPage, extractProjectInfo, extraireDescriptionCourteSansIA };
