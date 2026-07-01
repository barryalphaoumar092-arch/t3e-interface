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
    return { xml, trouve: true };
  }
  return { xml, trouve: false };
}

// Fallback pour les bordereaux dont les libellés ne correspondent à aucune des
// variantes connues (gabarits d'architectes tiers) : demande à l'IA où insérer
// chaque champ restant, en se basant sur les textes réellement présents dans
// CE document plutôt que sur une liste fixe de libellés attendus.
async function placerChampsRestantsViaIA(xml, champsNonTrouves) {
  const { isConfigured, mapperChampsBordereau } = require('./claude-client');
  if (!isConfigured() || Object.keys(champsNonTrouves).length === 0) return xml;

  const runRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  const runs = [];
  const positions = [];
  let m;
  while ((m = runRegex.exec(xml))) {
    const texte = m[1].trim();
    if (!texte) continue;
    runs.push(texte);
    positions.push(m.index + m[0].length - '</w:t>'.length);
  }
  if (runs.length === 0 || runs.length > 400) return xml;

  let mapping;
  try {
    mapping = await mapperChampsBordereau(runs, champsNonTrouves);
  } catch (e) {
    console.error('[bordereau-filler] Mapping IA échoué:', e.message);
    return xml;
  }
  if (!mapping) return xml;

  // Plusieurs champs peuvent partager le même libellé combiné (ex: "Devis
  // (section et article)" pour SECTION + ARTICLE) — on les regroupe pour ne
  // faire qu'une seule insertion par run.
  const valeursParRun = {};
  for (const [champ, idxRun] of Object.entries(mapping)) {
    if (idxRun === null || idxRun === undefined || !runs[idxRun]) continue;
    if (!champsNonTrouves[champ]) continue;
    (valeursParRun[idxRun] = valeursParRun[idxRun] || []).push(champsNonTrouves[champ]);
  }

  // Insertion en partant de la fin du document pour ne pas décaler les
  // positions déjà calculées pour les runs précédents.
  const indices = Object.keys(valeursParRun).map(Number).sort((a, b) => b - a);
  for (const idx of indices) {
    const valeur = ' ' + escapeXml(valeursParRun[idx].join(' / '));
    const pos = positions[idx];
    xml = xml.substring(0, pos) + valeur + xml.substring(pos);
  }
  return xml;
}

