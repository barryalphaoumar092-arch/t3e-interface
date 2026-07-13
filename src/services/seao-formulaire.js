// Remplissage des formulaires de soumission SEAO — contrairement aux
// bordereaux/manuels (gabarits T3E connus à l'avance), un formulaire SEAO est
// un document TIERS de structure totalement inconnue (varie d'un donneur
// d'ouvrage à l'autre). Il n'y a donc pas de liste de libellés à essayer en
// premier : on part directement du fallback IA générique
// (placerChampsRestantsViaIA), qui fonctionne sur le texte réellement présent
// dans CE document plutôt que sur une liste fixe.
const JSZip = require('jszip');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { normalizeXmlText, placerChampsRestantsViaIA } = require('./docx-xml-utils');
const { mapperChampsFormulairePdf, mapperChampsBordereau } = require('./claude-client');

const NOMS_LISIBLES = {
  NEQ: 'NEQ', RBQ: 'Numéro de licence RBQ', CCQ: 'Numéro de licence CCQ',
  CNESST_NUMERO: "Numéro d'employeur CNESST", NOM_ENTREPRISE: "Nom de l'entreprise",
  ADRESSE_ENTREPRISE: 'Adresse', TELEPHONE_ENTREPRISE: 'Téléphone',
  TELECOPIEUR_ENTREPRISE: 'Télécopieur', SITE_WEB: 'Site internet',
  COURRIEL_ENTREPRISE: 'Courriel corporatif', TPS_TVH: 'TPS/TVH', TVQ: 'TVQ',
  ASSURANCE_RESPONSABILITE_CIVILE: 'Assurance responsabilité civile',
  ASSURANCE_AUTOMOBILE: 'Assurance automobile', CAUTIONNEMENT: 'Cautionnement',
  SIGNATAIRE_AUTORISE: 'Signataire autorisé', REPRESENTANT_NOM: 'Nom du représentant',
  REPRESENTANT_TITRE: 'Titre du représentant',
  REPRESENTANT_COURRIEL: 'Courriel du représentant', REPRESENTANT_TELEPHONE: 'Téléphone du représentant',
  REPRESENTANT_CELLULAIRE: 'Cellulaire du représentant',
  FORME_JURIDIQUE: 'Forme juridique', NOMBRE_EMPLOYES_QUEBEC: 'Nombre d\'employés au Québec',
  CNESST_STATUT: 'Statut de conformité CNESST', FRANCISATION_STATUT: 'Statut de francisation',
  AMP_NUMERO_CLIENT: 'Numéro de client AMP', AMP_ECHEANCE: 'Échéance autorisation AMP',
  CERTIFICATIONS: 'Certifications',
};

// ══════════════════════════════════════════════════════════════
//  ZONES DU FORMULAIRE (priorité utilisateur #5) — un formulaire de
//  soumission SEAO n'est pas un document homogène : chaque partie a un usage
//  différent (identification vs prix vs signature légale...). On classe
//  chaque champ RÉELLEMENT DÉTECTÉ dans le document (pas une liste théorique
//  attendue, qui varierait d'un formulaire à l'autre) dans l'une de ces 8
//  zones, par mots-clés sur son nom/libellé — best-effort, jamais bloquant :
//  un champ qui ne correspond à aucun mot-clé tombe dans "Autre" plutôt que
//  de disparaître.
const ZONES = {
  couverture: 'Page de couverture',
  formulaire_principal: 'Formulaire principal',
  annexes: 'Annexes',
  bordereau_prix: 'Bordereau de prix',
  declaration_soumissionnaire: 'Déclaration du soumissionnaire',
  accuse_reception_addendas: 'Accusé de réception des addendas',
  signature: 'Signature',
  documents_a_joindre: 'Documents à joindre',
  autre: 'Autre',
};

const MOTS_CLES_ZONE = [
  ['couverture', /titre du projet|numero.*appel|no\.?\s*appel|date de publication|objet de l|donneur d.ouvrage/i],
  ['bordereau_prix', /prix|montant|ventilation|taxe|tps|tvq|sous-total|total|cout|\$/i],
  ['declaration_soumissionnaire', /declaration|atteste|certifie|soumissionnaire|conflit d.interet|integrite/i],
  ['accuse_reception_addendas', /addenda|addendum/i],
  ['signature', /signature|signataire|nom du signataire|titre du signataire|date de signature/i],
  ['documents_a_joindre', /joindre|annexer|piece jointe|document requis|doit etre joint/i],
  ['annexes', /annexe/i],
  ['formulaire_principal', /neq|rbq|entreprise|adresse|telephone|telecopieur|site web|assurance|cautionnement|licence|forme juridique|employe|cnesst|francisation|amp|certification/i],
];

