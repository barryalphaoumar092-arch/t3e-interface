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

function labelVariants(label) {
  const NBSP = ' ';
  const base = label.replace(/[  ]:$/, '');
  return [
    base + NBSP + ':',
    base + ' :',
    base + ':',
  ];
}

function remplirChampDansXml(xml, label, valeur) {
  for (const variant of labelVariants(label)) {
    const idx = xml.indexOf(variant);
    if (idx === -1) continue;

    const colonIdx = idx + variant.length - 1;
    const closeIdx = xml.indexOf('</w:t>', colonIdx);
    if (closeIdx === -1) continue;

    const nouvelleValeur = valeur ? ' ' + escapeXml(String(valeur)) : '';
    xml = xml.substring(0, colonIdx + 1) + nouvelleValeur + xml.substring(closeIdx);
    return xml;
  }
  return xml;
}

function cocherFicheTechnique(xml) {
  // Trouver "Fiche technique" dans le XML, puis cocher la case à cocher la plus proche
  const ftIdx = xml.indexOf('Fiche technique');
  if (ftIdx === -1) return xml;

  // Chercher le <w:checkBox> le plus proche APRÈS "Fiche technique"
  let cbIdx = xml.indexOf('<w:checkBox>', ftIdx);
  // Si pas trouvé après, chercher AVANT (la case peut être avant le texte)
  if (cbIdx === -1 || cbIdx > ftIdx + 2000) {
    cbIdx = xml.lastIndexOf('<w:checkBox>', ftIdx);
  }
  if (cbIdx === -1) return xml;

  const cbEnd = xml.indexOf('</w:checkBox>', cbIdx);
  if (cbEnd === -1) return xml;

  // Vérifier si déjà cochée
  const cbContent = xml.substring(cbIdx, cbEnd);
  if (cbContent.includes('w:default') || cbContent.includes('w:checked')) return xml;

  // Insérer <w:default w:val="1"/> juste avant </w:checkBox>
  xml = xml.substring(0, cbEnd) + '<w:default w:val="1"/>' + xml.substring(cbEnd);
  return xml;
}

async function remplirBordereau(champs, buf) {
  const templateBuf = buf || fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  xml = normalizeXmlText(xml);

  // Cocher la case "Fiche technique" (toujours)
  xml = cocherFicheTechnique(xml);

  // Labels plus longs EN PREMIER pour eviter correspondances partielles
  const NBSP = ' ';
  const remplacements = [
    ['NOM DU PROJET' + NBSP + ':',      champs.NOM_DU_PROJET    || ''],
    ['NUMÉRO DU PROJET' + NBSP + ':', champs.NUMERO_DU_PROJET || ''],
    ['SPÉCIALITÉ' + NBSP + ':', champs.SPECIALITE     || 'COUVREUR'],
    ['ADRESSE' + NBSP + ':',             champs.ADRESSE          || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1'],
    ['NOM' + NBSP + ':',                 champs.NOM              || 'Toitures Trois Étoiles'],
    ['Titre' + NBSP + ':',               champs.TITRE            || ''],
    ['Numéro de dessins' + NBSP + ':', ''],
    ['Nombre feuilles' + NBSP + ':',     ''],
    ['Révision' + NBSP + ':',       ''],
    ['Description' + NBSP + ':',         ''],
    ['Fournisseur' + NBSP + ':',         champs.FOURNISSEUR      || ''],
    ['Fabricant' + NBSP + ':',           champs.FABRICANT        || ''],
    ['Section (item)' + NBSP + ':',      champs.SECTION          || ''],
    ['Article' + NBSP + ':',             champs.ARTICLE          || ''],
    ['Délai' + NBSP + ':',          ''],
    ['Remarque' + NBSP + ':',            champs.REMARQUE         || ''],
  ];

  for (const [label, valeur] of remplacements) {
    xml = remplirChampDansXml(xml, label, valeur);
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { remplirBordereau };
