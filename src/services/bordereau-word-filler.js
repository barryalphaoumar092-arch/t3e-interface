const JSZip = require('jszip');

// Remplace les {{CHAMP}} dans tous les XML d'un .docx (document, headers, footers)
async function remplirBordereauWord(templateBuffer, champs) {
  const zip = await JSZip.loadAsync(templateBuffer);

  const xmlFiles = Object.keys(zip.files).filter(f =>
    f === 'word/document.xml' || f.match(/^word\/(header|footer)\d*\.xml$/)
  );

  for (const xmlFile of xmlFiles) {
    const entry = zip.file(xmlFile);
    if (!entry) continue;
    let xml = await entry.async('string');

    for (const [cle, valeur] of Object.entries(champs)) {
      const v = String(valeur || '');
      // Patterns acceptés : {{NOM_DU_PROJET}} ou {{nom_du_projet}}
      const cleUpper = cle.toUpperCase().replace(/\s+/g, '_');
      const cleLower = cle.toLowerCase().replace(/\s+/g, '_');
      xml = xml.replace(new RegExp('\\{\\{' + cleUpper + '\\}\\}', 'g'), v);
      xml = xml.replace(new RegExp('\\{\\{' + cleLower + '\\}\\}', 'g'), v);
      xml = xml.replace(new RegExp('\\{\\{' + cle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}\\}', 'g'), v);
    }

    // Remplacer aussi les patterns scindés dans des <w:r> séparés (cas Word)
    // Ex: {{NOM}} splitté en {{N}} + OM}} dans deux runs
    xml = normalizeAndReplace(xml, champs);

    zip.file(xmlFile, xml);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

// Normalise le XML Word (fusionne les runs adjacents) puis remplace
function normalizeAndReplace(xml, champs) {
  // Fusionne le texte des runs pour trouver les {{CHAMPS}} qui sont scindés
  // Simple heuristique: chercher {{ .... }} sur plusieurs runs consécutifs
  for (const [cle, valeur] of Object.entries(champs)) {
    const v = String(valeur || '');
    const cleUpper = cle.toUpperCase().replace(/\s+/g, '_');
    const cleLower = cle.toLowerCase().replace(/\s+/g, '_');

    [cleUpper, cleLower, cle].forEach(c => {
      // Pattern scindé : chaque caractère peut être dans un run différent
      const chars = ('{{' + c + '}}').split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const splitPattern = chars.join('(?:</w:t>(?:[^<]*<[^>]*>)*<w:t[^>]*>)?');
      try {
        xml = xml.replace(new RegExp(splitPattern, 'g'), v);
      } catch (e) { /* regex invalide */ }
    });
  }
  return xml;
}

module.exports = { remplirBordereauWord };