function classifierZone(nomOuCle) {
  const texte = String(nomOuCle || '');
  for (const [zone, regex] of MOTS_CLES_ZONE) {
    if (regex.test(texte)) return zone;
  }
  return 'autre';
}

// Construit le detail structure { cle, nom, zone, valeur, source, statut }
// pour CHAQUE champ reellement detecte (place ou non) — sert au tableau de
// validation par zone. Les champs jamais places restent visibles avec un
// statut "Manquant" plutot que de disparaitre silencieusement.
function construireDetailChamps(champsPlaces, champsNonPlaces, valeurs) {
  const detail = [];
  const valeursParNomLisible = {};
  for (const [cle, valeur] of Object.entries(valeurs || {})) {
    valeursParNomLisible[NOMS_LISIBLES[cle] || cle] = valeur;
  }
  for (const nom of champsPlaces || []) {
    detail.push({
      nom,
      zone: classifierZone(nom),
      valeur: valeursParNomLisible[nom] || '',
      source: 'Base de connaissances T3E',
      statut: 'a_valider',
    });
  }
  for (const nom of champsNonPlaces || []) {
    // La valeur EST connue (aplatirInfosEntreprise() ne fournit jamais de
    // champ vide/falsy en amont) — seul le PLACEMENT automatique a echoue
    // (aucune case/blanc correspondant detecte dans CE document precis, ou
    // le champ ne s'y trouve simplement pas). Ne jamais afficher "Aucune"
    // source ni vider la valeur ici : ça donnait l'illusion trompeuse que la
    // donnée elle-même était inconnue, alors qu'elle est déjà dans la base
    // de connaissances T3E — seul un ajout manuel dans CE document est requis.
    detail.push({
      nom,
      zone: classifierZone(nom),
      valeur: valeursParNomLisible[nom] || '',
      source: 'Base de connaissances T3E (non localisé automatiquement)',
      statut: 'non_place',
    });
  }
  return detail;
}

// AVERTISSEMENTS n'est jamais un champ a placer sur le formulaire (ni via
// l'IA, ni via l'editeur visuel) — c'est une liste de mises en garde pour
// l'utilisateur, consommee separement par genererPageNotePreparation().
function aplatirInfosEntreprise(infosEntreprise) {
  const champs = {};
  for (const [cle, valeur] of Object.entries(infosEntreprise || {})) {
    if (cle === 'confiance' || cle === 'error' || cle === 'AVERTISSEMENTS') continue;
    if (cle === 'CERTIFICATIONS') {
      if (Array.isArray(valeur) && valeur.length > 0) champs.CERTIFICATIONS = valeur.join(', ');
      continue;
    }
    if (valeur) champs[cle] = valeur;
  }
  return champs;
}

