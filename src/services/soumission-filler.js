// Remplit un template Word de soumission privee (voir documents/templates-soumission)
// a partir du rapport d'extraction IA (voir claude-client.js:analyserProjetSoumissionPrivee).
//
// Remplace l'ancien soumission-generator.js (supprime) dont l'approche —
// regex globales appliquees a l'aveugle sur tout le XML, avec des valeurs par
// defaut inventees quand une info manquait — produisait des soumissions peu
// fiables. Ici : (1) on ne remplace QUE ce qu'on a reellement trouve dans les
// documents du projet (statut != confirme/a_verifier ou valeur vide -> marqueur
// [A VALIDER], jamais une valeur inventee), (2) le remplacement se fait au
// niveau du PARAGRAPHE ENTIER (tous ses runs concatenes, puis reconstruit en un
// seul run) plutot que par regex sur le XML brut — insensible au fractionnement
// des runs Word qui a cause la fragilite de l'ancien generateur.
const JSZip = require('jszip');
const { uploadBuffer, downloadBuffer, sanitizeKey, BUCKETS } = require('./storage');

const TEMPLATE_MAP = {
  BUR_REFECTION:          { fr: 'T3E - BUR 2-4-5 PLIS REFECTION (FR).docx',    en: 'T3E - BUR 2-4-5 PLIS REFECTION (EN).docx' },
  BUR_PLEUMAGE:           { fr: 'T3E - BUR 2-4-5 PLIS PLEUMAGE (FR).docx',     en: 'T3E - BUR 2-4-5 PLIS PLEUMAGE (EN).docx' },
  COLVENT_REFECTION:      { fr: 'T3E - COLVENT REFECTION (FR).docx',           en: 'T3E - COLVENT REFECTION (EN).docx' },
  EPDM_PVC_PLEUMAGE:      { fr: 'T3E - EPDM-PVC PLEUMAGE (FR).docx',           en: 'T3E - EPDM-PVC PLEUMAGE (EN).docx' },
  INVERSE_REFECTION:      { fr: 'T3E - INVERSE REFECTION (FR).docx',           en: 'T3E - INVERSE REFECTION (EN).docx' },
  SOPRAFIX_REFECTION:     { fr: 'T3E - SOPRAFIX REFECTION (FR).docx',          en: 'T3E - SOPRAFIX REFECTION (EN).docx' },
  SOPRASMART_REFECTION:   { fr: 'T3E - SOPRASMART REFECTION (FR).docx',        en: 'T3E - SOPRASMART REFECTION (EN).docx' },
  TPO_PVC_RHINOBOND:      { fr: 'T3E - TPO-PVC RHINOBOND REFECTION (FR).docx', en: 'T3E - TPO-PVC RHINOBOND REFECTION (EN).docx' },
  ANCESTRAL:              { fr: 'T3E - ANCESTRAL (FR).docx',                   en: 'T3E - ANCESTRAL (EN).docx' },
};

const LABELS_SYSTEME = {
  BUR_REFECTION: 'BUR 2-4-5 plis — Réfection', BUR_PLEUMAGE: 'BUR 2-4-5 plis — Pleumage',
  COLVENT_REFECTION: 'Colvent — Réfection', EPDM_PVC_PLEUMAGE: 'EPDM-PVC — Pleumage',
  INVERSE_REFECTION: 'Inversé — Réfection', SOPRAFIX_REFECTION: 'Soprafix — Réfection',
  SOPRASMART_REFECTION: 'Soprasmart — Réfection', TPO_PVC_RHINOBOND: 'TPO-PVC Rhinobond — Réfection',
  ANCESTRAL: 'Ancestral (métal/ardoise)',
};

function selectTemplate(systeme) {
  return TEMPLATE_MAP[systeme] ? systeme : null;
}

function getTemplateFile(systeme, langue) {
  const entry = TEMPLATE_MAP[systeme];
  if (!entry) return null;
  return (langue || 'FR').toUpperCase() === 'EN' ? entry.en : entry.fr;
}

