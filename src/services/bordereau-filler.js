const JSZip = require('jszip');
const { downloadBuffer, BUCKETS } = require('./storage');
const {
  normalizeXmlText,
  remplirChampDansXml,
  epislerApresLibelle,
  cocherCaseSymbole,
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
  INGENIEUR: 'Ingénieur', ENTREPRENEUR_GENERAL: 'Entrepreneur général',
  TELEPHONE: 'Téléphone', TELECOPIEUR: 'Télécopieur',
  NB_PAGES: 'Nombre de pages', SOUS_SECTION: 'Section',
};

// ── Gabarit « DESSINS D'ATELIER – FICHE D'IDENTIFICATION » ──────────────────
// Deuxième famille de gabarits reconnue (ex. « Bordereau de transmission des
// FT&DA 2.doc », devis type CSS des Patriotes / Senterre). Structure très
// différente du gabarit T3E : blocs PROJET / SOUS-TRAITANT / FOURNISSEUR /
// FABRICANT / ENTREPRENEUR dont les sous-libellés (« Adresse : »,
// « Responsable : », « Tél. : », « Téléc. : ») se RÉPÈTENT — le remplissage
// générique au premier indexOf plaçait les valeurs dans le mauvais bloc.
// Ici chaque sous-libellé est recherché À PARTIR de l'ancre de son bloc
// (ordre des cellules vérifié sur le gabarit réel : la 1re occurrence de
// chaque sous-libellé après « SOUS-TRAITANT : » appartient bien au bloc
// sous-traitant).
const APO = '’'; // apostrophe courbe Word

function estFicheIdentification(xml) {
  return xml.includes(`FICHE D${APO}IDENTIFICATION`)
    || (xml.includes('SOUS-TRAITANT') && xml.includes('SPÉCIALITÉ (discipline)'));
}