// Page de synthese inseree en tete du PDF final lorsque l'IA a des mises en
// garde a communiquer (donnee trouvee pour une entite differente, attestation
// manquante...) — plutot que d'annoter le formulaire officiel lui-meme avec
// du texte visible (repere comme peu pro par l'utilisateur), on regroupe tout
// sur UNE page a part, clairement etiquetee comme a retirer avant depot.
// `champsNonPlaces` (priorité #5) : liste de noms de champs dont la VALEUR
// EST CONNUE (base de connaissances T3E) mais que le placement automatique
// n'a pas réussi à localiser dans CE document précis (aucune case/blanc
// correspondant détecté, ou le champ n'existe simplement pas dans ce
// formulaire). `valeursConnues` permet d'afficher la valeur directement dans
// la note plutôt que de laisser croire à l'utilisateur qu'il doit aller la
// chercher — bug signalé : la mention "CHAMPS ENCORE MANQUANTS" laissait
// entendre que ces informations (RBQ, CCQ, assurances...) étaient inconnues,
// alors qu'elles sont déjà fixées/mémorisées ; seul l'ajout manuel dans CE
// document précis (s'il les demande) reste à faire.
async function genererPageNotePreparation(pdfDoc, avertissements, champsNonPlaces, valeursConnues) {
  const aAvertir = avertissements && avertissements.length > 0;
  const aManquants = champsNonPlaces && champsNonPlaces.length > 0;
  // valeursConnues est keye par cle brute (NEQ, RBQ...) — champsNonPlaces par
  // libelle lisible (memes libelles que NOMS_LISIBLES) : reindexer par
  // libelle pour pouvoir associer chaque nom affiche a sa valeur.
  const valeursParNomLisible = {};
  for (const [cle, valeur] of Object.entries(valeursConnues || {})) {
    valeursParNomLisible[NOMS_LISIBLES[cle] || cle] = valeur;
  }
  const champsManquants = (champsNonPlaces || []).map((nom) => {
    const valeur = valeursParNomLisible[nom];
    return valeur ? `${nom} : ${valeur}` : nom;
  });
  if (!aAvertir && !aManquants) return;
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const PAGE_W = 612, PAGE_H = 792;
  const memo = pdfDoc.insertPage(0, [PAGE_W, PAGE_H]);
  let y = PAGE_H - 60;
  const titre = aManquants
    ? 'BROUILLON — NOTE DE PRÉPARATION — À RETIRER AVANT DÉPÔT'
    : 'NOTE DE PRÉPARATION — À RETIRER AVANT DÉPÔT';
  memo.drawText(titre, { x: 50, y, size: 14, font: fontBold });
  y -= 26;
  const lignes = [
    'Ce formulaire a été pré-rempli automatiquement à partir de la base de',
    'connaissances de Toitures Trois Étoiles Inc. Vérifiez chaque champ, en',
    'particulier les points ci-dessous, avant tout dépôt réel.',
  ];
  lignes.forEach((l) => { memo.drawText(l, { x: 50, y, size: 10, font }); y -= 16; });
  y -= 10;

  function ecrireListe(entete, items) {
    memo.drawText(entete, { x: 50, y, size: 11, font: fontBold }); y -= 18;
    items.forEach((av, i) => {
      const mots = String(av).split(' ');
      let ligne = `${i + 1}. `;
      for (const mot of mots) {
        if (font.widthOfTextAtSize(ligne + mot, 10) > PAGE_W - 100) {
          memo.drawText(ligne, { x: 50, y, size: 10, font }); y -= 15;
          ligne = '   ' + mot + ' ';
        } else {
          ligne += mot + ' ';
        }
      }
      memo.drawText(ligne, { x: 50, y, size: 10, font }); y -= 20;
    });
    y -= 10;
  }

  if (aManquants) ecrireListe('INFOS CONNUES NON LOCALISÉES DANS CE DOCUMENT (à ajouter manuellement si ce formulaire les demande) :', champsManquants);
  if (aAvertir) ecrireListe('MISES EN GARDE :', avertissements);
}

