const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'documents', 'bordereau-template.docx');

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fusionne les <w:t> fragmentes sur plusieurs runs dans le meme paragraphe
function normalizeXmlText(xml) {
  let result = xml;
  let changed = true;
  let passes = 0;
  while (changed && passes < 5) {
    passes++;
    const before = result;
    result = result.replace(
      /<\/w:t>(<\/w:r><w:r(?:\s[^>]*)?>(?:<w:rPr>(?:[^<]|<(?!\/w:rPr>))*<\/w:rPr>)?<w:t(?:\s[^>]*)?>)/g,
      ''
    );
    changed = result !== before;
  }
  return result;
}

// Genere 3 variantes du label : NBSP (U+00A0), espace normal (U+0020), sans espace
// Toutes nos etiquettes finissent par ':', on gere les variantes du caractere juste avant ':'
function labelVariants(label) {
  const base = label.replace(/[  ]:$/, '');
  return [
    base + ' :',  // espace insecable — format Word standard
    base + ' :',  // espace normal — fallback
    base + ':',        // sans espace — fallback extreme
  ];
}

// Cherche le label dans le XML et remplace le contenu apres ':' jusqu'a '</w:t>'
function remplirChampDansXml(xml, label, valeur) {
  for (const variant of labelVariants(label)) {
    const idx = xml.indexOf(variant);
    if (idx === -1) continue;

    const colonIdx = idx + variant.length - 1; // ':' est le dernier char du variant
    const closeIdx = xml.indexOf('</w:t>', colonIdx);
    if (closeIdx === -1) continue;

    const nouvelleValeur = valeur ? ' ' + escapeXml(String(valeur)) : '';
    xml = xml.substring(0, colonIdx + 1) + nouvelleValeur + xml.substring(closeIdx);
    return xml;
  }
  return xml;
}

// buf optionnel — si absent, utilise le template T3E par defaut
async function remplirBordereau(champs, buf) {
  const templateBuf = buf || fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  xml = normalizeXmlText(xml);

  // Labels plus longs EN PREMIER pour eviter correspondances partielles
  // ex: "NOM DU PROJET" avant "NOM"
  const remplacements = [
    ['NOM DU PROJET :',      champs.NOM_DU_PROJET    || ''],
    ['NUMÉRO DU PROJET :', champs.NUMERO_DU_PROJET || ''],
    ['SPÉCIALITÉ :', champs.SPECIALITE     || 'COUVREUR'],
    ['ADRESSE :',             champs.ADRESSE          || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1'],
    ['NOM :',                 champs.NOM              || 'Toitures Trois Étoiles'],
    ['Titre :',               champs.TITRE            || ''],
    ['Numéro de dessins :', champs.NUMERO_DESSINS || ''],
    ['Nombre feuilles :',     ''],
    ['Révision :',       ''],
    ['Description :',         champs.DESCRIPTION      || ''],
    ['Fournisseur :',         champs.FOURNISSEUR      || ''],
    ['Fabricant :',           champs.FABRICANT        || ''],
    ['Section (item) :',      champs.SECTION          || ''],
    ['Article :',             champs.ARTICLE          || ''],
    ['Délai :',          champs.DELAI            || ''],
    ['Remarque :',            champs.REMARQUE         || ''],
  ];

  for (const [label, valeur] of remplacements) {
    xml = remplirChampDansXml(xml, label, valeur);
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { remplirBordereau };
