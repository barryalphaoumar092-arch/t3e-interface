// Utilitaires partagés de manipulation du XML OOXML (word/document.xml) — extraits
// de bordereau-filler.js pour être réutilisés par manuel-filler.js (même logique
// de remplissage de gabarits Word par libellé "LIBELLÉ :").
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

// Certains gabarits (ex. architectes) placent le libellé et sa valeur dans
// DEUX cellules de tableau séparées : le libellé occupe sa propre cellule
// étroite, suivie d'une (ou plusieurs) cellule(s) dont celle portant une
// bordure pointillée est la zone de saisie prévue pour la valeur. Insérer
// directement dans le run du libellé (comme si libellé et valeur partageaient
// la même cellule, cas du gabarit T3E) fait alors déborder la cellule étroite
// et laisse la vraie zone de saisie vide — d'où le symptôme observé : gros
// espace vide + texte tronqué/empilé sur plusieurs lignes.
function resoudrePositionInsertion(xml, closeIdx) {
  const finCelluleLabel = xml.indexOf('</w:tc>', closeIdx);
  const celluleSeparee = finCelluleLabel !== -1
    && finCelluleLabel < closeIdx + 40
    && !/<w:t[ >]/.test(xml.substring(closeIdx, finCelluleLabel));

  if (celluleSeparee) {
    const posSaisie = trouverCelluleDeSaisie(xml, finCelluleLabel + '</w:tc>'.length);
    if (posSaisie !== -1) return { pos: posSaisie, inline: false };
  }
  return { pos: closeIdx, inline: true };
}

// Cherche, a partir de `depart`, la premiere cellule <w:tc> dont la bordure
// est pointillee (zone de saisie prevue par le gabarit) et retourne la
// position juste avant le </w:p> de son premier paragraphe.
function trouverCelluleDeSaisie(xml, depart) {
  const tcRegex = /<w:tc>|<w:tc\s[^>]*>/g;
  tcRegex.lastIndex = depart;
  let m;
  let tentatives = 0;
  while (tentatives < 6 && (m = tcRegex.exec(xml))) {
    tentatives++;
    const finCellule = xml.indexOf('</w:tc>', m.index);
    if (finCellule === -1) break;
    const debutParagraphe = xml.indexOf('<w:p', m.index);
    const entete = debutParagraphe !== -1 && debutParagraphe < finCellule
      ? xml.substring(m.index, debutParagraphe)
      : xml.substring(m.index, finCellule);
    if (/w:val="dotted"/.test(entete)) {
      const finPremierParagraphe = xml.indexOf('</w:p>', m.index);
      if (finPremierParagraphe !== -1 && finPremierParagraphe < finCellule) return finPremierParagraphe;
    }
    tcRegex.lastIndex = finCellule;
  }
  return -1;
}

function inserer(xml, pos, inline, valeur) {
  const texte = escapeXml(String(valeur));
  return inline
    ? xml.substring(0, pos) + ' ' + texte + xml.substring(pos)
    : xml.substring(0, pos) + `<w:r><w:t xml:space="preserve">${texte}</w:t></w:r>` + xml.substring(pos);
}

function remplirChampDansXml(xml, label, valeur) {
  for (const variant of labelVariants(label)) {
    const idx = xml.indexOf(variant);
    if (idx === -1) continue;

    const colonIdx = idx + variant.length - 1;
    const closeIdx = xml.indexOf('</w:t>', colonIdx);
    if (closeIdx === -1) continue;
    if (!valeur) return { xml, trouve: true };

    const { pos, inline } = resoudrePositionInsertion(xml, closeIdx);
    xml = inserer(xml, pos, inline, valeur);
    return { xml, trouve: true };
  }
  return { xml, trouve: false };
}

