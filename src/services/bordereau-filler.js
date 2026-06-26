const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'documents', 'bordereau-template.docx');
const N = ' '; // espace insécable (U+00A0) dans le template Word

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fusionne les <w:t> fragmentés sur plusieurs runs dans le même paragraphe
function normalizeXmlText(xml) {
  let result = xml;
  let changed = true;
  let passes = 0;
  while (changed && passes < 5) {
    passes++;
    const before = result;
    result = result.replace(/<\/w:t>(<\/w:r><w:r(?:\s[^>]*)?>(?:<w:rPr>(?:[^<]|<(?!\/w:rPr>))*<\/w:rPr>)?<w:t(?:\s[^>]*)?>)/g, '');
    changed = result !== before;
  }
  return result;
}

// Remplace pattern par value dans le XML, même si le texte est splitté entre runs
function replaceInXml(xml, pattern, value) {
  const escaped = escapeXml(pattern);
  const safeValue = escapeXml(value);

  if (xml.includes(escaped)) {
    return xml.split(escaped).join(safeValue);
  }

  const chars = escaped.split('');
  const regex = chars.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:<[^>]*>)*');
  try {
    const re = new RegExp(regex, 'g');
    if (re.test(xml)) {
      xml = xml.replace(re, (match) => {
        const firstRunMatch = match.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
        if (firstRunMatch) {
          return `<w:r>${firstRunMatch[0]}<w:t xml:space="preserve">${safeValue}</w:t></w:r>`;
        }
        return safeValue;
      });
    }
  } catch (e) { /* regex trop complexe, on passe */ }

  return xml;
}

// buf optionnel — si absent, utilise le template T3E par défaut
async function remplirBordereau(champs, buf) {
  const templateBuf = buf || fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  // Fusionner les runs XML fragmentés AVANT les remplacements
  xml = normalizeXmlText(xml);

  const remplacements = [
    [`NOM DU PROJET${N}:`,    champs.NOM_DU_PROJET    || ''],
    [`NUMÉRO DU PROJET${N}:`, champs.NUMERO_DU_PROJET || ''],
    [`NOM${N}:`,              champs.NOM              || 'Toitures Trois Étoiles'],
    [`SPÉCIALITÉ${N}:`,       champs.SPECIALITE       || 'COUVREUR'],
    [`ADRESSE${N}:`,          champs.ADRESSE          || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1'],
    [`Titre${N}:`,            champs.TITRE            || ''],
    [`Numéro de dessins${N}:`,champs.NUMERO_DESSINS   || ''],
    [`Nombre feuilles${N}:`,  ''],
    [`Révision${N}:`,         ''],
    [`Description${N}:`,      champs.DESCRIPTION      || ''],
    [`Fournisseur${N}:`,      champs.FOURNISSEUR      || ''],
    [`Fabricant${N}:`,        champs.FABRICANT        || ''],
    [`Section (item)${N}:`,   champs.SECTION          || ''],
    [`Article${N}:`,          champs.ARTICLE          || ''],
    [`Délai${N}:`,            champs.DELAI            || ''],
    [`Remarque${N}:`,         champs.REMARQUE         || ''],
  ];

  for (const [label, valeur] of remplacements) {
    // On cherche le label (sans underscores trailing) suivi de n'importe quels _/espaces
    const labelTrimmed = label.replace(/[\s_]+$/, '');
    const escaped = labelTrimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replacement = escapeXml(`${label} ${valeur}`.trimEnd());

    // 1) Tentative via <w:t> avec underscores optionnels
    const re = new RegExp(`(<w:t[^>]*>)(${escaped})[_ ]*(</w:t>)`, 'g');
    const before = xml;
    xml = xml.replace(re, `$1${replacement}$3`);

    // 2) Si rien n'a changé, fallback replaceInXml (gère les runs encore fragmentés)
    if (xml === before) {
      xml = replaceInXml(xml, labelTrimmed, `${label} ${valeur}`.trimEnd());
    }
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { remplirBordereau };