// .docx — réutilise le moteur partagé docx-xml-utils.js en mode "tout en
// fallback IA" (pas de libellé connu à essayer avant).
// NOTE : contrairement à remplirBordereau()/remplirManuel(), on n'appelle PAS
// ajouterChampsNonPlaces() ici — coller un paragraphe "Renseignements
// complémentaires" sur un formulaire officiel destiné à un donneur d'ouvrage
// public serait inapproprié. Les champs non placés sont retournés à
// l'appelant pour être présentés à l'utilisateur (saisie manuelle assistée),
// jamais insérés silencieusement dans le document final.
async function remplirFormulaireDocx(buf, infosEntreprise) {
  const zip = await JSZip.loadAsync(buf);
  const fichierXml = zip.file('word/document.xml');
  if (!fichierXml) throw new Error('Document .docx invalide (word/document.xml introuvable).');
  let xml = await fichierXml.async('string');
  xml = normalizeXmlText(xml);

  const champs = aplatirInfosEntreprise(infosEntreprise);
  const resultat = await placerChampsRestantsViaIA(xml, champs);
  xml = resultat.xml;

  zip.file('word/document.xml', xml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return {
    buffer,
    champsPlaces: Object.keys(champs).filter((c) => !(c in resultat.restants)).map((c) => NOMS_LISIBLES[c] || c),
    champsNonPlaces: Object.keys(resultat.restants).map((c) => NOMS_LISIBLES[c] || c),
  };
}

// PDF avec champs AcroForm réels — première utilisation de pdf-lib.getForm()
// dans ce repo. Liste les champs, demande à l'IA quelle valeur correspond à
// quel champ (par nom technique, généralement déjà sémantique dans un
// formulaire officiel), remplit, puis APLATIT (flatten) pour figer le rendu
// (évite qu'un futur logiciel PDF affiche des champs vides par-dessus le texte).
async function remplirFormulairePdfAcroForm(buf, infosEntreprise) {
  const pdfDoc = await PDFDocument.load(buf);
  const form = pdfDoc.getForm();
  const champsForm = form.getFields();
  if (champsForm.length === 0) {
    throw new Error('Aucun champ de formulaire (AcroForm) trouvé dans ce PDF — probablement un PDF plat/scanné.');
  }

  const noms = champsForm.map((c) => c.getName());
  const donnees = aplatirInfosEntreprise(infosEntreprise);
  const mapping = await mapperChampsFormulairePdf(noms, donnees);

  const champsPlaces = [];
  const champsNonPlaces = [];
  for (const champ of champsForm) {
    const nom = champ.getName();
    const valeur = mapping ? mapping[nom] : null;
    if (!valeur) { champsNonPlaces.push(nom); continue; }
    try {
      if (typeof champ.setText === 'function') {
        champ.setText(String(valeur));
        champsPlaces.push(nom);
      } else if (typeof champ.check === 'function') {
        // Case a cocher : on ne coche que sur une valeur explicitement positive
        if (/^(oui|yes|true|1|x)$/i.test(String(valeur).trim())) { champ.check(); champsPlaces.push(nom); }
        else champsNonPlaces.push(nom);
      } else {
        champsNonPlaces.push(nom);
      }
    } catch (e) {
      console.error('[seao-formulaire] Champ PDF non rempli:', nom, e.message);
      champsNonPlaces.push(nom);
    }
  }

  // NE PAS flatten() ici : l'utilisateur doit pouvoir valider/corriger les
  // champs (prix, exclusions...) dans son propre lecteur PDF avant dépôt —
  // l'aplatissement final se fera (si souhaité) au moment du "Générer le PDF".
  const buffer = Buffer.from(await pdfDoc.save());
  return { buffer, champsPlaces, champsNonPlaces };
}

// PDF plat (sans champs AcroForm) — cas le plus dur, traité en best-effort
// EXPLICITE : extrait le texte par ligne AVEC sa position (x, y) sur chaque
// page (pdf-parse avec un pagerender custom, même principe que texteParPage()
// dans document-parser.js mais en conservant la géométrie), réutilise
// mapperChampsBordereau() (même fonction IA que pour les .docx — son schéma
// "valeur -> index de texte" fonctionne identiquement ici, l'index pointant
// vers une LIGNE de PDF plutôt qu'un run Word) pour deviner où écrire, puis
// dessine par-dessus avec page.drawText() (pdf-lib). Si le PDF n'a AUCUNE
// couche de texte (scan pur sans OCR), on échoue explicitement plutôt que de
// deviner au hasard — l'OCR est hors scope de cette V1 (voir plan).
async function extraireLignesParPage(buf) {
  const pdfParse = require('pdf-parse');
  const pages = [];
  const pagerender = (pageData) => pageData.getTextContent({ normalizeWhitespace: false }).then((textContent) => {
    const lignes = [];
    let courante = null;
    for (const item of textContent.items) {
      const x = item.transform[4];
      const y = item.transform[5];
      if (courante && Math.abs(courante.y - y) < 2) {
        courante.texte += item.str;
      } else {
        courante = { texte: item.str, x, y };
        lignes.push(courante);
      }
    }
    const lignesUtiles = lignes.filter((l) => l.texte.trim());
    pages.push(lignesUtiles);
    return lignesUtiles.map((l) => l.texte).join('\n');
  });
  await pdfParse(buf, { pagerender });
  return pages;
}

// Relevé (400 → 1200, même raisonnement que docx-xml-utils.js) : au-delà de
// 400 lignes, tout le texte des pages suivantes d'un formulaire SEAO long
// n'était jamais transmis à l'IA — aucun champ ne pouvait s'y placer.
const LIMITE_LIGNES_IA = 1200;

async function remplirFormulairePdfPlat(buf, infosEntreprise) {
  const pagesLignes = await extraireLignesParPage(buf);
  const totalLignes = pagesLignes.reduce((s, p) => s + p.length, 0);
  if (totalLignes === 0) {
    throw new Error("Ce PDF ne contient aucun texte extractible (probablement un scan sans reconnaissance de texte) — remplissage automatique impossible, à compléter manuellement.");
  }

  const champs = aplatirInfosEntreprise(infosEntreprise);
  const entries = [];
  pagesLignes.forEach((lignes, p) => lignes.forEach((ligne, i) => entries.push({ page: p, ligne, texte: ligne.texte })));
  const entriesLimitees = entries.slice(0, LIMITE_LIGNES_IA);
  if (entries.length > LIMITE_LIGNES_IA) {
    console.warn(`[seao-formulaire] ${entries.length - LIMITE_LIGNES_IA} ligne(s) de fin de document non transmises à l'IA (plafond ${LIMITE_LIGNES_IA}).`);
  }

  const champsPlaces = [];
  const champsNonPlaces = [];
  let mapping = null;
  if (entriesLimitees.length > 0 && Object.keys(champs).length > 0) {
    try {
      mapping = await mapperChampsBordereau(entriesLimitees.map((e) => e.texte), champs);
    } catch (e) {
      console.error('[seao-formulaire] Mapping IA (PDF plat) échoué:', e.message);
    }
  }

  const pdfDoc = await PDFDocument.load(buf);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const ROUGE = rgb(0.784, 0.063, 0.180); // texte ajoute visuellement distinct de l'original

  // Case a cocher (☐/□) — repere quand une ligne COMMENCE par ce glyphe (le
  // texte extrait fusionne deja le glyphe + son libelle sur la meme ligne,
  // voir extraireLignesParPage : le glyphe est TOUJOURS le premier item
  // fusionne, donc ligne.x correspond a son origine reelle). Dessiner un
  // "X" en TEXTE a cet endroit atterrit visiblement A COTE de la case plutot
  // que DEDANS (probleme de metrique de police entre le glyphe source et la
  // police utilisee pour l'overlay) — un "X" VECTORIEL (deux traits
  // diagonaux) dans une petite boite centree sur l'origine du glyphe reste
  // correct quelle que soit la police d'origine.
  const REGEX_CASE_A_COCHER = /^[☐□❑▢]/;
  // Repli : certains formulaires dessinent la case a cocher en VECTEUR dans
  // le PDF source (invisible a l'extraction de texte — aucun glyphe ☐/□ n'est
  // present) mais font systematiquement preceder chaque option d'une lettre
  // entre parentheses ("(a) qu'il n'a en aucun moment...", "(b) qu'il a...")
  // — motif tres courant dans les declarations legales des formulaires SEAO
  // quebecois. Quand aucun glyphe n'est trouve, on detecte ce motif et on
  // estime la position de la case dans la marge a gauche de la lettre
  // (decalage fixe, jamais mesure precisement — meilleur effort documente).
  const REGEX_OPTION_LETTRE = /^\([a-z0-9]\)\s/i;
  const DECALAGE_CASE_ESTIMEE = 15;
  function estLigneCheckbox(ligne) {
    return REGEX_CASE_A_COCHER.test(ligne.texte.trim()) || REGEX_OPTION_LETTRE.test(ligne.texte.trim());
  }
  function cocherCase(page, ligne) {
    const taille = 8;
    const x = REGEX_CASE_A_COCHER.test(ligne.texte.trim()) ? ligne.x : Math.max(0, ligne.x - DECALAGE_CASE_ESTIMEE);
    const x0 = x, y0 = ligne.y, x1 = x + taille, y1 = ligne.y + taille;
    page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 1.1, color: ROUGE });
    page.drawLine({ start: { x: x0, y: y1 }, end: { x: x1, y: y0 }, thickness: 1.1, color: ROUGE });
  }
  const REGEX_DIACRITIQUES = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');
  function normaliserTexte(s) {
    return String(s || '').normalize('NFD').replace(REGEX_DIACRITIQUES, '').toLowerCase().trim();
  }
  // FORME_JURIDIQUE encode PLUSIEURS cases a cocher simultanement (ex.
  // "Societe par actions, regime provincial (Quebec)" = 3 cases distinctes :
  // "Societe par actions" + "Regime provincial" + "Quebec") alors que
  // mapperChampsBordereau() ne retourne qu'UN SEUL index par champ. Le
  // laisser choisir a deja mene a cocher a tort une case sans rapport (ex.
  // "Autre") au lieu des bonnes. On coche donc directement TOUTE case dont
  // le libelle apparait tel quel dans la valeur, sans passer par l'IA pour
  // ce champ precis.
  function cocherCasesFormeJuridique(valeur) {
    const valeurNorm = normaliserTexte(valeur);
    let nbCochees = 0;
    for (const entree of entriesLimitees) {
      const texte = entree.ligne.texte.trim();
      if (!REGEX_CASE_A_COCHER.test(texte)) continue;
      // Une rangee de tableau peut contenir PLUSIEURS cases cote a cote (ex.
      // "☐ Societe par actions ☐ Regime federal") — extraireLignesParPage
      // fusionne tout ce qui partage le meme Y en UNE seule "ligne", donc il
      // faut redecouper au niveau de CHAQUE glyphe ☐/□/❑/▢ plutot que de ne
      // traiter que le premier. La position x de chaque morceau est estimee
      // en cumulant la largeur des morceaux precedents (jamais mesuree
      // precisement, meme principe que les autres positions estimees).
      const morceaux = texte.split(/(?=[☐□❑▢])/).filter(Boolean);
      let xCumul = entree.ligne.x;
      for (const morceau of morceaux) {
        const label = morceau.replace(REGEX_CASE_A_COCHER, '').trim();
        const labelNorm = normaliserTexte(label);
        if (labelNorm.length >= 4 && valeurNorm.includes(labelNorm)) {
          cocherCase(pdfDoc.getPage(entree.page), { x: xCumul, y: entree.ligne.y, texte: morceau });
          nbCochees++;
        }
        // widthOfTextAtSize() sur le morceau BRUT (glyphe ☐/□/❑/▢ inclus)
        // fait planter pdf-lib ("WinAnsi cannot encode") — la police
        // standard WinAnsi ne sait pas encoder ces symboles. Mesurer le
        // libelle seul (deja debarrasse du glyphe) suffit, l'ecart de
        // largeur du glyphe lui-meme sur l'estimation cumulee est
        // negligeable face a la marge d'erreur deja assumee ici.
        xCumul += font.widthOfTextAtSize(label, 9);
      }
    }
    return nbCochees;
  }

  // Un vrai formulaire SEAO separe souvent le libelle ("Adresse :") de sa
  // ligne a blanc ("________") — parfois sur la MEME ligne (le blanc suit le
  // libelle), parfois sur la ligne SUIVANTE (le libelle seul, le blanc en
  // dessous). Ecrire naivement juste apres le TEXTE ENTIER de la ligne
  // choisie par l'IA place la valeur au mauvais endroit dans les deux cas
  // (soit collee au libelle si le blanc est plus bas, soit tres loin a
  // droite du blanc puisque son propre texte inclut deja les "_____").
  // On cherche donc explicitement ou commence le blanc (suite de "_").
  // `apresIndex` : ne cherche le blanc qu'A PARTIR de cette position. Sans
  // ca, deux champs distincts fusionnes sur la MEME ligne visuelle par
  // extraireLignesParPage() (ex. "Telephone : ____ Telecopieur : ____", ou
  // "TPS/TVH : ____ TVQ : ____") trouvaient tous les deux le PREMIER blanc de
  // la ligne (celui du premier champ) et s'ecrivaient l'un par-dessus
  // l'autre au meme endroit — meme classe de bug que
  // cocherCasesFormeJuridique() (plusieurs elements sur une ligne fusionnee),
  // mais pour du texte plutot que des cases a cocher.
  function trouverDebutBlanc(texte, apresIndex = 0) {
    const m = texte.slice(apresIndex).match(/_{3,}/);
    return m ? apresIndex + m.index : -1;
  }
  // Localise ou commence le libelle de CE champ dans la ligne fusionnee, pour
  // ne chercher son blanc qu'apres cette position (voir ci-dessus). Retourne
  // 0 (comportement d'origine, premier blanc de la ligne) si le libelle n'y
  // est pas trouve tel quel.
  function positionLabelDansLigne(cle, texte) {
    const label = NOMS_LISIBLES[cle];
    if (!label) return 0;
    const idx = texte.toLowerCase().indexOf(label.toLowerCase());
    return idx >= 0 ? idx : 0;
  }

  // Certaines valeurs (assurances, certifications...) sont trop longues pour
  // tenir sur la largeur restante de la ligne a partir de x — les dessiner
  // telles quelles a taille fixe les faisait deborder de la page ou
  // chevaucher le texte voisin. Reduit la taille de police par paliers, puis
  // si meme la plus petite taille deborde encore, decoupe en plusieurs
  // lignes empilees sous le point de depart plutot que de laisser deborder.
  const TAILLES_TEXTE = [9, 8, 7, 6];
  function dessinerTexteAdapte(page, texte, x, y) {
    const margeDroite = 40;
    const largeurDisponible = page.getWidth() - x - margeDroite;
    if (largeurDisponible <= 20) { page.drawText(texte, { x, y, size: 6, font, color: ROUGE }); return; }
    for (const taille of TAILLES_TEXTE) {
      if (font.widthOfTextAtSize(texte, taille) <= largeurDisponible) {
        page.drawText(texte, { x, y, size: taille, font, color: ROUGE });
        return;
      }
    }
    // Meme la plus petite taille deborde : decoupe en mots sur plusieurs lignes.
    const taille = TAILLES_TEXTE[TAILLES_TEXTE.length - 1];
    const mots = texte.split(' ');
    let ligne = '';
    let yCourant = y;
    for (const mot of mots) {
      const essai = ligne ? `${ligne} ${mot}` : mot;
      if (font.widthOfTextAtSize(essai, taille) > largeurDisponible && ligne) {
        page.drawText(ligne, { x, y: yCourant, size: taille, font, color: ROUGE });
        yCourant -= taille + 2;
        ligne = mot;
      } else {
        ligne = essai;
      }
    }
    if (ligne) page.drawText(ligne, { x, y: yCourant, size: taille, font, color: ROUGE });
  }

  for (const cle of Object.keys(champs)) {
    if (cle === 'FORME_JURIDIQUE') {
      const nbCochees = cocherCasesFormeJuridique(champs[cle]);
      if (nbCochees > 0) champsPlaces.push(NOMS_LISIBLES[cle] || cle);
      else champsNonPlaces.push(NOMS_LISIBLES[cle] || cle);
      continue;
    }
    const idx = mapping ? mapping[cle] : null;
    const entree = (idx !== null && idx !== undefined) ? entriesLimitees[idx] : null;
    if (!entree) { champsNonPlaces.push(NOMS_LISIBLES[cle] || cle); continue; }
    try {
      const page = pdfDoc.getPage(entree.page);
      if (estLigneCheckbox(entree.ligne)) {
        cocherCase(page, entree.ligne);
        champsPlaces.push(NOMS_LISIBLES[cle] || cle);
        continue;
      }
      let ligneCible = entree.ligne;
      let decalageX;
      const debutRechercheLigne = positionLabelDansLigne(cle, entree.ligne.texte);
      const posBlancMemeLigne = trouverDebutBlanc(entree.ligne.texte, debutRechercheLigne);
      if (posBlancMemeLigne >= 0) {
        decalageX = font.widthOfTextAtSize(entree.ligne.texte.substring(0, posBlancMemeLigne), 9) + 6;
      } else {
        const suivante = entriesLimitees[idx + 1];
        const debutRechercheSuivante = suivante ? positionLabelDansLigne(cle, suivante.texte) : 0;
        const posBlancSuivante = suivante ? trouverDebutBlanc(suivante.texte, debutRechercheSuivante) : -1;
        if (suivante && suivante.page === entree.page && posBlancSuivante >= 0) {
          ligneCible = suivante.ligne;
          decalageX = font.widthOfTextAtSize(suivante.texte.substring(0, posBlancSuivante), 9) + 6;
        } else {
          // Repli : aucune ligne a blanc identifiee, comportement precedent.
          decalageX = font.widthOfTextAtSize(entree.ligne.texte, 9) + 12;
        }
      }
      dessinerTexteAdapte(page, String(champs[cle]), ligneCible.x + decalageX, ligneCible.y);
      champsPlaces.push(NOMS_LISIBLES[cle] || cle);
    } catch (e) {
      console.error('[seao-formulaire] Champ PDF plat non dessine:', cle, e.message);
      champsNonPlaces.push(NOMS_LISIBLES[cle] || cle);
    }
  }

  const buffer = Buffer.from(await pdfDoc.save());
  return { buffer, champsPlaces, champsNonPlaces };
}

module.exports = {
  remplirFormulaireDocx, remplirFormulairePdfAcroForm, remplirFormulairePdfPlat,
  aplatirInfosEntreprise, NOMS_LISIBLES, genererPageNotePreparation,
  ZONES, classifierZone, construireDetailChamps,
};
