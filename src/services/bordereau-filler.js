const JSZip = require('jszip');
const { downloadBuffer, BUCKETS } = require('./storage');

const TEMPLATE_KEY = 'bordereau-template.docx';

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
  const ftIdx = xml.indexOf('Fiche technique');
  if (ftIdx === -1) return xml;

  // 1. Ajouter <w:default w:val="1"/> dans le checkBox
  const cbIdx = xml.indexOf('<w:checkBox>', ftIdx);
  if (cbIdx !== -1) {
    const cbEnd = xml.indexOf('</w:checkBox>', cbIdx);
    if (cbEnd !== -1 && !xml.substring(cbIdx, cbEnd).includes('w:default')) {
      xml = xml.substring(0, cbEnd) + '<w:default w:val="1"/>' + xml.substring(cbEnd);
    }
  }

  // 2. Insérer le symbole coché ☒ dans le résultat du champ (entre separate et end)
  const sepIdx = xml.indexOf('fldCharType="separate"', ftIdx);
  if (sepIdx === -1) return xml;
  const endIdx = xml.indexOf('fldCharType="end"', sepIdx);
  if (endIdx === -1) return xml;

  // Trouver un <w:r> avec <w:rPr> mais SANS <w:t> entre separate et end → y insérer ☒
  const between = xml.substring(sepIdx, endIdx);
  const emptyRunMatch = between.match(/<\/w:rPr><\/w:r>/);
  if (emptyRunMatch) {
    const insertPos = sepIdx + emptyRunMatch.index + '</w:rPr>'.length;
    xml = xml.substring(0, insertPos) + '<w:t>☒</w:t>' + xml.substring(insertPos);
  }

  return xml;
}

async function remplirBordereau(champs, buf) {
  const templateBuf = buf || await downloadBuffer(BUCKETS.DOCUMENTS, TEMPLATE_KEY);
  if (!templateBuf) throw new Error('Template bordereau introuvable (Supabase Storage).');
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
    ['Description' + NBSP + ':',         champs.DESCRIPTION      || ''],
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
