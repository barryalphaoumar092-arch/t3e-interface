const JSZip = require('jszip');
const { downloadBuffer, BUCKETS } = require('./storage');
const {
  normalizeXmlText,
  remplirChampDansXml,
  placerChampsRestantsViaIA,
  ajouterChampsNonPlaces,
} = require('./docx-xml-utils');

const TEMPLATE_KEY = 'manuel-template.docx';

const NOMS_LISIBLES = {
  NOM_DU_PROJET: 'Nom du projet', CLIENT: 'Client', ADRESSE_PROJET: 'Adresse du projet',
  NUMERO_DOSSIER: 'Numéro de dossier TTE', DATE: 'Date',
  PROPRIETAIRE: 'Propriétaire', CONSULTANT: 'Consultant',
  ENTREPRENEUR_GENERAL: 'Entrepreneur général', ENTREPRENEUR_COUVREUR: 'Entrepreneur couvreur',
  FOURNISSEUR_1: 'Fournisseur 1', FOURNISSEUR_2: 'Fournisseur 2',
  FOURNISSEUR_3: 'Fournisseur 3', FOURNISSEUR_4: 'Fournisseur 4',
  SOUS_TRAITANT_1: 'Sous-traitant 1', SOUS_TRAITANT_2: 'Sous-traitant 2',
  DESCRIPTION_TRAVAUX: 'Description des travaux', DETAILS_IMPREVUS: 'Détails et imprévus',
  NUMERO_GARANTIE: 'Numéro de garantie', SURFACE_GARANTIE: 'Surface garantie',
  DUREE_GARANTIE: 'Durée de la garantie', DATE_FIN_GARANTIE: 'Date de fin de garantie',
};

for (let i = 1; i <= 9; i++) NOMS_LISIBLES['COMMENTAIRE_' + i] = 'Commentaire (point ' + i + ')';

// Libellé exact tel qu'il apparaît dans manuel-template.docx pour chaque champ
// (convention "LIBELLÉ :" identique à bordereau-template.docx — voir
// docx-xml-utils.js pour le moteur de remplissage inline partagé).
const LABELS = {
  NOM_DU_PROJET: 'NOM DU PROJET',
  CLIENT: 'CLIENT',
  ADRESSE_PROJET: 'ADRESSE DU PROJET',
  NUMERO_DOSSIER: 'NUMÉRO DE DOSSIER TTE',
  DATE: 'DATE',
  PROPRIETAIRE: 'Propriétaire',
  CONSULTANT: 'Consultant',
  ENTREPRENEUR_GENERAL: 'Entrepreneur général',
  ENTREPRENEUR_COUVREUR: 'Entrepreneur couvreur',
  FOURNISSEUR_1: 'Fournisseur 1',
  FOURNISSEUR_2: 'Fournisseur 2',
  FOURNISSEUR_3: 'Fournisseur 3',
  FOURNISSEUR_4: 'Fournisseur 4',
  SOUS_TRAITANT_1: 'Sous-traitant 1',
  SOUS_TRAITANT_2: 'Sous-traitant 2',
  DESCRIPTION_TRAVAUX: 'Description',
  DETAILS_IMPREVUS: 'Détails',
  NUMERO_GARANTIE: 'Numéro de garantie',
  SURFACE_GARANTIE: 'Surface garantie',
  DUREE_GARANTIE: 'Durée de la garantie',
  DATE_FIN_GARANTIE: 'Date de fin de garantie',
};
for (let i = 1; i <= 9; i++) LABELS['COMMENTAIRE_' + i] = 'Commentaire ' + i;

// Ordre de remplacement : les libellés les plus longs/spécifiques en premier
// pour éviter qu'un libellé court (ex: "DATE") ne soit un préfixe accidentel
// d'un autre — voir bordereau-filler.js pour la même précaution.
const ORDRE_CHAMPS = Object.keys(LABELS).sort((a, b) => LABELS[b].length - LABELS[a].length);

async function remplirManuel(champs, buf) {
  const templateBuf = buf || await downloadBuffer(BUCKETS.DOCUMENTS, TEMPLATE_KEY);
  if (!templateBuf) throw new Error('Template manuel-template.docx introuvable (Supabase Storage).');
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  xml = normalizeXmlText(xml);

  const champsNonTrouves = {};
  for (const champKey of ORDRE_CHAMPS) {
    const valeur = champs[champKey] || '';
    const resultat = remplirChampDansXml(xml, LABELS[champKey], valeur);
    xml = resultat.xml;
    if (!resultat.trouve && valeur) champsNonTrouves[champKey] = valeur;
  }

  if (Object.keys(champsNonTrouves).length > 0) {
    console.log('[manuel-filler] Libellés non trouvés, tentative IA pour:', Object.keys(champsNonTrouves).join(', '));
    const resultat = await placerChampsRestantsViaIA(xml, champsNonTrouves);
    xml = resultat.xml;
    if (Object.keys(resultat.restants).length > 0) {
      xml = ajouterChampsNonPlaces(xml, resultat.restants, NOMS_LISIBLES);
    }
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { remplirManuel, LABELS };
