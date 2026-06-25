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
  const info = { numero: '', client: '', adresse: '', architecte: '', date: '' };

  const numMatch = text.match(/(?:projet|project|no\.?|num[ée]ro|dossier)\s*[:#]?\s*([A-Z0-9][\w.-]{1,20})/i);
  if (numMatch) info.numero = numMatch[1].trim();

  const archMatch = text.match(/(?:architecte|arch\.?|professionnel)\s*[:#]?\s*([^\n\r]{3,60})/i);
  if (archMatch) info.architecte = archMatch[1].trim();

  const clientMatch = text.match(/(?:client|propri[ée]taire|donneur|destinataire|attention)\s*[:#]?\s*([^\n\r]{3,60})/i);
  if (clientMatch) info.client = clientMatch[1].trim();

  const adresseMatch = text.match(/(?:adresse|lieu|site|emplacement|address|location)\s*[:#]?\s*([^\n\r]{5,80})/i);
  if (adresseMatch) info.adresse = adresseMatch[1].trim();

  const dateMatch = text.match(/(?:date|émis|issued)\s*[:#]?\s*(\d{4}[-/]\d{2}[-/]\d{2}|\d{1,2}\s+\w+\s+\d{4})/i);
  if (dateMatch) info.date = dateMatch[1].trim();

  return info;
}

module.exports = { parseDevis, parseTemplate, extractProjectInfo };