async function remplirFicheIdentification(champs, xml, zip) {
  const nonTrouves = {};
  const fill = (cle, label, valeur, depart = 0) => {
    const r = remplirChampDansXml(xml, label, valeur, depart);
    xml = r.xml;
    if (!r.trouve && valeur) nonTrouves[cle] = valeur;
  };
  const episser = (cle, label, valeur, depart = 0, nettoyerParens = false) => {
    const r = epislerApresLibelle(xml, label, valeur, depart, nettoyerParens);
    xml = r.xml;
    if (!r.trouve && valeur) nonTrouves[cle] = valeur;
  };

  // Bloc PROJET (nom + établissement sur 2 lignes, comme sur les exemples réels)
  const projet = [champs.NOM_DU_PROJET, champs.NOM_ETABLISSEMENT].filter(Boolean).join('\n');
  fill('NOM_DU_PROJET', 'PROJET', projet);
  fill('NUMERO_DU_PROJET', 'No. Projet', champs.NUMERO_DU_PROJET);

  // Blocs intervenants (extraits du devis à l'étape /analyser, éditables)
  fill('NOM_ETABLISSEMENT', 'PROPRIÉTAIRE (CLIENT)', champs.NOM_ETABLISSEMENT);
  fill('ARCHITECTE', 'ARCHITECTE', champs.ARCHITECTE);
  fill('INGENIEUR', 'INGÉNIEUR', champs.INGENIEUR);
  fill('ENTREPRENEUR_GENERAL', 'ENTREPRENEUR GÉNÉRAL', champs.ENTREPRENEUR_GENERAL);

  // Bloc SOUS-TRAITANT = T3E. Sous-libellés scopés après l'ancre du bloc.
  fill('NOM', 'SOUS-TRAITANT', champs.NOM);
  const ancreST = xml.indexOf('SOUS-TRAITANT');
  if (ancreST !== -1) {
    fill('ADRESSE', 'Adresse', champs.ADRESSE, ancreST);
    fill('SOUMIS_PAR', 'Responsable', champs.SOUMIS_PAR, ancreST);
    // « Tél. : (   ) Téléc. : (   ) » cohabitent dans la même cellule → épissure
    // directe après chaque ":" + suppression des parenthèses vides pré-imprimées.
    episser('TELEPHONE', 'Tél.', champs.TELEPHONE, ancreST, true);
    episser('TELECOPIEUR', 'Téléc.', champs.TELECOPIEUR, ancreST, true);
  }

  fill('FOURNISSEUR', 'FOURNISSEUR', champs.FOURNISSEUR);
  fill('FABRICANT', 'FABRICANT', champs.FABRICANT);

  // Sur ce gabarit la discipline attendue est « TOITURES » (vu sur les
  // exemples remplis) — « COUVREUR » est le défaut du gabarit T3E.
  const specialite = (!champs.SPECIALITE || /^couvreur$/i.test(champs.SPECIALITE.trim()))
    ? 'TOITURES' : champs.SPECIALITE;
  fill('SPECIALITE', 'SPÉCIALITÉ (discipline)', specialite);

  // NBRE DE PAGES = pages du document final soumis : ce gabarit fait 2 pages
  // + les pages des fiches techniques jointes (calculées par la route).
  if (Number.isFinite(champs.NB_PAGES_FT)) {
    fill('NB_PAGES', 'NBRE DE PAGES', String(2 + champs.NB_PAGES_FT));
  }

  // Produit
  const description = [champs.TITRE, champs.DESCRIPTION && champs.DESCRIPTION !== champs.TITRE ? champs.DESCRIPTION : '']
    .filter(Boolean).join('\n');
  fill('DESCRIPTION', `DESCRIPTION DU DESSIN D${APO}ATELIER`, description);

  // Référence au devis : numéro de section (ex. « 07 52 16 ») après le
  // libellé principal ; « Section : ... Articles : ... » partagent la même
  // cellule → épissure. Section parente dérivée de l'article (2.4.1.2 → 2.4).
  fill('SECTION', 'RÉFÉRENCE AU DEVIS', champs.SECTION);
  const ancreDevis = xml.indexOf('RÉFÉRENCE AU DEVIS');
  if (ancreDevis !== -1 && champs.ARTICLE) {
    const sousSection = champs.ARTICLE.split('.').slice(0, 2).join('.');
    episser('ARTICLE', 'Articles', champs.ARTICLE, ancreDevis);
    if (sousSection && sousSection !== champs.ARTICLE) {
      episser('SOUS_SECTION', 'Section', sousSection, ancreDevis);
    }
  }

  fill('REMARQUE', 'REMARQUES', champs.REMARQUE);

  // Cases (symboles Wingdings ❒, pas des FORMCHECKBOX) : le produit est
  // toujours soumis TEL QUEL (jamais une équivalence proposée par T3E) et le
  // dessin est émis pour EXAMEN. Le libellé « EXAMEN DU PROFESSIONNEL » plus
  // bas n'a pas de case dans sa cellule — pas de risque de collision.
  xml = cocherCaseSymbole(xml, 'TEL QUEL');
  xml = cocherCaseSymbole(xml, 'EXAMEN');

  // Mêmes filets de sécurité que le chemin générique : IA pour les libellés
  // introuvables, puis bloc « Renseignements complémentaires » garanti.
  if (Object.keys(nonTrouves).length > 0) {
    console.log('[bordereau-filler] (fiche identification) libellés non trouvés, tentative IA pour:', Object.keys(nonTrouves).join(', '));
    const resultat = await placerChampsRestantsViaIA(xml, nonTrouves);
    xml = resultat.xml;
    if (Object.keys(resultat.restants).length > 0) {
      xml = ajouterChampsNonPlaces(xml, resultat.restants, NOMS_LISIBLES);
    }
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function remplirBordereau(champs, buf) {
  const templateBuf = buf || await downloadBuffer(BUCKETS.DOCUMENTS, TEMPLATE_KEY);
  if (!templateBuf) throw new Error('Template bordereau introuvable (Supabase Storage).');
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  xml = normalizeXmlText(xml);

  // Gabarit « FICHE D'IDENTIFICATION » (architectes tiers) → chemin dédié,
  // les libellés/blocs étant trop différents du gabarit T3E.
  if (estFicheIdentification(xml)) {
    return remplirFicheIdentification(champs, xml, zip);
  }

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