// Fallback pour les gabarits dont les libellés ne correspondent à aucune des
// variantes connues (gabarits tiers) : demande à l'IA où insérer chaque champ
// restant, en se basant sur les textes réellement présents dans CE document
// plutôt que sur une liste fixe de libellés attendus.
// Retourne { xml, restants } où `restants` contient les champs que même l'IA
// n'a pas pu placer (indisponible, échec d'appel, ou aucun index retourné) —
// permet à l'appelant de garantir qu'aucune valeur n'est perdue en silence.
async function placerChampsRestantsViaIA(xml, champsNonTrouves) {
  const { isConfigured, mapperChampsBordereau } = require('./claude-client');
  if (Object.keys(champsNonTrouves).length === 0) return { xml, restants: {} };
  if (!isConfigured()) {
    console.warn('[docx-xml-utils] OPENAI_API_KEY non configurée — fallback IA sauté pour:', Object.keys(champsNonTrouves).join(', '));
    return { xml, restants: { ...champsNonTrouves } };
  }

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
  if (runs.length === 0) return { xml, restants: { ...champsNonTrouves } };
  if (runs.length > 400) {
    console.warn(`[docx-xml-utils] Document trop volumineux pour le mapping IA (${runs.length} textes > 400) — champs non placés:`, Object.keys(champsNonTrouves).join(', '));
    return { xml, restants: { ...champsNonTrouves } };
  }

  let mapping;
  try {
    mapping = await mapperChampsBordereau(runs, champsNonTrouves);
  } catch (e) {
    console.error('[docx-xml-utils] Mapping IA échoué:', e.message);
    return { xml, restants: { ...champsNonTrouves } };
  }
  if (!mapping) {
    console.warn('[docx-xml-utils] Mapping IA n\'a retourné aucun résultat pour:', Object.keys(champsNonTrouves).join(', '));
    return { xml, restants: { ...champsNonTrouves } };
  }

  // Plusieurs champs peuvent partager le même libellé combiné (ex: "Devis
  // (section et article)" pour SECTION + ARTICLE) — on les regroupe pour ne
  // faire qu'une seule insertion par run.
  const valeursParRun = {};
  const restants = {};
  for (const champ of Object.keys(champsNonTrouves)) {
    const idxRun = mapping[champ];
    if (idxRun === null || idxRun === undefined || !runs[idxRun]) {
      restants[champ] = champsNonTrouves[champ];
      continue;
    }
    (valeursParRun[idxRun] = valeursParRun[idxRun] || []).push(champsNonTrouves[champ]);
  }
  if (Object.keys(restants).length > 0) {
    console.warn('[docx-xml-utils] IA n\'a pas trouvé d\'emplacement pour:', Object.keys(restants).join(', '));
  }

  // Insertion en partant de la fin du document pour ne pas décaler les
  // positions déjà calculées pour les runs précédents.
  const indices = Object.keys(valeursParRun).map(Number).sort((a, b) => b - a);
  for (const idx of indices) {
    const valeurTexte = valeursParRun[idx].join(' / ');
    const { pos, inline } = resoudrePositionInsertion(xml, positions[idx]);
    xml = inserer(xml, pos, inline, valeurTexte);
  }
  return { xml, restants };
}

// Dernier filet de sécurité : un champ qui a une valeur mais qu'on n'a réussi
// à placer nulle part (ni libellé exact, ni IA) ne doit JAMAIS disparaître en
// silence — peu importe la mise en page du gabarit soumis. On l'ajoute en
// texte visible juste avant la fin du corps du document.
// `nomsLisibles` : map optionnelle { CLE: 'Libellé humain' } pour l'affichage.
function ajouterChampsNonPlaces(xml, champsRestants, nomsLisibles = {}) {
  const entrees = Object.entries(champsRestants).filter(([, v]) => v);
  if (entrees.length === 0) return xml;

  const texte = 'Renseignements complémentaires — ' + entrees
    .map(([k, v]) => `${nomsLisibles[k] || k} : ${v}`)
    .join(' | ');

  const paragraphe = `<w:p><w:r><w:rPr><w:i/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">${escapeXml(texte)}</w:t></w:r></w:p>`;
  const bodyCloseIdx = xml.lastIndexOf('</w:body>');
  if (bodyCloseIdx === -1) return xml;
  // Inserer avant la derniere <w:sectPr> (proprietes de section, obligatoires
  // en fin de corps) plutot que juste avant </w:body> pour ne pas casser le
  // schema OOXML.
  const sectPrIdx = xml.lastIndexOf('<w:sectPr', bodyCloseIdx);
  const pos = sectPrIdx !== -1 ? sectPrIdx : bodyCloseIdx;
  return xml.substring(0, pos) + paragraphe + xml.substring(pos);
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
    if (distance >= 1500 || distance >= meilleureDistance) continue;
    // Ignorer les cases situees dans une AUTRE cellule de tableau que le
    // libelle : dans les gabarits a colonnes (une case par colonne, ex.
    // "Dessin d'atelier | Fiche technique | Echantillon"), la case la plus
    // proche en distance de caracteres brute peut appartenir a la colonne
    // voisine (ex. cocher "Echantillon" au lieu de "Fiche technique") des
    // qu'on traverse une frontiere </w:tc>.
    const debut = Math.min(m.index, labelIdx);
    const fin = Math.max(m.index, labelIdx);
    if (xml.substring(debut, fin).includes('</w:tc>')) continue;
    meilleureDistance = distance;
    champ = { ffStart: m.index, ffEnd: m.index + m[0].length, ffXml: m[0] };
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

module.exports = {
  escapeXml,
  normalizeXmlText,
  labelVariants,
  resoudrePositionInsertion,
  trouverCelluleDeSaisie,
  inserer,
  remplirChampDansXml,
  placerChampsRestantsViaIA,
  ajouterChampsNonPlaces,
  cocherCaseACocher,
};
