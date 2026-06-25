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
  if (!systeme) return null;
  const key = `${systeme}_${type_travaux}`.toUpperCase();
  if (TEMPLATE_MAP[key]) return key;

  // Essayer sans type_travaux pour les templates sans variante (ANCESTRAL, TPO_PVC_RHINOBOND)
  if (TEMPLATE_MAP[systeme.toUpperCase()]) return systeme.toUpperCase();

  // Fallback: chercher par système, en privilégiant le bon type_travaux
  const candidates = Object.keys(TEMPLATE_MAP).filter(k => k.includes(systeme.toUpperCase()));
  if (candidates.length === 0) return null;

  const withType = candidates.find(k => k.includes((type_travaux || '').toUpperCase()));
  return withType || candidates[0];
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

function formatDateShortFr() {
  const now = new Date();
  const moisFr = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  return `${now.getDate()} ${moisFr[now.getMonth()]} ${now.getFullYear()}`;
}

function formatDateShortEn() {
  const now = new Date();
  const moisEn = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${moisEn[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}

function formatDateIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function escapeXml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildReplacements(soumission) {
  const s = soumission;
  const dateFull = formatDate(s.langue);
  const dateNoCity = dateFull.replace(/^Montréal, |^Montreal, /, '');
  const dateShortFr = formatDateShortFr();
  const dateShortEn = formatDateShortEn();
  const dateIso = formatDateIso();

  const garantieT3eText = s.garantie_t3e || '5 ans';
  const garantieManufText = s.garantie_manufacturier || '10 ans';
  const garantieT3eNum = parseInt(garantieT3eText) || 5;
  const garantieManufNum = parseInt(garantieManufText) || 10;
  const garantieT3eWords = { 5: 'cinq', 10: 'dix', 15: 'quinze', 20: 'vingt' };
  const garantieT3eWord = garantieT3eWords[garantieT3eNum] || String(garantieT3eNum);

  return [
    { pattern: '#SOUMISSION', value: s.numero || '______' },
    { pattern: 'NOM DU PROJET ET CLIENT', value: s.projet_nom ? `${s.projet_nom} - ${s.client_nom}` : s.client_nom || '______' },
    { pattern: 'NOM DU CLIENT', value: s.client_nom || '______' },

    // Dates FR - header (Word TIME field display text)
    { pattern: 'mardi, 1er octobre 2024', value: dateNoCity },
    { pattern: '1er octobre 2024', value: dateShortFr },

    // Dates EN - header
    { pattern: 'Friday, February 23, 2024', value: dateNoCity },
    { pattern: 'October 1, 2024', value: dateShortEn },
    { pattern: '2024-10-01', value: dateIso },
    // Date patterns with other possible formats in templates
    { pattern: '2024-01-10', value: dateIso },

    // Adresse / ville
    { pattern: 'Ville, Province, Code Postal', value: [s.client_ville, s.client_province, s.client_code_postal].filter(Boolean).join(', ') || '______' },
    { pattern: 'City, Province, Postal Code', value: [s.client_ville, s.client_province, s.client_code_postal].filter(Boolean).join(', ') || '______' },

    // Contact
    { pattern: 'Nom représentant du client', value: s.client_contact || '______' },
    { pattern: "Client's representative name", value: s.client_contact || '______' },

    // Téléphone / courriel
    { pattern: '000-000-0000', value: s.client_telephone || '______' },
    { pattern: 'courriel@courriel.ca', value: s.client_courriel || '______' },
    { pattern: 'email@email.ca', value: s.client_courriel || '______' },

    // Prix
    { pattern: '100 000$', value: s.prix_total ? `${Number(s.prix_total).toLocaleString('fr-CA')}$` : '______$' },
    { pattern: '$100,000', value: s.prix_total ? `$${Number(s.prix_total).toLocaleString('en-CA')}` : '$______' },

    // Garanties FR
    { pattern: `cinq (5) ans par Toitures Trois Étoiles Inc. / dix (10) ans par le manufacturier`,
      value: `${garantieT3eWord} (${garantieT3eNum}) ans par Toitures Trois Étoiles Inc. / ${garantieManufNum} ans par le manufacturier` },
    // Garantie section annexe FR
    { pattern: '5  (cinq)', value: `${garantieT3eNum}  (${garantieT3eWord})` },

    // Garanties EN
    { pattern: '5-year Toitures Trois Étoiles inc / 10 year manufacturer warranty',
      value: `${garantieT3eNum}-year Toitures Trois Étoiles inc / ${garantieManufNum} year manufacturer warranty` },
    { pattern: '5 (five) year warranty', value: `${garantieT3eNum} (${garantieT3eWord}) year warranty` },

    // Exclusions FR
    { pattern: 'Insérer ici vos exclusions spécifiques aux projets',
      value: s.exclusions_specifiques || 'Aucune exclusion spécifique' },
    // Exclusions EN
    { pattern: 'Please insert your specifics exclusions here',
      value: s.exclusions_specifiques || 'No specific exclusions' },
  ];
}

function replaceInXml(xml, pattern, value) {
  const escaped = escapeXml(pattern);
  const safeValue = escapeXml(value);

  if (xml.includes(escaped)) {
    return xml.split(escaped).join(safeValue);
  }

  const chars = escaped.split('');
  let regex = chars.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:<[^>]*>)*');
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
  } catch(e) { /* regex too complex, skip */ }

  return xml;
}

