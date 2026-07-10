const JSZip = require('jszip');
const { downloadBuffer, BUCKETS } = require('./storage');
const {
  normalizeXmlText,
  remplirChampDansXml,
  placerChampsRestantsViaIA,
  ajouterChampsNonPlaces,
  cocherCaseACocher,
} = require('./docx-xml-utils');

const TEMPLATE_KEY = 'bordereau-template.docx';

const NOMS_LISIBLES = {
  NOM_DU_PROJET: 'Nom du projet', NUMERO_DU_PROJET: 'Numéro du projet',
  SPECIALITE: 'Spécialité', ADRESSE: 'Adresse', NOM: 'Nom (sous-traitant)',
  TITRE: 'Titre', DESCRIPTION: 'Description', USAGE: 'Usage',
  FOURNISSEUR: 'Fournisseur', FABRICANT: 'Fabricant', SECTION: 'Section',
  ARTICLE: 'Article', REMARQUE: 'Remarque',
  NOM_ETABLISSEMENT: 'Établissement', ARCHITECTE: 'Architecte',
  SOUMIS_PAR: 'Soumis par', RECU_ENTREPRENEUR_DATE: "Reçu de l'entrepreneur le",
};

async function remplirBordereau(champs, buf) {
  const templateBuf = buf || await downloadBuffer(BUCKETS.DOCUMENTS, TEMPLATE_KEY);
  if (!templateBuf) throw new Error('Template bordereau introuvable (Supabase Storage).');
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  xml = normalizeXmlText(xml);

  // Cocher les cases toujours applicables aux bordereaux T3E : discipline
  // "Architecture", produit soumis "Fiche technique", et le produit est
  // toujours conforme aux plans et devis (jamais une équivalence proposée
  // par T3E — cette case reste donc TOUJOURS decochee).
  xml = cocherCaseACocher(xml, 'Architecture');
  xml = cocherCaseACocher(xml, 'Fiche technique');
  xml = cocherCaseACocher(xml, 'Tel que plans et devis');

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
    ['USAGE',            'Usage' + NBSP + ':',                champs.USAGE            || ''],
    ['FOURNISSEUR',      'Fournisseur' + NBSP + ':',         champs.FOURNISSEUR      || ''],
    ['FABRICANT',        'Fabricant' + NBSP + ':',           champs.FABRICANT        || ''],
    ['SECTION',          'Section (item)' + NBSP + ':',      champs.SECTION          || ''],
    ['ARTICLE',          'Article' + NBSP + ':',             champs.ARTICLE          || ''],
    ['DELAI',            'Délai' + NBSP + ':',          ''],
    ['REMARQUE',         'Remarque' + NBSP + ':',            champs.REMARQUE         || ''],
    // Bas de page (signatures) — "Soumis par" : nom de la personne qui genere
    // le bordereau (deja saisi pour l'historique, voir POST /generer/:id) ;
    // "Reçu de l'entrepreneur le" : date de soumission, calculee automatiquement.
    ['SOUMIS_PAR',              'SOUMIS PAR' + NBSP + ':',                        champs.SOUMIS_PAR              || ''],
    ['RECU_ENTREPRENEUR_DATE', 'REÇU DE L’ENTREPRENEUR LE' + NBSP + ':', champs.RECU_ENTREPRENEUR_DATE || ''],
    // Sans équivalent dans le gabarit T3E (donc jamais trouvés ici), mais
    // présents sur beaucoup de gabarits d'architectes tiers — le nom du
    // libellé fixe ci-dessous ne matchera presque jamais ; ils passeront donc
    // par le fallback IA (placerChampsRestantsViaIA) puis, en dernier
    // recours, par le bloc "Renseignements complémentaires" garanti.
    ['NOM_ETABLISSEMENT', 'Nom de l\'établissement' + NBSP + ':', champs.NOM_ETABLISSEMENT || ''],
    ['ARCHITECTE',        'Architecte' + NBSP + ':',              champs.ARCHITECTE        || ''],
  ];

  const champsNonTrouves = {};
  for (const [champKey, label, valeur] of remplacements) {
    const resultat = remplirChampDansXml(xml, label, valeur);
    xml = resultat.xml;
    if (!resultat.trouve && valeur) champsNonTrouves[champKey] = valeur;
  }

  if (Object.keys(champsNonTrouves).length > 0) {
    console.log('[bordereau-filler] Libellés non trouvés, tentative IA pour:', Object.keys(champsNonTrouves).join(', '));
    const resultat = await placerChampsRestantsViaIA(xml, champsNonTrouves);
    xml = resultat.xml;
    if (Object.keys(resultat.restants).length > 0) {
      // Filet de sécurité final : ce gabarit n'a ni le libellé exact ni un
      // emplacement identifiable par l'IA pour ces champs — on les rend quand
      // même visibles plutôt que de produire un bordereau qui semble vide.
      xml = ajouterChampsNonPlaces(xml, resultat.restants, NOMS_LISIBLES);
    }
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { remplirBordereau };
