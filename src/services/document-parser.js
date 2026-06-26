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
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
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

module.exports = { parseDevis, parseTemplate, extractProjectInfo };