// Coche la case à cocher Word (legacy FORMCHECKBOX) la plus proche d'un
// libellé donné. Généralisé pour fonctionner sur n'importe quel gabarit de
// bordereau : selon le document, la case peut être placée AVANT ou APRÈS le
// libellé (le template T3E la met après, d'autres gabarits d'architectes
// avant), donc on cherche le champ <w:ffData> avec <w:checkBox> le plus
// proche du libellé dans les deux directions plutôt que de supposer un ordre.
function cocherCaseACocher(xml, label) {
  const labelMatch = xml.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  if (!labelMatch) return xml;
  const labelIdx = labelMatch.index;

  const ffDataRegex = /<w:ffData>[\s\S]*?<\/w:ffData>/g;
  let champ = null;
  let meilleureDistance = Infinity;
  let m;
  while ((m = ffDataRegex.exec(xml))) {
    if (!m[0].includes('<w:checkBox')) continue;
    const distance = Math.abs(m.index - labelIdx);
    if (distance < meilleureDistance && distance < 1500) {
      meilleureDistance = distance;
      champ = { ffStart: m.index, ffEnd: m.index + m[0].length, ffXml: m[0] };
    }
  }
  if (!champ) return xml;

  // Bornes du champ : du "begin" de CE checkbox jusqu'au prochain "begin"
  // (ou fin de document), pour ne jamais déborder sur un autre champ voisin.
  const prochainBegin = xml.indexOf('fldCharType="begin"', champ.ffEnd);
  const limite = prochainBegin === -1 ? xml.length : prochainBegin;
  const sepIdx = xml.indexOf('fldCharType="separate"', champ.ffEnd);

  // 1. Rendu visuel : insérer ☒ juste après le run "separate" (position la
  // plus tardive dans le document → appliqué en premier pour ne pas décaler
  // la position du <w:ffData>, traité ensuite).
  if (sepIdx !== -1 && sepIdx < limite) {
    const finRunSepIdx = xml.indexOf('</w:r>', sepIdx);
    if (finRunSepIdx !== -1) {
      const insertPos = finRunSepIdx + '</w:r>'.length;
      const dejaCoche = xml.substring(insertPos, Math.min(insertPos + 40, limite)).includes('☒');
      if (!dejaCoche) {
        xml = xml.substring(0, insertPos) + '<w:r><w:t>☒</w:t></w:r>' + xml.substring(insertPos);
      }
    }
  }

  // 2. Coché par défaut (au cas où Word recalcule le champ)
  if (!champ.ffXml.includes('w:default w:val="1"')) {
    const patched = /<w:default[^/]*\/>/.test(champ.ffXml)
      ? champ.ffXml.replace(/<w:default[^/]*\/>/, '<w:default w:val="1"/>')
      : champ.ffXml.replace('<w:checkBox>', '<w:checkBox><w:default w:val="1"/>');
    xml = xml.substring(0, champ.ffStart) + patched + xml.substring(champ.ffEnd);
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
  xml = cocherCaseACocher(xml, 'Fiche technique');

  // Labels plus longs EN PREMIER pour eviter correspondances partielles
  const NBSP = ' ';
  const remplacements = [
    ['NOM_DU_PROJET',    'NOM DU PROJET' + NBSP + ':',      champs.NOM_DU_PROJET    || ''],
    ['NUMERO_DU_PROJET', 'NUMÉRO DU PROJET' + NBSP + ':', champs.NUMERO_DU_PROJET || ''],
    ['SPECIALITE',       'SPÉCIALITÉ' + NBSP + ':', champs.SPECIALITE     || 'COUVREUR'],
    ['ADRESSE',          'ADRESSE' + NBSP + ':',             champs.ADRESSE          || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1'],
    ['NOM',              'NOM' + NBSP + ':',                 champs.NOM              || 'Toitures Trois Étoiles'],
    ['TITRE',            'Titre' + NBSP + ':',               champs.TITRE            || ''],
    ['DESSINS',          'Numéro de dessins' + NBSP + ':', ''],
    ['FEUILLES',         'Nombre feuilles' + NBSP + ':',     ''],
    ['REVISION',         'Révision' + NBSP + ':',       ''],
    ['DESCRIPTION',      'Description' + NBSP + ':',         champs.DESCRIPTION      || ''],
    ['FOURNISSEUR',      'Fournisseur' + NBSP + ':',         champs.FOURNISSEUR      || ''],
    ['FABRICANT',        'Fabricant' + NBSP + ':',           champs.FABRICANT        || ''],
    ['SECTION',          'Section (item)' + NBSP + ':',      champs.SECTION          || ''],
    ['ARTICLE',          'Article' + NBSP + ':',             champs.ARTICLE          || ''],
    ['DELAI',            'Délai' + NBSP + ':',          ''],
    ['REMARQUE',         'Remarque' + NBSP + ':',            champs.REMARQUE         || ''],
  ];

  const champsNonTrouves = {};
  for (const [champKey, label, valeur] of remplacements) {
    const resultat = remplirChampDansXml(xml, label, valeur);
    xml = resultat.xml;
    if (!resultat.trouve && valeur) champsNonTrouves[champKey] = valeur;
  }

  if (Object.keys(champsNonTrouves).length > 0) {
    console.log('[bordereau-filler] Libellés non trouvés, tentative IA pour:', Object.keys(champsNonTrouves).join(', '));
    xml = await placerChampsRestantsViaIA(xml, champsNonTrouves);
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { remplirBordereau };
