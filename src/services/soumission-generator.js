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

    // Prix (U+00A0 = espace insécable utilisé par Word entre 100 et 000)
    { pattern: '100 000$', value: s.prix_total ? `${Number(s.prix_total).toLocaleString('fr-CA')}$` : '______$' },
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

function normalizeXmlText(xml) {
  // Fusionne les <w:t> adjacents dans le même run ou entre runs consécutifs
  // avant les remplacements regex pour que les patterns fragmentés soient trouvés
  // Pattern: </w:t></w:r><w:r><w:t> ou </w:t></w:r><w:r [attrs]><w:t [attrs]>
  // On garde le formatage du premier run
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

function replaceBlankFields(xml, soumission) {
  const s = soumission;
  const BLANK = '______';

  // Normaliser le XML pour fusionner les text runs fragmentés (2 passes)
  xml = normalizeXmlText(xml);
  // Passe supplémentaire : supprimer les proofErr qui cassent les remplacements
  xml = xml.replace(/<w:proofErr[^/]*\/>/g, '');
  xml = normalizeXmlText(xml);

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

  // Pente isolant — résoudre le choix slash
  if (s.pente_isolant) {
    const pente = escapeXml(s.pente_isolant);
    xml = xml.replace(/pente 1% \/ 2%/g, `pente ${pente}`);
    xml = xml.replace(/pente\s+\d+%\s*\/\s*\d+%/g, `pente ${pente}`);
    xml = xml.replace(/sloped 1% \/ 2%/g, `sloped ${pente}`);
  }

  // === RÉSOLUTION DES CHOIX SLASH (comme les étapes manuelles) ===

  // Isolant type : polyisocyanurate/ polystyrène → choix unique
  if (s.type_isolant) {
    const isolType = escapeXml(s.type_isolant);
    xml = xml.replace(/polyisocyanurate\s*\/\s*polystyr[èe]ne/gi, isolType);
    xml = xml.replace(/polyisocyanurate\s*\/\s*polystyrene/gi, isolType);
  }

  // Méthode d'adhésion : adhéré avec de l'asphalte / fixé mécaniquement → choix unique
  if (s.methode_adhesion) {
    const meth = s.methode_adhesion.toLowerCase();
    if (meth.includes('asphalte') || meth.includes('asphalt')) {
      xml = xml.replace(/adhéré avec de l'asphalte\s*\/\s*fixé mécaniquement/gi, "adhéré avec de l'asphalte");
      xml = xml.replace(/adhéré avec de l'asphalte chaud\s*\/\s*fixé mécaniquement/gi, "adhéré avec de l'asphalte chaud");
      xml = xml.replace(/adhéré à l'asphalte\s*\/\s*fixé mécaniquement/gi, "adhéré à l'asphalte");
    } else if (meth.includes('méca') || meth.includes('meca')) {
      xml = xml.replace(/adhéré avec de l'asphalte\s*\/\s*fixé mécaniquement/gi, 'fixé mécaniquement');
      xml = xml.replace(/adhéré avec de l'asphalte chaud\s*\/\s*fixé mécaniquement/gi, 'fixé mécaniquement');
      xml = xml.replace(/adhéré à l'asphalte\s*\/\s*fixé mécaniquement/gi, 'fixé mécaniquement');
    } else if (meth.includes('adhésif') || meth.includes('adhesif')) {
      xml = xml.replace(/adhéré à l'adhésif\s*\/\s*(?:un pare-vapeur|fixé|thermosoudé)[^;]*/gi, "adhéré à l'adhésif");
    }
  }

  // Pare-vapeur : choix entre 3 options slash
  if (s.type_pare_vapeur) {
    const pv = escapeXml(s.type_pare_vapeur);
    // FR: "un pare-vapeur de papier kraft adhéré à l'adhésif / un pare-vapeur élastomère thermosoudée... / 2 plis de feutre #15 adhéré à l'asphalte"
    xml = xml.replace(/un pare-vapeur de papier kraft adhéré à l'adhésif\s*\/\s*un pare-vapeur élastomère thermosoudée[^/]*\/\s*2 plis de feutre #15 adhéré à l'asphalte/gi, pv);
    // Variante plus courte
    xml = xml.replace(/un pare-vapeur de papier kraft[^/]*\/[^/]*élastomère[^/]*\/[^;]*/gi, pv);
  }

  // Fibre de bois / perlite → choix unique (BUR)
  if (s.type_fibre) {
    const fibre = escapeXml(s.type_fibre);
    xml = xml.replace(/fibre de bois\s*\/\s*perlite/gi, fibre);
    xml = xml.replace(/wood fibre\s*\/\s*perlite/gi, fibre);
  }

  // Épaisseur fibre de bois (BUR)
  if (s.epaisseur_fibre_bois) {
    const efb = escapeXml(s.epaisseur_fibre_bois);
    xml = xml.replace(/_+(?="\s*de fibre)/g, efb);
    xml = xml.replace(/_+(?="\s*de perlite)/g, efb);
    xml = xml.replace(/_+(?=\s*Roofboard)/gi, efb);
  }

  // Nombre de plis (BUR) : (4-5) → choix
  if (s.nb_plis) {
    const plis = escapeXml(s.nb_plis);
    xml = xml.replace(/\(4-5\)/g, `(${plis})`);
    xml = xml.replace(/\(4 - 5\)/g, `(${plis})`);
  }

  // Membrane finition BUR : 4-5 plis feutre... / deux (2) plis élastomères
  if (s.type_membrane_finition) {
    const memb = s.type_membrane_finition.toLowerCase();
    if (memb.includes('feutre') || memb.includes('asphalte') || memb.includes('gravier')) {
      // Garder la première option (BUR classique), supprimer la deuxième
      xml = xml.replace(/plis de papier feutre # ?15[^/]*\/\s*deux \(2\) plis de membranes élastomères[^;]*/gi,
        (match) => match.split('/')[0].trim());
    } else if (memb.includes('élastomère') || memb.includes('elastomere')) {
      xml = xml.replace(/\(4-5\) plis de papier feutre[^/]*\/\s*/gi, '');
    }
  }

  // Gravier BUR : standard OU réfléchissant
  if (s.type_gravier) {
    const grav = s.type_gravier.toLowerCase();
    if (grav.includes('blanc') || grav.includes('réfléchiss') || grav.includes('650')) {
      xml = xml.replace(/gravier ¼[''"]?\s*standard[^/]*\/\s*100 pieds carrés\s*OU\s*/gi, '');
    } else {
      xml = xml.replace(/\s*OU gravier ¼[''"]?\s*réfléchissantes[^;]*/gi, '');
    }
  }

  // Relevés BUR : papier feutre / élastomères
  if (s.type_releves) {
    const rel = escapeXml(s.type_releves);
    // SOPRASMART: contreplaqué / asphaltique
    xml = xml.replace(new RegExp(`contreplaqué\\s+½${CURLY_APOS}${CURLY_APOS}\\s*/\\s*asphaltique\\s+½${CURLY_APOS}${CURLY_APOS}`, 'g'), rel);
    xml = xml.replace(/contreplaqué\s+½['']{1,2}\s*\/\s*asphaltique\s+½['']{1,2}/gi, rel);
    xml = xml.replace(/plywood\s+½['']{1,2}\s*\/\s*asphalt\s+½['']{1,2}/gi, rel);
    // BUR: papier feutre / élastomères
    xml = xml.replace(/papier feutre # ?15,?\s*coton saturé[^/]*\/\s*deux \(2\) plis de membranes élastomères[^;]*/gi, rel);
  }

  // Solins matériau : acier prépeint / acier galvanisé / cuivre 16oz
  if (s.materiau_solins) {
    const mat = escapeXml(s.materiau_solins);
    xml = xml.replace(/acier prépeint\s*\/?\s*acier galvanisé/gi, mat);
    xml = xml.replace(/acier pr[ée]peint\s*\/\s*acier galvanis[ée]/gi, mat);
  }
  if (s.calibre_solins) {
    const cal = escapeXml(s.calibre_solins);
    xml = xml.replace(/calibre 26 ou 24/gi, `calibre ${cal}`);
    xml = xml.replace(/calibre 26\s*\/\s*24/gi, `calibre ${cal}`);
  }
  // cuivre 16oz option
  if (s.materiau_solins && !s.materiau_solins.toLowerCase().includes('cuivre')) {
    xml = xml.replace(/\s*\/\s*cuivre 16\s*oz/gi, '');
  }

  // Cols de cygne : existant / Ventilateur Maximum
  if (s.cols_cygne_type) {
    const cct = s.cols_cygne_type.toLowerCase();
    if (cct.includes('existant')) {
      xml = xml.replace(/cols de cygne tel qu'existant\s*\/\s*Ventilateur Maximum #[_]*/gi, 'cols de cygne tel qu\'existant');
      xml = xml.replace(/cols de cygne tel qu[''']existant\s*\/\s*Ventilateur Maximum[^.]*/gi, "cols de cygne tel qu'existant");
    } else if (cct.includes('ventilateur')) {
      const ventNum = s.ventilateur_max ? escapeXml(s.ventilateur_max) : BLANK;
      xml = xml.replace(/cols de cygne tel qu[''']existant\s*\/\s*/gi, '');
    }
  }

  // Pontage
  if (s.pontage) {
    const pontageMap = {
      'bois': 'bois', 'acier': 'acier', 'béton': 'béton', 'beton': 'béton',
      'siporex': 'siporex', 'wood': 'wood', 'steel': 'steel', 'concrete': 'concrete'
    };
    const selected = pontageMap[s.pontage.toLowerCase()] || s.pontage;
    // Slash résolution : bois / acier / béton / siporex → valeur unique
    xml = xml.replace(/bois\s*\/\s*acier\s*(?:\/\s*de\s+)?(?:et\s+de\s+)?béton\s*\/?\s*siporex?/gi, escapeXml(selected));
    xml = xml.replace(/bois\s*\/\s*acier\s*\/\s*béton\s*\/?\s*siporex?/gi, escapeXml(selected));
    xml = xml.replace(/bois\s*\/\s*acier\s*\/\s*béton/gi, escapeXml(selected));
    xml = xml.replace(/wood\s*\/\s*steel\s*\/\s*concrete\s*\/?\s*syporex?/gi, escapeXml(selected));
    xml = xml.replace(/wood\s*\/\s*steel\s*\/\s*concrete/gi, escapeXml(selected));
    // Aussi dans “pontage d'acier et de béton” → ne pas toucher si c'est descriptif
  }

  // Coupe-vapeur / syporex / autre → choix selon pontage
  if (s.pontage) {
    const pontVal = s.pontage.toLowerCase();
    if (pontVal === 'acier' || pontVal === 'steel') {
      xml = xml.replace(/\/\s*syporex\s*\/\s*coupe-vapeur\s*existant/gi, '');
    }
  }

  // Drains — utiliser replaceInXml car le texte est splitté entre runs XML
  const drains = s.nb_drains || 'les';
  xml = replaceInXml(xml, 'installer__________nouveaux drains', `installer ${drains} nouveaux drains`);
  xml = replaceInXml(xml, 'install__________new drains', `install ${drains} new drains`);
  xml = xml.replace(/_+(?=\s*nouveaux drains)/g, drains);
  xml = xml.replace(/_+(?=\s*new rigid copper)/g, drains);

  // Manchons évents — même problème de split XML
  const events = s.nb_manchons_events || 'les';
  xml = replaceInXml(xml, `installer__________nouveaux manchons d${CURLY_APOS}évents`, `installer ${events} nouveaux manchons d${CURLY_APOS}évents`);
  xml = replaceInXml(xml, `installer__________nouveaux manchons`, `installer ${events} nouveaux manchons`);
  xml = xml.replace(/_+(?=\s*nouveaux manchons\s*d['’]évents)/g, events);
  xml = xml.replace(/_+(?=\s*new aluminum plumbing)/g, events);

  // Manchons étanchéité
  const etanch = s.nb_manchons_etancheite || 'les';
  xml = replaceInXml(xml, `installer__________nouveaux manchons d${CURLY_APOS}étanchéité`, `installer ${etanch} nouveaux manchons d${CURLY_APOS}étanchéité`);
  xml = xml.replace(/_+(?=\s*nouveaux manchons\s*d['’]étanch)/g, etanch);
  xml = xml.replace(/_+(?=\s*new Chem-Curbs)/g, etanch);

  // Cols de cygne
  const cols = s.nb_cols_cygne || 'les';
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

  // Documents reçus: “le ______ pour soumission”
  xml = xml.replace(/_+(?=\s*pour soumission)/g, s.documents_recus ? escapeXml(s.documents_recus) : BLANK);

  // “spécifier type toiture” → remplacer par le système choisi ou enlever
  const systLabel = s.systeme_toiture ? escapeXml(s.systeme_toiture.replace(/_/g, ' ')) : '';
  xml = xml.replace(/sp[ée]cifier type toiture/gi, systLabel);
  xml = xml.replace(/specified? which type/gi, systLabel);

  // Fibre de bois épaisseur
  xml = xml.replace(/_+(?=”\s*de fibre)/g, ep);
  xml = xml.replace(/_+(?=\s*Roofboard)/gi, ep);

  // === CORRECTION ENCODAGE (comme l'étape 8 manuelle) ===
  xml = xml.replace(/mÉtalliques/g, 'métalliques');
  xml = xml.replace(/prÉpeint/g, 'prépeint');
  xml = xml.replace(/RÉfection/g, 'Réfection');
  xml = xml.replace(/MontrÉal/g, 'Montréal');

  // Nettoyer les underscores restants (3-14 chars) qui n'ont pas été remplis
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

  // Appliquer les remplacements à TOUS les fichiers XML (document + headers + footers)
  const xmlFiles = Object.keys(zip.files).filter(f =>
    f.startsWith('word/') && f.endsWith('.xml') &&
    !f.includes('/_rels/') && !f.includes('/theme/') &&
    !f.includes('settings') && !f.includes('styles') &&
    !f.includes('fontTable') && !f.includes('numbering') &&
    !f.includes('webSettings') && !f.includes('glossary/')
  );

  const replacements = buildReplacements(soumission);

  for (const xmlFile of xmlFiles) {
    const entry = zip.file(xmlFile);
    if (!entry) continue;
    let xml = await entry.async('string');
    let changed = false;

    // Normaliser les runs XML pour tous les fichiers (headers inclus)
    const beforeNorm = xml;
    xml = normalizeXmlText(xml);
    if (xml !== beforeNorm) changed = true;

    for (const { pattern, value } of replacements) {
      const before = xml;
      xml = replaceInXml(xml, pattern, value);
      if (xml !== before) changed = true;
    }

    // Correction encodage dans TOUS les fichiers XML (headers + footers + document)
    const beforeEnc = xml;
    xml = xml.replace(/mÉtalliques/g, 'métalliques');
    xml = xml.replace(/prÉpeint/g, 'prépeint');
    xml = xml.replace(/RÉfection/g, 'Réfection');
    xml = xml.replace(/MontrÉal/g, 'Montréal');
    if (xml !== beforeEnc) changed = true;

    if (xmlFile === 'word/document.xml') {
      xml = replaceFirstInXml(xml, 'Adresse', soumission.client_adresse || '______');
      xml = replaceFirstInXml(xml, 'Address', soumission.client_adresse || '______');
      xml = replaceBlankFields(xml, soumission);
      xml = replaceFirstInXml(xml, 'superficie', soumission.superficie_pc ? `${soumission.superficie_pc} pi²` : '______ pi²');
      changed = true;
    }

    if (changed) zip.file(xmlFile, xml);
  }

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