function replaceFirstInXml(xml, pattern, value) {
  const escaped = escapeXml(pattern);
  const safeValue = escapeXml(value);
  const idx = xml.indexOf(escaped);
  if (idx !== -1) {
    return xml.substring(0, idx) + safeValue + xml.substring(idx + escaped.length);
  }
  return xml;
}

const CURLY_APOS = String.fromCharCode(0x2019);

function replaceBlankFields(xml, soumission) {
  const s = soumission;
  const BLANK = '______';

  // Surface
  const sup = s.superficie_pc ? escapeXml(String(s.superficie_pc)) : BLANK;
  xml = xml.replace(/environ_+pieds/g, `environ ${sup} pieds`);
  xml = xml.replace(/approximately_+square/g, `approximately ${sup} square`);
  xml = xml.replace(/_+(?=\s*pieds carr)/g, sup);
  xml = xml.replace(/_+(?=\s*square fee)/g, sup);

  // Épaisseur isolant (curly apostrophe U+2019)
  const ep = s.epaisseur_isolant ? escapeXml(s.epaisseur_isolant) : BLANK;
  const regex1 = new RegExp(`_+(?=[${CURLY_APOS}'''””]+\\s*d[${CURLY_APOS}']isolant)`, 'g');
  xml = xml.replace(regex1, ep);
  const regex2 = new RegExp(`_+(?=[${CURLY_APOS}'''””]+\\s*of\\s)`, 'g');
  xml = xml.replace(regex2, ep);
  xml = xml.replace(/_+(?=\s*Polyiso)/gi, ep);

  // Pente isolant
  if (s.pente_isolant) {
    const pente = escapeXml(s.pente_isolant);
    xml = xml.replace(/pente 1% \/ 2%/g, `pente ${pente}`);
    xml = xml.replace(/sloped 1% \/ 2%/g, `sloped ${pente}`);
  }

  // Drains
  const drains = s.nb_drains || BLANK;
  xml = xml.replace(/_+(?=\s*nouveaux drains)/g, drains);
  xml = xml.replace(/_+(?=\s*new rigid copper)/g, drains);

  // Manchons évents
  const events = s.nb_manchons_events || BLANK;
  const reEvents = new RegExp(`_+(?=\\s*nouveaux manchons d[${CURLY_APOS}']évents)`, 'g');
  xml = xml.replace(reEvents, events);
  xml = xml.replace(/_+(?=\s*new aluminum plumbing)/g, events);

  // Manchons étanchéité — DISTINCT from évents
  const etanch = s.nb_manchons_etancheite || BLANK;
  const reEtanch = new RegExp(`_+(?=\\s*nouveaux manchons d[${CURLY_APOS}']étanch)`, 'g');
  xml = xml.replace(reEtanch, etanch);
  xml = xml.replace(/_+(?=\s*new Chem-Curbs)/g, etanch);

  // Cols de cygne
  const cols = s.nb_cols_cygne || BLANK;
  xml = xml.replace(/_+(?=\s*cols de cygne)/g, cols);
  xml = xml.replace(/_+(?=\s*new gooseneck)/g, cols);

  // Ventilateur Maximum
  const vent = s.ventilateur_max ? escapeXml(s.ventilateur_max) : BLANK;
  xml = xml.replace(/#_+\./g, `#${vent}.`);
  xml = xml.replace(/#_+/g, `#${vent}`);

  // Coût remplacement — 1st = contreplaqué, 2nd = isolant
  let cpDone = false;
  xml = xml.replace(/\$_+\/?\s*(?:pied carré|per square foot)/g, (match) => {
    if (!cpDone) {
      cpDone = true;
      const val = s.cout_remplacement_cp || BLANK;
      return match.includes('per square') ? `$${escapeXml(val)} per square foot` : `$${escapeXml(val)}/ pied carré`;
    } else {
      const val = s.cout_remplacement_isolant || s.cout_remplacement_cp || BLANK;
      return match.includes('per square') ? `$${escapeXml(val)} per square foot` : `$${escapeXml(val)}/ pied carré`;
    }
  });

  // Pontage
  if (s.pontage) {
    const pontageMap = {
      'bois': 'bois', 'acier': 'acier', 'béton': 'béton', 'beton': 'béton',
      'siporex': 'siporex', 'wood': 'wood', 'steel': 'steel', 'concrete': 'concrete'
    };
    const selected = pontageMap[s.pontage.toLowerCase()] || s.pontage;
    xml = xml.replace(/bois\s*\/\s*acier\s*\/\s*béton\s*\/?\s*siporex?/gi, escapeXml(selected));
    xml = xml.replace(/bois\s*\/\s*acier\s*\/\s*béton/gi, escapeXml(selected));
    xml = xml.replace(/wood\s*\/\s*steel\s*\/\s*concrete\s*\/?\s*syporex?/gi, escapeXml(selected));
    xml = xml.replace(/wood\s*\/\s*steel\s*\/\s*concrete/gi, escapeXml(selected));
  }

  // Documents reçus: “le ______ pour soumission”
  xml = xml.replace(/_+(?=\s*pour soumission)/g, s.documents_recus ? escapeXml(s.documents_recus) : BLANK);

  // Fibre de bois épaisseur
  xml = xml.replace(/_+(?="\s*de fibre)/g, ep);
  xml = xml.replace(/_+(?=\s*Roofboard)/gi, ep);

  // Nettoyer les underscores restants (3+ consécutifs) qui n'ont pas été remplis
  // Garder les underscores de signature (>15 chars) intacts
  xml = xml.replace(/>_{3,14}</g, `>${BLANK}<`);

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

  const replacements = buildReplacements(soumission);
  for (const { pattern, value } of replacements) {
    modifiedXml = replaceInXml(modifiedXml, pattern, value);
  }

  modifiedXml = replaceFirstInXml(modifiedXml, 'Adresse', soumission.client_adresse || '______');
  modifiedXml = replaceFirstInXml(modifiedXml, 'Address', soumission.client_adresse || '______');

  modifiedXml = replaceBlankFields(modifiedXml, soumission);

  modifiedXml = replaceFirstInXml(modifiedXml, 'superficie', soumission.superficie_pc ? `${soumission.superficie_pc} pi²` : '______ pi²');

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
