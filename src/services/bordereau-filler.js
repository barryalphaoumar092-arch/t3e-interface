﻿const JSZip = require('jszip');
const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'documents', 'bordereau-template.docx');
const N = ' '; // NBSP // espace insecable (U+00A0) dans le template Word
const U = '_';

// buf optionnel — si absent, utilise le template T3E par défaut
async function remplirBordereau(champs, buf) {
  const templateBuf = buf || fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  const remplacements = [
    [`NOM DU PROJET${N}:`,           `NOM DU PROJET${N}: ${champs.NOM_DU_PROJET || ''}`],
    [`NUMÉRO DU PROJET${N}:`,   `NUMÉRO DU PROJET${N}: ${champs.NUMERO_DU_PROJET || ''}`],
    [`NOM${N}: ${U.repeat(42)}`,     `NOM${N}: Toitures Trois Étoiles Inc.`],
    [`SPÉCIALITÉ${N}: ${U.repeat(36)}`, `SPÉCIALITÉ${N}: Couvreur`],
    [`ADRESSE${N}: ${U.repeat(90)}`, `ADRESSE${N}: 2215, rue Michelin, Laval (Québec) H7L 5B7`],
    [`Titre${N}:`,                   `Titre${N}: ${champs.TITRE || ''}`],
    [`Numéro de dessins${N}:`,  `Numéro de dessins${N}: ${champs.NUMERO_DESSINS || 'FT-001'}`],
    [`Nombre feuilles${N}:`,         `Nombre feuilles${N}: 1`],
    [`Révision${N}:`,           `Révision${N}: A`],
    [`Description${N}:`,             `Description${N}: ${champs.DESCRIPTION || ''}`],
    [`Fournisseur${N}:`,             `Fournisseur${N}: ${champs.FOURNISSEUR || ''}`],
    [`Fabricant${N}:`,               `Fabricant${N}: ${champs.FABRICANT || ''}`],
    [`Section (item)${N}:`,          `Section (item)${N}: ${champs.SECTION || ''}`],
    [`Article${N}:`,                 `Article${N}: ${champs.ARTICLE || ''}`],
    [`Délai${N}:`,              `Délai${N}: ${champs.DELAI || '3 à 4 semaines'}`],
    [`Remarque${N}: ${U.repeat(84)}`,`Remarque${N}: ${champs.REMARQUE || ''}`],
  ];

  for (const [search, replace] of remplacements) {
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    xml = xml.replace(
      new RegExp(`(<w:t[^>]*>)${escapedSearch}(</w:t>)`, 'g'),
      `$1${escapeXml(replace)}$2`
    );
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { remplirBordereau };