const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATES_DIR = path.join(__dirname, '../../documents/templates-soumission');

const TEMPLATE_MAP = {
  'BUR_REFECTION':       { fr: 'T3E - BUR 2-4-5 PLIS REFECTION (FR).docx',    en: 'T3E - BUR 2-4-5 PLIS REFECTION (EN).docx' },
  'BUR_PLEUMAGE':        { fr: 'T3E - BUR 2-4-5 PLIS PLEUMAGE (FR).docx',     en: 'T3E - BUR 2-4-5 PLIS PLEUMAGE (EN).docx' },
  'COLVENT_REFECTION':   { fr: 'T3E - COLVENT REFECTION (FR).docx',            en: 'T3E - COLVENT REFECTION (EN).docx' },
  'EPDM_PVC_PLEUMAGE':   { fr: 'T3E - EPDM-PVC PLEUMAGE (FR).docx',           en: 'T3E - EPDM-PVC PLEUMAGE (EN).docx' },
  'INVERSE_REFECTION':   { fr: 'T3E - INVERSE REFECTION (FR).docx',            en: 'T3E - INVERSE REFECTION (EN).docx' },
  'SOPRAFIX_REFECTION':  { fr: 'T3E - SOPRAFIX REFECTION (FR).docx',           en: 'T3E - SOPRAFIX REFECTION (EN).docx' },
  'SOPRASMART_REFECTION':{ fr: 'T3E - SOPRASMART REFECTION (FR).docx',         en: 'T3E - SOPRASMART REFECTION (EN).docx' },
  'TPO_PVC_RHINOBOND':   { fr: 'T3E - TPO-PVC RHINOBOND REFECTION (FR).docx',  en: 'T3E - TPO-PVC RHINOBOND REFECTION (EN).docx' },
  'ANCESTRAL':           { fr: 'T3E - ANCESTRAL (FR).docx',                    en: 'T3E - ANCESTRAL (EN).docx' },
};

function selectTemplate(systeme, type_travaux) {
  const key = `${systeme}_${type_travaux}`.toUpperCase();
  if (TEMPLATE_MAP[key]) return key;

  for (const k of Object.keys(TEMPLATE_MAP)) {
    if (k.includes(systeme.toUpperCase())) return k;
  }
  return null;
}

function getTemplateFile(templateKey, langue) {
  const entry = TEMPLATE_MAP[templateKey];
  if (!entry) return null;
  const lang = (langue || 'FR').toLowerCase();
  return entry[lang] || entry.fr;
}