// ── Moteur de remplacement au niveau paragraphe ─────────────────────────
function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeXmlText(str) {
  return String(str || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function texteDuParagraphe(pXml) {
  const matches = pXml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [];
  return matches.map(m => decodeXmlText(m.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, ''))).join('');
}

function reconstruireParagraphe(pXml, nouveauTexte) {
  const pPr = (pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
  const rPr = (pXml.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(nouveauTexte)}</w:t></w:r></w:p>`;
}

// regles: [{ test: (texte) => bool, build: (texte) => string|null }]
// build retourne null => le PARAGRAPHE ENTIER est supprime (ex: bullet
// Ancestral non applicable, ligne d'instruction "Insérer ici vos exclusions").
// build retourne le meme texte qu'en entree => aucun changement.
function appliquerReglesParagraphes(xml, regles) {
  return xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (pXml) => {
    const texte = texteDuParagraphe(pXml);
    if (!texte.trim() && !/<w:t/.test(pXml)) return pXml; // pas de texte du tout, rien a faire
    for (const regle of regles) {
      if (regle.test(texte)) {
        const nouveau = regle.build(texte);
        if (nouveau === null) return ''; // supprime le paragraphe
        if (nouveau !== texte) return reconstruireParagraphe(pXml, nouveau);
        break;
      }
    }
    return pXml;
  });
}

// ── Aides d'extraction du rapport IA ────────────────────────────────────
const MARQUEUR_A_VALIDER = '[À VALIDER]';

function val(champ) {
  return champ && typeof champ.valeur === 'string' ? champ.valeur.trim() : '';
}

// Retourne la valeur trouvee, ou un marqueur explicite plutot qu'une chaine
// vide silencieuse — jamais une valeur inventee (voir claude-client.js).
function texteOuAValider(champ) {
  const v = val(champ);
  return v || MARQUEUR_A_VALIDER;
}

function rapportChamp(cle, champ, notes) {
  return {
    champ: cle,
    valeur: val(champ) || '(non trouvé)',
    statut: (champ && champ.statut) || 'non_trouve',
    document_source: (champ && champ.document_source) || '',
    page_source: (champ && champ.page_source) || '',
    niveau_confiance: (champ && champ.niveau_confiance) || 'faible',
    notes: notes || '',
  };
}

function formaterDateFr(d) {
  const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return `Montréal, ${jours[d.getDay()]}, ${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
}

function formaterDateFrCourte(d) {
  const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  return `${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
}

function formaterPrix(champ) {
  const v = val(champ);
  if (!v) return MARQUEUR_A_VALIDER + ' $';
  const nombre = Number(String(v).replace(/[^\d.,]/g, '').replace(',', '.'));
  if (!isNaN(nombre) && nombre > 0) return `${nombre.toLocaleString('fr-CA')} $`;
  return v;
}

// ── Règles communes à tous les templates ────────────────────────────────
function reglesCommunes(champs, dateAujourdhui) {
  let docsRecusInseres = false;

  return [
    // Date d'en-tête (ex: "Montréal, mardi, 1er octobre 2024")
    { test: t => /^Montréal,\s*\w+,\s*\d/.test(t.trim()), build: () => formaterDateFr(dateAujourdhui) },
    // Identité du projet sur la page de garde (numéro de référence trouvé
    // dans les documents sources — PAS le numéro interne T3E — et nom du
    // client destinataire). Ces 3 libellés apparaissent chacun DEUX FOIS sur
    // la page de garde (bloc titre + bloc "Re :"), remplacés identiquement
    // aux deux endroits par cette même règle. Laissés VIDES si non trouvés
    // (pas de marqueur [À VALIDER] sur ces champs d'identité — cohérent avec
    // Attention/Cellulaire/Courriel ci-dessous).
    { test: t => t.trim() === '#SOUMISSION', build: () => val(champs.numero_reference_projet) },
    { test: t => t.trim() === 'NOM DU CLIENT', build: () => val(champs.client_nom) },
    // Le libellé du gabarit dit "NOM DU PROJET ET CLIENT" mais la case sert
    // en pratique à identifier l'adresse du chantier sur la lettre.
    { test: t => t.trim() === 'NOM DU PROJET ET CLIENT', build: () => val(champs.client_adresse) },
    // Adresse / Ville client (placeholders littéraux)
    { test: t => t.trim() === 'Adresse', build: () => texteOuAValider(champs.client_adresse) },
    { test: t => t.trim() === 'Ville, Province, Code Postal', build: () => texteOuAValider(champs.client_ville_province_cp) },
    // Pas de marqueur [À VALIDER] sur ces 3 champs (contrairement aux champs
    // techniques plus bas) — un "Attention: [À VALIDER]" imprimé sur une
    // vraie lettre a l'air cassé ; mieux vaut un espace vide que l'estimateur
    // remplira lui-même, demande explicite de l'utilisateur.
    { test: t => /^Attention\s*:/.test(t.trim()), build: () => `Attention:\t${val(champs.client_contact)}` },
    { test: t => /^Cellulaire\s*:/.test(t.trim()), build: () => `Cellulaire:\t${val(champs.client_telephone)}` },
    { test: t => /^Courriel\s*:/.test(t.trim()), build: () => `Courriel:\t${val(champs.client_courriel)}` },
    // Ligne "conformément aux documents reçus le ______ pour soumission"
    {
      test: t => /documents reçus le\s*_+\s*pour soumission/i.test(t),
      build: t => t.replace(/_+(?=\s*pour soumission)/i, val(champs.date_documents_recus) || 'À VALIDER'),
    },
    // 3 lignes d'exemple de documents (Plans/Sections/Addendas) — remplacées
    // par UNE ligne réelle la première fois, supprimées ensuite.
    {
      test: t => /^Plans architectures?,\s*émis pour soumission/i.test(t.trim())
        || /^Sections?\s+[\d ]+\/?[\d ]*,?\s*émis pour soumission/i.test(t.trim())
        || /^Addendas?\s+.*,\s*émis/i.test(t.trim()),
      build: () => {
        if (docsRecusInseres) return null;
        docsRecusInseres = true;
        const v = val(champs.documents_recus_liste);
        return v || null; // rien trouvé -> on supprime la ligne d'exemple plutôt que la garder
      },
    },
    // Objet / superficie (table Re:/Objet:)
    {
      test: t => /^Bassin\s*1\s*[–-]/i.test(t.trim()),
      build: t => val(champs.objet_projet) || t, // pas trouvé -> on garde le libellé générique du template
    },
    { test: t => t.trim() === 'superficie', build: () => { const v = val(champs.superficie_pc); return v ? `${v} pi²` : MARQUEUR_A_VALIDER; } },
    // "Re :" — la cellule de valeur du tableau est une cellule VIDE distincte
    // (pas de texte à cibler) ; on met donc l'adresse du projet directement
    // dans la cellule du libellé, plutôt qu'une manipulation XML par index de
    // table (plus fragile) — laisse une cellule vide adjacente, compromis
    // visuel mineur accepté pour la robustesse du remplissage automatique.
    { test: t => /^Re\s*:$/.test(t.trim()), build: () => `Re : ${texteOuAValider(champs.client_adresse)}` },
    // Exclusions spécifiques (ligne d'instruction, jamais laissée telle quelle)
    {
      test: t => t.trim() === 'Insérer ici vos exclusions spécifiques aux projets',
      build: () => val(champs.exclusions_specifiques) || null,
    },
    // Prix
    { test: t => /100[\s ]?000\$/.test(t), build: t => t.replace(/100[\s ]?000\$/, formaterPrix(champs.prix_total)) },
    // Intro Annexe : 3 blancs cachés (espaces doubles, pas de soulignés)
    {
      test: t => /présentée à\s+portant sur le projet\s+\/\s+\(Ci-après/i.test(t),
      build: t => t.replace(
        /présentée à\s+portant sur le projet\s+\/\s+\(Ci-après/i,
        `présentée à ${texteOuAValider(champs.client_nom)} portant sur le projet ${texteOuAValider(champs.objet_projet)} / ${texteOuAValider(champs.client_adresse)} (Ci-après`
      ),
    },
    // Coût remplacement contreplaqué ($/pied carré) — ancré sur "contreplaqués"
    // pour ne jamais happer la ligne distincte "isolants existants humides"
    // (BUR/EPDM-PVC, voir règle suivante) qui a la même forme "$___/ pied carré".
    { test: t => /contreplaqué.*\$_+\s*\/\s*pied carré/i.test(t), build: t => t.replace(/\$_+(?=\s*\/\s*pied carré)/, '$' + texteOuAValider(champs.cout_remplacement_cp)) },
    // Coût remplacement isolant existant humide/endommagé — présent seulement
    // sur BUR et EPDM-PVC ; n'a aucun paragraphe correspondant ailleurs (no-op).
    { test: t => /isolants existants humides.*\$_+\s*\/\s*pied carré/i.test(t), build: t => t.replace(/\$_+(?=\s*\/\s*pied carré)/, '$' + texteOuAValider(champs.cout_remplacement_isolant_humide)) },
    // Superficie de la zone à arracher ("environ______pieds carrés")
    { test: t => /environ\s*_+\s*pieds carrés/i.test(t), build: t => t.replace(/_+(?=\s*pieds carrés)/, val(champs.superficie_pc) || 'À VALIDER') },
    // Drains / manchons (communs à presque tous les systèmes)
    { test: t => /installer\s*_+\s*nouveaux drains/i.test(t), build: t => t.replace(/_+(?=\s*nouveaux drains)/i, texteOuAValider(champs.nb_drains)) },
    { test: t => /installer\s*_+\s*nouveaux manchons d['’]év[ée]nts/i.test(t), build: t => t.replace(/_+(?=\s*nouveaux manchons)/i, texteOuAValider(champs.nb_manchons_events)) },
    { test: t => /installer\s*_+\s*nouveaux manchons d['’][ée]tanch/i.test(t), build: t => t.replace(/_+(?=\s*nouveaux manchons)/i, texteOuAValider(champs.nb_manchons_etancheite)) },
    // Cols de cygne / Ventilateur Maximum
    {
      test: t => /cols de cygne tel qu['’]existant\s*\/\s*Ventilateur Maximum\s*#\s*_+/i.test(t),
      build: t => t.replace(/_*\s*cols de cygne tel qu['’]existant\s*\/\s*Ventilateur Maximum\s*#\s*_+\.?/i, texteOuAValider(champs.gooseneck_ou_ventilateur)),
    },
    // Solins / ferblanterie (matériau + calibre)
    {
      test: t => /acier prépeint\/?\s*acier galvanisé,?\s*calibre 26 ou 24\s*\/\s*cuivre 16\s*oz/i.test(t),
      build: t => t.replace(/acier prépeint\/?\s*acier galvanisé,?\s*calibre 26 ou 24\s*\/\s*cuivre 16\s*oz/i, texteOuAValider(champs.flashing_materiau_calibre)),
    },
  ];
}

// ── Règles propres à chaque système (choix "/" et blancs spécifiques) ────
const REGLES_PAR_SYSTEME = {
  BUR_REFECTION: (c) => [
    { test: t => /pontage de\s*\/?\s*bois\s*\/\s*acier\s*\/\s*béton\s*\/?\s*siporex/i.test(t), build: t => t.replace(/bois\s*\/\s*acier\s*\/\s*béton\s*\/?\s*siporex/i, texteOuAValider(c.pontage_materiau)) },
    { test: t => /pare-vapeur de papier kraft.*élastomère thermosoudée.*feutre #\s*15/i.test(t), build: t => t.replace(/pare-vapeur de papier kraft[^;]*feutre #\s*15 adhéré à l['’]asphalte/i, `pare-vapeur de ${texteOuAValider(c.pare_vapeur_type)}`) },
    { test: t => /_+['’ʺ""]{1,2}\s*d['’]isolant de polyisocyanurate/i.test(t), build: t => t.replace(/_+(?=['’ʺ""]{1,2}\s*d['’]isolant)/i, texteOuAValider(c.isolant_base_epaisseur)) },
    { test: t => /isolant de pente 1%\s*\/\s*2%/i.test(t), build: t => t.replace(/1%\s*\/\s*2%/, texteOuAValider(c.pente_isolant)).replace(/polyisocyanurate\s*\/\s*polystyr[èe]ne/i, texteOuAValider(c.isolant_materiau)) },
    { test: t => /fibre de bois\s*\/\s*perlite/i.test(t), build: t => t.replace(/_+(?=['’"]{1,2}\s*de\s*fibre)/i, texteOuAValider(c.fibre_bois_epaisseur)).replace(/fibre de bois\s*\/\s*perlite/i, texteOuAValider(c.fibre_bois_ou_perlite)) },
    { test: t => /\(4-5\)\s*plis de papier feutre/i.test(t), build: t => t.replace(/\(4-5\)/, `(${texteOuAValider(c.nb_plis_ou_membrane_alt)})`) },
    { test: t => /gravier ¼['’"]?\s*standard.*OU\s*gravier ¼['’"]?\s*réfléchissantes/i.test(t), build: t => val(c.gravier_type) ? t.replace(/gravier ¼['’"]?\s*standard[^;]*réfléchissantes[^;]*;/i, val(c.gravier_type) + ';') : t },
    { test: t => /^Les relevés seront composés de papier feutre/i.test(t.trim()), build: t => val(c.releves_composition) || t },
  ],
  BUR_PLEUMAGE: (c) => [
    { test: t => /isolant de pente 1%\s*\/\s*2%/i.test(t), build: t => t.replace(/1%\s*\/\s*2%/, texteOuAValider(c.pente_isolant)).replace(/polyisocyanurate\s*\/\s*polystyr[èe]ne/i, texteOuAValider(c.isolant_materiau)) },
    { test: t => /fibre de bois\s*\/\s*perlite/i.test(t), build: t => t.replace(/_+(?=['’"]{1,2}\s*de\s*fibre)/i, texteOuAValider(c.fibre_bois_epaisseur)).replace(/fibre de bois\s*\/\s*perlite/i, texteOuAValider(c.fibre_bois_ou_perlite)) },
    { test: t => /\(4-5\)\s*plis de papier feutre/i.test(t), build: t => t.replace(/\(4-5\)/, `(${texteOuAValider(c.nb_plis_ou_membrane_alt)})`) },
    { test: t => /^Les relevés seront composés de papier feutre/i.test(t.trim()), build: t => val(c.releves_composition) || t },
  ],
  COLVENT_REFECTION: (c) => [
    { test: t => /spécifier type toiture/i.test(t), build: t => t.replace(/spécifier type toiture/i, texteOuAValider(c.description_toiture_existante)) },
    { test: t => /bois\s*\/\s*acier\s*\/?\s*béton\s*\/\s*syporex\s*\/\s*coupe-vapeur/i.test(t), build: t => t.replace(/bois\s*\/\s*acier\s*\/?\s*béton\s*\/\s*syporex\s*\/\s*coupe-vapeur/i, texteOuAValider(c.pontage_materiau)) },
    { test: t => /papier kraft adhéré à l['’]adhésif\s*\/.*thermosoudée/i.test(t), build: t => t.replace(/papier kraft adhéré à l['’]adhésif[^;]*thermosoudée/i, texteOuAValider(c.pare_vapeur_type)) },
    { test: t => /isolant de pente 1%\s*\/\s*2%/i.test(t) && /fixé\s*mécaniquement\s*\/\s*adhéré à l['’]adhésif/i.test(t), build: t => t.replace(/1%\s*\/\s*2%/, texteOuAValider(c.pente_isolant)).replace(/polyisocyanurate\s*\/\s*polystyr[èe]ne/i, texteOuAValider(c.isolant_materiau)).replace(/fixé\s*mécaniquement\s*\/\s*adhéré à l['’]adhésif/i, texteOuAValider(c.isolant_methode_fixation)) },
    { test: t => /_+['’ʺ""]{1,2}\s*d['’]isolant de polyisocyanurate/i.test(t), build: t => t.replace(/_+(?=['’ʺ""]{1,2}\s*d['’]isolant)/i, texteOuAValider(c.isolant_base_epaisseur)).replace(/fixé\s*mécaniquement\s*\/\s*adhéré à l['’]adhésif/i, texteOuAValider(c.isolant_methode_fixation)) },
    { test: t => /contreplaqué ½['’"]{1,2}\s*\/\s*asphaltique ½['’"]{1,2}/i.test(t), build: t => t.replace(/contreplaqué ½['’"]{1,2}\s*\/\s*asphaltique ½['’"]{1,2}/i, texteOuAValider(c.releves_materiau)) },
    { test: t => /grise\s*\/\s*réfléchissante blanche/i.test(t), build: t => t.replace(/grise\s*\/\s*réfléchissante blanche/i, texteOuAValider(c.membrane_couleur)) },
  ],
  EPDM_PVC_PLEUMAGE: (c) => [
    { test: t => /isolant de pente 1%\s*\/\s*2%/i.test(t), build: t => t.replace(/1%\s*\/\s*2%/, texteOuAValider(c.pente_isolant)).replace(/polyisocyanurate\s*\/\s*polystyr[èe]ne/i, texteOuAValider(c.isolant_materiau)) },
    { test: t => /EPDM 60\s*mils\s*\/\s*PVC 60\s*mils/i.test(t), build: t => t.replace(/EPDM 60\s*mils\s*\/\s*PVC 60\s*mils/i, texteOuAValider(c.membrane_type)) },
    { test: t => /pierre de rivière.*réfléchissant blanc/i.test(t), build: t => val(c.ballast_type) ? t.replace(/pierre de rivière[^;]*réfléchissant blanc/i, val(c.ballast_type)) : t },
  ],
  INVERSE_REFECTION: (c) => [
    { test: t => /spécifier type toiture/i.test(t), build: t => t.replace(/spécifier type toiture/i, texteOuAValider(c.description_toiture_existante)) },
    { test: t => /thermosoudées sur l['’]entièreté.*Hydrotech/i.test(t), build: t => val(c.methode_membrane) ? t.replace(/deux \(2\) membranes[^.]*Hydrotech['’ »]* ou équivalent\./i, val(c.methode_membrane)) : t },
    { test: t => /contreplaqué ½['’"]{1,2}\s*\/\s*panneau asphaltique/i.test(t), build: t => t.replace(/contreplaqué ½['’"]{1,2}\s*\/\s*panneau asphaltique ¼['’"]{1,2}/i, texteOuAValider(c.releves_materiau)).replace(/grise\s*\/\s*granulée réfléchissante blanche/i, texteOuAValider(c.membrane_couleur)) },
    { test: t => /_+['’ʺ""]{1,2}\s*d['’]isolant de polystyrène extrudé/i.test(t), build: t => t.replace(/_+(?=['’ʺ""]{1,2}\s*d['’]isolant de polystyrène)/i, texteOuAValider(c.xps_epaisseur)) },
    { test: t => /gravier naturel\s*\/\s*gravier réfléchissant/i.test(t), build: t => t.replace(/gravier naturel\s*\/\s*gravier réfléchissant blanc[^;]*gris/i, texteOuAValider(c.ballast_type)) },
  ],
  SOPRAFIX_REFECTION: (c) => [
    { test: t => /spécifier type toiture/i.test(t), build: t => t.replace(/spécifier type toiture/i, '') },
    { test: t => /pontage de bois\s*\/\s*acier/i.test(t), build: t => t.replace(/bois\s*\/\s*acier/i, texteOuAValider(c.pontage_materiau)) },
    { test: t => /papier kraft adhéré à l['’]adhésif\s*\/\s*un pare-vapeur élastomère autocollant/i.test(t), build: t => t.replace(/pare-vapeur de papier kraft adhéré à l['’]adhésif[^;]*préalablement apprêtée/i, `pare-vapeur ${texteOuAValider(c.pare_vapeur_type)}`) },
    { test: t => /_+['’ʺ""]{1,2}\s*d['’]isolant de polyisocyanurate fixé mécaniquement/i.test(t), build: t => t.replace(/_+(?=['’ʺ""]{1,2}\s*d['’]isolant)/i, texteOuAValider(c.isolant_epaisseur)) },
    { test: t => /isolant de pente 1%\s*\/\s*2%/i.test(t), build: t => t.replace(/1%\s*\/\s*2%/, texteOuAValider(c.pente_isolant)).replace(/polyisocyanurate\s*\/\s*polystyr[èe]ne/i, texteOuAValider(c.isolant_materiau)) },
    { test: t => /panneau support en contreplaqué/i.test(t), build: t => val(c.releves_materiau) ? t.replace(/un panneau support en contreplaqué[^,]*aux endroits requis/i, val(c.releves_materiau)) : t },
    { test: t => /grise\s*\/\s*réfléchissante blanche/i.test(t), build: t => t.replace(/grise\s*\/\s*réfléchissante blanche/i, texteOuAValider(c.membrane_couleur)) },
  ],
  SOPRASMART_REFECTION: (c) => [
    { test: t => /jusqu['’]au\s*(pontage de\s*)?\/?\s*bois\s*\/\s*acier/i.test(t), build: t => t.replace(/bois\s*\/\s*acier/i, texteOuAValider(c.pontage_materiau)) },
    { test: t => /pare-vapeur de papier kraft.*préalablement apprêtée/i.test(t) && !/relevés/i.test(t), build: t => t.replace(/(un\s+)?pare-vapeur de papier kraft[^;]*préalablement apprêtée/i, `coupe-vapeur ${texteOuAValider(c.coupe_vapeur_type)}`) },
    { test: t => /_+['’ʺ""]{1,2}\s*d['’]isolant de polyisocyanurate/i.test(t), build: t => t.replace(/_+(?=['’ʺ""]{1,2}\s*d['’]isolant)/i, texteOuAValider(c.isolant_sopraiso_epaisseur)) },
    { test: t => /panneau d['’]isolant polyisocyanurate.*haute densité/i.test(t), build: t => t.replace(/_+(?=['’ʺ""]{1,2}\s*haute densité)/i, texteOuAValider(c.panneau_support_epaisseur)) },
    { test: t => /grise\s*\/\s*réfléchissante blanche/i.test(t), build: t => t.replace(/grise\s*\/\s*réfléchissante blanche/i, texteOuAValider(c.membrane_couleur)) },
  ],
  TPO_PVC_RHINOBOND: (c) => [
    { test: t => /pontage de bois\s*\/\s*acier/i.test(t), build: t => t.replace(/bois\s*\/\s*acier/i, texteOuAValider(c.pontage_materiau)) },
    { test: t => /papier kraft adhéré à l['’]adhésif\s*\/\s*un pare-vapeur élastomère autocollant/i.test(t), build: t => t.replace(/pare-vapeur de papier kraft adhéré à l['’]adhésif[^;]*préalablement apprêtée/i, `pare-vapeur ${texteOuAValider(c.pare_vapeur_type)}`) },
    { test: t => /isolant de pente 1%\s*\/\s*2%/i.test(t), build: t => t.replace(/1%\s*\/\s*2%/, texteOuAValider(c.pente_isolant)).replace(/polyisocyanurate\s*\/\s*polystyr[èe]ne/i, texteOuAValider(c.isolant_materiau)) },
    { test: t => /_+['’ʺ""]{1,2}\s*d['’]isolant de polyisocyanurate fixé mécaniquement.*Rhinobond/i.test(t), build: t => t.replace(/_+(?=['’ʺ""]{1,2}\s*d['’]isolant)/i, texteOuAValider(c.isolant_epaisseur)) },
    { test: t => /membrane TPO\s*\/\s*PVC 60\s*mils/i.test(t), build: t => t.replace(/TPO\s*\/\s*PVC/i, texteOuAValider(c.membrane_type)) },
    { test: t => /manchons d['’]év[ée]nts de plomberie en PVC\s*\/\s*TPO/i.test(t), build: t => t.replace(/PVC\s*\/\s*TPO/i, texteOuAValider(c.membrane_type)) },
  ],
  ANCESTRAL: (c) => {
    const parType = {};
    const items = Array.isArray(c.items_toiture_metallique) ? c.items_toiture_metallique : [];
    for (const it of items) if (it && it.type) parType[it.type] = it;

    function texteItem(type) {
      const it = parType[type];
      if (!it || !it.present) return null; // absent des documents -> paragraphe supprimé
      return val(it) || MARQUEUR_A_VALIDER;
    }
    const CINQ_METAUX = /cuivre naturel 16oz\s*\/\s*cuivre étamé 16oz\s*\/\s*acier galvanisé calibre 24 ou 26\s*\/\s*acier galvalume calibre 24 ou 26\s*\/\s*acier prépeint calibre 24 ou 26/i;

    return [
      { test: t => /contreplaqué\/?\s*en planche/i.test(t) || /contreplaqué\s*\/\s*en planche/i.test(t), build: t => t.replace(/en contreplaqué\/?\s*en planche|contreplaqué\s*\/\s*en planche/i, texteOuAValider(c.pontage_materiau)) },
      { test: t => CINQ_METAUX.test(t) && /baguettes|largeur entre les baguettes/i.test(t), build: () => { const v = texteItem('baguettes'); return v === null ? null : v; } },
      { test: t => CINQ_METAUX.test(t) && /tôle à la canadienne|canadienne/i.test(t), build: () => texteItem('tole_canadienne') },
      { test: t => CINQ_METAUX.test(t) && /joints? debout/i.test(t), build: () => texteItem('joints_debout') },
      { test: t => /ardoise de couleur/i.test(t), build: () => texteItem('ardoise') },
      { test: t => /lucarnes/i.test(t), build: () => texteItem('lucarnes') },
      { test: t => /goutti[èe]res/i.test(t), build: () => texteItem('gouttieres') },
      { test: t => /ornements/i.test(t), build: () => texteItem('ornements') },
      { test: t => /couronnement\s*\/\s*larmiers de départ|solins de terminaisons/i.test(t), build: () => texteItem('solins') },
    ];
  },
};

// ── Construction du rapport de remplissage (affiché à l'utilisateur) ────
function construireRapport(champs, systeme) {
  const rapport = [];
  for (const [cle, champ] of Object.entries(champs)) {
    if (cle === 'items_toiture_metallique') {
      for (const it of (Array.isArray(champ) ? champ : [])) {
        rapport.push(rapportChamp(`items_toiture_metallique.${it.type}`, it, it.present ? '' : 'Absent des documents — retiré de la soumission'));
      }
      continue;
    }
    rapport.push(rapportChamp(cle, champ));
  }
  return rapport;
}

// ── Orchestrateur ────────────────────────────────────────────────────────
async function genererSoumissionPrivee({ systeme, langue, champs, numero }) {
  const templateFile = getTemplateFile(systeme, langue);
  if (!templateFile) throw new Error(`Système de toiture inconnu : ${systeme}`);

  const cleTemplate = sanitizeKey(templateFile);
  const zipData = await downloadBuffer(BUCKETS.TEMPLATES_SOUMISSION, cleTemplate);
  if (!zipData) throw new Error(`Template introuvable dans Supabase Storage : ${cleTemplate}`);

  const zip = await JSZip.loadAsync(zipData);
  const xmlFiles = Object.keys(zip.files).filter(f =>
    f.startsWith('word/') && f.endsWith('.xml') &&
    !f.includes('/_rels/') && !f.includes('theme') && !f.includes('settings') &&
    !f.includes('styles') && !f.includes('fontTable') && !f.includes('numbering') &&
    !f.includes('webSettings') && !f.includes('glossary/')
  );

  // Règles du système AVANT les règles communes : plus spécifiques, elles
  // doivent avoir priorité sur un motif générique qui pourrait accidentellement
  // correspondre au même paragraphe (voir le bug "isolant humide" vs
  // "contreplaqué", tous deux "$___/ pied carré", corrigé lors de la validation).
  const dateAujourdhui = new Date();
  const regles = [...((REGLES_PAR_SYSTEME[systeme] || (() => []))(champs)), ...reglesCommunes(champs, dateAujourdhui)];

  for (const fichier of xmlFiles) {
    const entry = zip.file(fichier);
    if (!entry) continue;
    const xmlOriginal = await entry.async('string');
    const xmlModifie = appliquerReglesParagraphes(xmlOriginal, regles);
    if (xmlModifie !== xmlOriginal) zip.file(fichier, xmlModifie);
  }

  const safeNumero = (numero || 'DRAFT').replace(/[^a-zA-Z0-9-]/g, '_');
  const outputFilename = `Soumission_${safeNumero}_${Date.now()}.docx`;
  const outputBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  await uploadBuffer(BUCKETS.SOUMISSIONS_GENEREES, sanitizeKey(outputFilename), outputBuffer,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  return {
    filename: outputFilename,
    templateUsed: templateFile,
    rapport: construireRapport(champs, systeme),
  };
}

module.exports = {
  TEMPLATE_MAP, LABELS_SYSTEME, selectTemplate, getTemplateFile,
  genererSoumissionPrivee, construireRapport, MARQUEUR_A_VALIDER,
};