function formatDate(langue) {
  const now = new Date();
  const moisFr = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  const moisEn = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const joursFr = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
  const joursEn = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  if ((langue || 'FR').toUpperCase() === 'EN') {
    return `Montreal, ${joursEn[now.getDay()]}, ${moisEn[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  }
  return `Montréal, ${joursFr[now.getDay()]}, ${now.getDate()} ${moisFr[now.getMonth()]} ${now.getFullYear()}`;
}

function escapeXml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildReplacements(soumission) {
  const s = soumission;
  return [
    { pattern: '#SOUMISSION', value: s.numero || '______' },
    { pattern: 'NOM DU PROJET ET CLIENT', value: s.projet_nom ? `${s.projet_nom} - ${s.client_nom}` : s.client_nom || '______' },
    { pattern: 'NOM DU CLIENT', value: s.client_nom || '______' },
    { pattern: 'Montréal, mardi, 1er octobre 2024', value: formatDate(s.langue) },
    { pattern: 'mardi, 1er octobre 2024', value: formatDate(s.langue).replace(/^Montréal, |^Montreal, /,'') },
    { pattern: 'Montreal, Tuesday, October 1st, 2024', value: formatDate(s.langue) },
    { pattern: 'Tuesday, October 1st, 2024', value: formatDate(s.langue).replace(/^Montreal, /,'') },
    { pattern: 'Ville, Province, Code Postal', value: [s.client_ville, s.client_province, s.client_code_postal].filter(Boolean).join(', ') || '______' },
    { pattern: 'City, Province, Postal Code', value: [s.client_ville, s.client_province, s.client_code_postal].filter(Boolean).join(', ') || '______' },
    { pattern: 'Nom représentant du client', value: s.client_contact || '______' },
    { pattern: "Client's representative name", value: s.client_contact || '______' },
    { pattern: '000-000-0000', value: s.client_telephone || '______' },
    { pattern: 'courriel@courriel.ca', value: s.client_courriel || '______' },
    { pattern: 'email@email.ca', value: s.client_courriel || '______' },
    { pattern: '100 000$', value: s.prix_total ? `${Number(s.prix_total).toLocaleString('fr-CA')}$` : '______$' },
    { pattern: '$100,000', value: s.prix_total ? `$${Number(s.prix_total).toLocaleString('en-CA')}` : '$______' },
  ];
}

// Replace text in the XML, handling Word's split runs
function replaceInXml(xml, pattern, value) {
  const escaped = escapeXml(pattern);
  const safeValue = escapeXml(value);

  // Direct replacement if pattern exists as-is in XML
  if (xml.includes(escaped)) {
    return xml.split(escaped).join(safeValue);
  }

  // Try to find the pattern split across XML tags (Word often splits text into multiple <w:r> runs)
  const chars = escaped.split('');
  let regex = chars.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:<[^>]*>)*');
  try {
    const re = new RegExp(regex, 'g');
    if (re.test(xml)) {
      // Rebuild: find the match, keep only the first run's formatting, replace content
      xml = xml.replace(re, (match) => {
        const firstRunMatch = match.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
        if (firstRunMatch) {
          return `<w:r>${firstRunMatch[0]}<w:t xml:space="preserve">${safeValue}</w:t></w:r>`;
        }
        return safeValue;
      });
    }
  } catch(e) { /* regex too complex, skip */ }

  return xml;
}

// Replace blank patterns like "sur environ__________pieds"
function replaceBlankFields(xml, soumission) {
  const s = soumission;

  // Surface: "__________pieds carrés" or "_____ square feet"
  if (s.superficie_pc) {
    xml = xml.replace(/environ_+pieds/g, `environ ${escapeXml(String(s.superficie_pc))} pieds`);
    xml = xml.replace(/approximately_+square/g, `approximately ${escapeXml(String(s.superficie_pc))} square`);
    // Also handle when __________ is separate
    xml = xml.replace(/_+(?=\s*pieds carr)/g, escapeXml(String(s.superficie_pc)));
    xml = xml.replace(/_+(?=\s*square fee)/g, escapeXml(String(s.superficie_pc)));
  }

  // Isolant épaisseur
  if (s.epaisseur_isolant) {
    xml = xml.replace(/_+(?=['']+'?\s*d['']isolant)/g, escapeXml(s.epaisseur_isolant));
    xml = xml.replace(/_+(?=['']+'?\s*of\s)/g, escapeXml(s.epaisseur_isolant));
  }

  // Drains
  if (s.nb_drains) {
    xml = xml.replace(/installer_+nouveaux drains/g, `installer ${s.nb_drains} nouveaux drains`);
    xml = xml.replace(/install_+new drains/g, `install ${s.nb_drains} new drains`);
  }

  // Manchons évents
  if (s.nb_manchons_events) {
    xml = xml.replace(/installer_+nouveaux manchons d/g, `installer ${s.nb_manchons_events} nouveaux manchons d`);
    xml = xml.replace(/install_+new plumbing/g, `install ${s.nb_manchons_events} new plumbing`);
  }

  // Manchons étanchéité
  if (s.nb_manchons_etancheite) {
    xml = xml.replace(/installer_+nouveaux manchons d'étanchéité/g, `installer ${s.nb_manchons_etancheite} nouveaux manchons d'étanchéité`);
  }

  // Cols de cygne
  if (s.nb_cols_cygne) {
    xml = xml.replace(/installer\s*_+\s*cols de cygne/g, `installer ${s.nb_cols_cygne} cols de cygne`);
  }

  // Ventilateur Maximum
  if (s.ventilateur_max) {
    xml = xml.replace(/#_+\./g, `#${escapeXml(s.ventilateur_max)}.`);
    xml = xml.replace(/#_+/g, `#${escapeXml(s.ventilateur_max)}`);
  }

  // Coût remplacement contreplaqués
  if (s.cout_remplacement_cp) {
    xml = xml.replace(/\$_+\/\s*pied carré/g, `$${escapeXml(s.cout_remplacement_cp)}/ pied carré`);
    xml = xml.replace(/\$_+\/\s*square foot/g, `$${escapeXml(s.cout_remplacement_cp)}/ square foot`);
  }

  // Pontage selection (keep only selected, remove alternatives)
  if (s.pontage) {
    const pontageMap = {
      'bois': 'bois', 'acier': 'acier', 'béton': 'béton', 'beton': 'béton',
      'siporex': 'siporex', 'wood': 'wood', 'steel': 'steel', 'concrete': 'concrete'
    };
    const selected = pontageMap[s.pontage.toLowerCase()] || s.pontage;
    // Simple approach: replace "bois / acier / béton" with selected value
    xml = xml.replace(/bois\s*\/\s*acier\s*\/\s*béton\s*\/?\s*siporex?/gi, escapeXml(selected));
    xml = xml.replace(/bois\s*\/\s*acier\s*\/\s*béton/gi, escapeXml(selected));
    xml = xml.replace(/wood\s*\/\s*steel\s*\/\s*concrete/gi, escapeXml(selected));
  }

  return xml;
}

async function generateSoumission(soumission) {
  const templateKey = selectTemplate(soumission.systeme_toiture, soumission.type_travaux);
  if (!templateKey) {
    throw new Error(`Aucun template trouvé pour: ${soumission.systeme_toiture} / ${soumission.type_travaux}`);
  }

  const templateFile = getTemplateFile(templateKey, soumission.langue);
  const templatePath = path.join(TEMPLATES_DIR, templateFile);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template introuvable: ${templatePath}`);
  }

  const zipData = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(zipData);

  const docXml = await zip.file('word/document.xml').async('string');
  let modifiedXml = docXml;

  // Apply named replacements
  const replacements = buildReplacements(soumission);
  for (const { pattern, value } of replacements) {
    modifiedXml = replaceInXml(modifiedXml, pattern, value);
  }

  // Replace address field
  if (soumission.client_adresse) {
    modifiedXml = replaceInXml(modifiedXml, 'Adresse', soumission.client_adresse);
    modifiedXml = replaceInXml(modifiedXml, 'Address', soumission.client_adresse);
  }

  // Apply blank field replacements (on raw XML text content)
  modifiedXml = replaceBlankFields(modifiedXml, soumission);

  // Also try replacements on text nodes within XML (handles split runs)
  modifiedXml = modifiedXml.replace(/>_+</g, (match) => {
    return match; // preserve underscores for unfilled fields
  });

  // Superficie in header
  if (soumission.superficie_pc) {
    modifiedXml = replaceInXml(modifiedXml, 'superficie', `${soumission.superficie_pc} pi²`);
  }

  zip.file('word/document.xml', modifiedXml);

  const outputDir = path.join(__dirname, '../../uploads/soumissions');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeNumero = (soumission.numero || 'DRAFT').replace(/[^a-zA-Z0-9-]/g, '_');
  const outputFilename = `Soumission_${safeNumero}_${Date.now()}.docx`;
  const outputPath = path.join(outputDir, outputFilename);

  const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(outputPath, outputBuffer);

  return {
    filename: outputFilename,
    filepath: outputPath,
    templateUsed: templateFile,
    templateKey
  };
}

function listTemplates() {
  return Object.entries(TEMPLATE_MAP).map(([key, files]) => ({
    key,
    label: key.replace(/_/g, ' '),
    fileFr: files.fr,
    fileEn: files.en,
    existsFr: fs.existsSync(path.join(TEMPLATES_DIR, files.fr)),
    existsEn: fs.existsSync(path.join(TEMPLATES_DIR, files.en)),
  }));
}

module.exports = { generateSoumission, listTemplates, selectTemplate, getTemplateFile, TEMPLATE_MAP };
