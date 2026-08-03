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
  labelVariants,
  inserer,
  escapeXml,
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
  FOURNISSEUR_ADRESSE: 'Adresse du fournisseur', FOURNISSEUR_TEL: 'Tél. du fournisseur',
  FABRICANT_ADRESSE: 'Adresse du fabricant', FABRICANT_TEL: 'Tél. du fabricant',
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

// Coordonnées OFFICIELLES FIXES des fabricants/fournisseurs connus — quand le
// nom saisi/extrait correspond, on utilise TOUJOURS ces valeurs telles
// quelles (nom normalisé + adresse + téléphone), demande utilisateur 2026-07 :
// la base matériaux ne stocke pas les adresses, et l'IA ne doit pas les
// deviner. Ajouter ici les autres fabricants au besoin.
const COORDONNEES_FABRICANTS = [
  {
    regex: /soprema/i,
    nom: 'Soprema Canada',
    adresse: '1295, rue Newton, #200\nBoucherville, Québec\nJ4B 5H2 Canada',
    telephone: '450-655-6676',
  },
];

function coordonneesConnues(nom) {
  if (!nom) return null;
  return COORDONNEES_FABRICANTS.find((c) => c.regex.test(nom)) || null;
}

function estFicheIdentification(xml) {
  return xml.includes(`FICHE D${APO}IDENTIFICATION`)
    || (xml.includes('SOUS-TRAITANT') && xml.includes('SPÉCIALITÉ (discipline)'));
}

// Titres de blocs d'intervenants de ce type de gabarit — servent de bornes
// de portée (fin du bloc courant = prochain titre) pour les gardes et les
// recherches scopées ci-dessous.
const TITRES_BLOCS_FICHE = ['PROPRIÉTAIRE', 'ARCHITECTE', 'INGÉNIEUR', 'INGENIEUR',
  'ENTREPRENEUR GÉNÉRAL', 'SOUS-TRAITANT', 'FOURNISSEUR', 'FABRICANT', 'PROJET'];

// Fin de la portée d'un bloc : prochain titre de bloc, prochain libellé fixe
// du gabarit (RÉVISION, RÉFÉRENCE…, REMARQUE, SPÉCIALITÉ) ou fin de tableau —
// le premier atteint. Sans ces libellés fixes, la garde blocDejaRempli
// compterait leur texte comme du « contenu » du bloc précédent.
function finDeBloc(xml, depuis) {
  const candidats = TITRES_BLOCS_FICHE
    .concat(['RÉVISION', 'RÉFÉRENCE AU PLAN', 'RÉFÉRENCE AU DEVIS', 'REMARQUE', 'SPÉCIALITÉ', '</w:tbl>'])
    .map((m) => xml.indexOf(m, depuis))
    .filter((i) => i !== -1);
  return candidats.length ? Math.min(...candidats) : xml.length;
}

// Certains gabarits de fiche d'identification arrivent DÉJÀ PRÉ-REMPLIS par
// l'architecte (ex. EPA / CPE Les Tourterelles : blocs PROJET, PROPRIÉTAIRE,
// ARCHITECTE, INGENIEUR, ENTREPRENEUR GÉNÉRAL imprimés dans le gabarit).
// Écrire par-dessus duplique le texte et pousse les dernières lignes hors du
// cadre (constaté : « J0P 1W0 », « T. 450-451-0025 » coupés en deux). On ne
// remplit donc un bloc d'intervenant QUE s'il est encore vide : on regarde le
// texte visible entre le libellé et le prochain titre de bloc, débarrassé des
// sous-libellés pré-imprimés (Responsable, T., Adresse…) — s'il reste de la
// substance, le bloc est déjà rempli.
function blocDejaRempli(xml, label) {
  const idx = xml.indexOf(label);
  if (idx === -1) return false;
  const fin = finDeBloc(xml, idx + label.length);
  const texte = (xml.slice(idx + label.length, fin).match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
    .map((t) => t.replace(/<[^>]+>/g, ''))
    .join(' ')
    .replace(/Chargée de projet|Responsable|Téléc\.?|Tél\.?|Adresse|No\. Projet|T\./g, '')
    .replace(/[:()_\s ]/g, '');
  return texte.length >= 8;
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
  // Un bloc pré-imprimé par l'architecte n'est NI rempli NI envoyé au bloc
  // « Renseignements complémentaires » (l'information y figure déjà).
  const fillSiVide = (cle, label, valeur) => {
    if (blocDejaRempli(xml, label)) return;
    fill(cle, label, valeur);
  };

  // Bloc PROJET (nom + établissement sur 2 lignes, comme sur les exemples réels)
  const projet = [champs.NOM_DU_PROJET, champs.NOM_ETABLISSEMENT].filter(Boolean).join('\n');
  fillSiVide('NOM_DU_PROJET', 'PROJET', projet);
  fill('NUMERO_DU_PROJET', 'No. Projet', champs.NUMERO_DU_PROJET);

  // Blocs intervenants (extraits du devis à l'étape /analyser, éditables)
  fillSiVide('NOM_ETABLISSEMENT', 'PROPRIÉTAIRE (CLIENT)', champs.NOM_ETABLISSEMENT);
  fillSiVide('ARCHITECTE', 'ARCHITECTE', champs.ARCHITECTE);
  // Le libellé existe avec ou sans accent selon le gabarit (« INGENIEUR: » sur
  // le gabarit EPA) — on tente les deux orthographes.
  if (xml.indexOf('INGÉNIEUR') !== -1) fillSiVide('INGENIEUR', 'INGÉNIEUR', champs.INGENIEUR);
  else fillSiVide('INGENIEUR', 'INGENIEUR', champs.INGENIEUR);
  fillSiVide('ENTREPRENEUR_GENERAL', 'ENTREPRENEUR GÉNÉRAL', champs.ENTREPRENEUR_GENERAL);

  // Bloc SOUS-TRAITANT = T3E. Sous-libellés scopés après l'ancre du bloc.
  fill('NOM', 'SOUS-TRAITANT', champs.NOM);
  const ancreST = xml.indexOf('SOUS-TRAITANT');
  if (ancreST !== -1) {
    const finST = finDeBloc(xml, ancreST + 'SOUS-TRAITANT'.length);
    // Adresse : si le bloc a un libellé « Adresse », remplissage normal ;
    // sinon (gabarit EPA : le bloc n'a que Responsable et T.), on insère
    // l'adresse dans le PREMIER PARAGRAPHE VIDE du bloc — surtout pas via un
    // saut de ligne après le nom, qui décale tout le bloc d'une ligne et
    // coupe le « T. » au bas du cadre (constaté sur le rendu PDF).
    if (xml.slice(ancreST, finST).includes('Adresse')) {
      fill('ADRESSE', 'Adresse', champs.ADRESSE, ancreST);
    } else if (champs.ADRESSE) {
      const paraVide = xml.indexOf('</w:pPr></w:p>', ancreST);
      if (paraVide !== -1 && paraVide < finST) {
        const insAt = paraVide + '</w:pPr>'.length;
        xml = xml.substring(0, insAt)
          + '<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">' + escapeXml(champs.ADRESSE) + '</w:t></w:r>'
          + xml.substring(insAt);
      }
    }
    fill('SOUMIS_PAR', 'Responsable', champs.SOUMIS_PAR, ancreST);
    // « Tél. : (   ) Téléc. : (   ) » cohabitent dans la même cellule → épissure
    // directe après chaque ":" + suppression des parenthèses vides pré-imprimées.
    // Le gabarit EPA abrège en « T. » (sans deux-points) — repli sur ce libellé.
    const rTel = epislerApresLibelle(xml, 'Tél.', champs.TELEPHONE, ancreST, true);
    xml = rTel.xml;
    if (!rTel.trouve && champs.TELEPHONE) {
      const posT = xml.indexOf('>T.', ancreST);
      if (posT !== -1 && posT < finDeBloc(xml, ancreST + 'SOUS-TRAITANT'.length)) {
        xml = xml.substring(0, posT + 3) + ' ' + escapeXml(champs.TELEPHONE) + xml.substring(posT + 3);
      }
    }
    // Télécopieur : rempli seulement si le gabarit a le libellé — sinon on
    // l'abandonne en silence (pas de renvoi vers « Renseignements
    // complémentaires », qui polluait le milieu de la page sur le gabarit EPA).
    const rFax = epislerApresLibelle(xml, 'Téléc.', champs.TELECOPIEUR, ancreST, true);
    xml = rFax.xml;
  }

  // Blocs FOURNISSEUR et FABRICANT : nom + (si fabricant connu, ex. Soprema)
  // adresse et téléphone officiels, scopés après l'ancre de chaque bloc —
  // ordre des cellules vérifié : la 1re occurrence de « Adresse : »/« Tél. : »
  // après chaque titre appartient bien à son bloc.
  // Repli : si le formulaire n'a pas de fournisseur distinct, le fabricant
  // fait office de fournisseur (constaté sur le gabarit EPA : bloc
  // FOURNISSEUR vide alors que le fabricant était connu).
  const nomFournisseur = champs.FOURNISSEUR || champs.FABRICANT;
  const infoFournisseur = coordonneesConnues(nomFournisseur);
  fill('FOURNISSEUR', 'FOURNISSEUR', infoFournisseur ? infoFournisseur.nom : nomFournisseur);
  const ancreFournisseur = xml.indexOf('FOURNISSEUR');
  if (infoFournisseur && ancreFournisseur !== -1) {
    fill('FOURNISSEUR_ADRESSE', 'Adresse', infoFournisseur.adresse, ancreFournisseur);
    episser('FOURNISSEUR_TEL', 'Tél.', infoFournisseur.telephone, ancreFournisseur, true);
  }

  // Bloc FABRICANT : seulement si le gabarit en a un (le gabarit EPA n'en a
  // pas — dans ce cas on abandonne en silence plutôt que de renvoyer la
  // valeur vers « Renseignements complémentaires »).
  if (xml.indexOf('FABRICANT') !== -1) {
    const infoFabricant = coordonneesConnues(champs.FABRICANT);
    fill('FABRICANT', 'FABRICANT', infoFabricant ? infoFabricant.nom : champs.FABRICANT);
    const ancreFabricant = xml.indexOf('FABRICANT');
    if (infoFabricant && ancreFabricant !== -1) {
      fill('FABRICANT_ADRESSE', 'Adresse', infoFabricant.adresse, ancreFabricant);
      episser('FABRICANT_TEL', 'Tél.', infoFabricant.telephone, ancreFabricant, true);
    }
  }

  // Sur ce gabarit la discipline attendue est « TOITURES » (vu sur les
  // exemples remplis) — « COUVREUR » est le défaut du gabarit T3E.
  const specialite = (!champs.SPECIALITE || /^couvreur$/i.test(champs.SPECIALITE.trim()))
    ? 'TOITURES' : champs.SPECIALITE;
  fill('SPECIALITE', 'SPÉCIALITÉ (discipline)', specialite);

  // NBRE DE PAGES = pages du document final soumis : pages du gabarit + pages
  // des fiches techniques jointes (calculées par la route). Le gabarit
  // Senterre fait 2 pages ; la variante EPA (« SOUS-TRAITANT: » collé, contenu
  // dupliqué en mc:Choice/mc:Fallback) tient sur 1 seule page.
  const pagesGabarit = xml.includes('SOUS-TRAITANT:') ? 1 : 2;
  if (Number.isFinite(champs.NB_PAGES_FT)) {
    fill('NB_PAGES', 'NBRE DE PAGES', String(pagesGabarit + champs.NB_PAGES_FT));
  }

  // Produit
  const description = [champs.TITRE, champs.DESCRIPTION && champs.DESCRIPTION !== champs.TITRE ? champs.DESCRIPTION : '']
    .filter(Boolean).join('\n');
  fill('DESCRIPTION', `DESCRIPTION DU DESSIN D${APO}ATELIER`, description);

  // Référence au devis : numéro de section (ex. « 07 52 16 ») après le
  // libellé principal ; « Section : ... Articles : ... » partagent la même
  // cellule → épissure. Section parente dérivée de l'article (2.4.1.2 → 2.4).
  // RÉFÉRENCE AU DEVIS : numéro de section SEUL (ex. « 07 31 13 ») — avec son
  // titre (« 07 31 13 – Bardeaux d'asphalte ») la valeur passe sur 2 lignes et
  // pousse « Section/Article » hors du cadre (constaté sur le gabarit EPA).
  const numeroSection = (String(champs.SECTION || '').match(/\d{2}\s?\d{2}\s?\d{2}/) || [champs.SECTION])[0];
  fill('SECTION', 'RÉFÉRENCE AU DEVIS', numeroSection);
  const ancreDevis = xml.indexOf('RÉFÉRENCE AU DEVIS');
  if (ancreDevis !== -1 && champs.ARTICLE) {
    // « Section : » et « Articles : » reçoivent TOUJOURS des valeurs EN
    // CHIFFRES (comme sur les exemples remplis : Section 2.4 / Articles
    // 2.4.1.2). L'IA renvoie parfois l'article avec son TITRE complet
    // (« 5 MEMBRANE ET SOLIN DE FINITION ÉLASTOMÈRE ») — on extrait la
    // partie numérique (5, 2.8, 2.4.1.2…) et on dérive la section parente
    // (préfixe à 2 segments ; l'article lui-même s'il est déjà court).
    const numerique = (String(champs.ARTICLE).match(/\d+(?:\.\d+)*/) || [String(champs.ARTICLE).trim()])[0];
    const sousSection = numerique.split('.').slice(0, 2).join('.') || numerique;
    // « Articles » (pluriel) sur le gabarit Senterre, « Article » (singulier)
    // sur le gabarit EPA — on tente le pluriel d'abord (le singulier matcherait
    // aussi le pluriel), puis le singulier en repli.
    const rArt = epislerApresLibelle(xml, 'Articles', numerique, ancreDevis);
    xml = rArt.xml;
    if (!rArt.trouve) episser('ARTICLE', 'Article', numerique, ancreDevis);
    episser('SOUS_SECTION', 'Section', sousSection, ancreDevis);
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

// ── Blocs d'intervenants génériques (gabarits tiers, ex. Leclerc/HEC) ───────
// Beaucoup de gabarits d'architectes organisent la page en TABLEAU à deux
// colonnes de blocs titrés (« SOUS-TRAITANT » à gauche, « FOURNISSEUR » à
// droite, etc.), chacun avec ses sous-libellés répétés (« Nom : »,
// « Coordonnées : », « Responsable : », « Tél. : »). Le repli IA se trompait
// régulièrement de bloc (constaté : le fournisseur écrit dans le Nom du
// sous-traitant) et n'est PAS déterministe d'une exécution à l'autre.
// Ici on parcourt les lignes du tableau : une ligne dont les cellules NE
// contiennent QUE des titres (re)définit les blocs actifs, dans l'ordre
// gauche→droite. Sur les lignes suivantes, chaque sous-libellé rencontré
// (ex. « Nom : ») est associé au bloc actif du MÊME RANG D'APPARITION dans
// la ligne (1er « Nom : » → 1er bloc, 2e « Nom : » → 2e bloc) plutôt qu'à un
// index de cellule brut — zéro IA.
const BLOC_TITRE_REGEX = /^(SOUS-TRAITANT|FOURNISSEUR|FABRICANT|MANUFACTURIER|ENTREPRENEUR(?:\s+GÉNÉRAL)?|PROFESSIONNEL|INGÉNIEUR|ARCHITECTE|PROPRIÉTAIRE)\b/;

function remplirBlocsIntervenants(xml, champs, champsNonTrouves) {
  const clesPlacees = new Set();
  const infoFour = coordonneesConnues(champs.FOURNISSEUR);
  const infoFab = coordonneesConnues(champs.FABRICANT);
  const enLigne = (info) => (info ? info.adresse.replace(/\n/g, ', ') : '');
  const coordonnees = (info) => [enLigne(info), info && info.telephone ? 'Tél. : ' + info.telephone : ''].filter(Boolean).join(' — ');

  // Par bloc : sous-libellé → [clé champs, valeur]. Les clés faisant partie
  // des libellés fixes (NOM, ADRESSE...) ne sont remplies ici que si le
  // passage par libellés exacts ne les a PAS déjà placées (champsNonTrouves).
  const CLES_LIBELLES_FIXES = new Set(['NOM', 'ADRESSE', 'SOUMIS_PAR', 'FOURNISSEUR', 'FABRICANT']);
  const blocs = {
    'SOUS-TRAITANT': {
      'Nom': ['NOM', champs.NOM],
      'Adresse': ['ADRESSE', champs.ADRESSE],
      'Coordonnées': ['ADRESSE', [champs.ADRESSE, champs.TELEPHONE ? 'Tél. : ' + champs.TELEPHONE : ''].filter(Boolean).join(' — ')],
      'Responsable': ['SOUMIS_PAR', champs.SOUMIS_PAR],
      'Tél.': ['TELEPHONE', champs.TELEPHONE],
      'Téléc.': ['TELECOPIEUR', champs.TELECOPIEUR],
    },
    'FOURNISSEUR': {
      'Nom': ['FOURNISSEUR', champs.FOURNISSEUR],
      'Adresse': ['FOURNISSEUR_ADRESSE', infoFour ? infoFour.adresse : ''],
      'Coordonnées': ['FOURNISSEUR_ADRESSE', coordonnees(infoFour)],
      'Tél.': ['FOURNISSEUR_TEL', infoFour ? infoFour.telephone : ''],
    },
    'FABRICANT': {
      'Nom': ['FABRICANT', champs.FABRICANT],
      'Adresse': ['FABRICANT_ADRESSE', infoFab ? infoFab.adresse : ''],
      'Coordonnées': ['FABRICANT_ADRESSE', coordonnees(infoFab)],
      'Tél.': ['FABRICANT_TEL', infoFab ? infoFab.telephone : ''],
    },
  };
  blocs.MANUFACTURIER = blocs.FABRICANT;

  const ops = [];
  // Bloc actifs de la ligne de titres la plus récente, dans l'ORDRE
  // D'APPARITION gauche→droite (ex. ["SOUS-TRAITANT", "FOURNISSEUR"]).
  // NE PAS suivre par index de cellule <w:tc> brut : certains gabarits (ex.
  // Leclerc/HEC) découpent chaque colonne visuelle en PLUSIEURS cellules
  // étroites (libellé + espaceur + zone de saisie) sur les lignes de
  // sous-libellés, alors que la ligne de titres utilise une seule cellule
  // large (w:gridSpan) par bloc — l'index de cellule brut ne correspond donc
  // PAS à la même colonne visuelle d'une ligne à l'autre (constaté : le bloc
  // FOURNISSEUR restait vide, son « Nom : » atterrissait sur un index de
  // colonne jamais initialisé). On suit plutôt, pour chaque sous-libellé
  // connu (ex. « Nom : »), le RANG D'APPARITION de ce libellé DANS LA LIGNE
  // (1er « Nom : » → 1er bloc actif, 2e « Nom : » → 2e bloc actif) : ce rang
  // correspond à l'ordre gauche→droite des blocs quel que soit le découpage
  // en cellules.
  let blocsActifs = [];
  const trRegex = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
  let tr;
  while ((tr = trRegex.exec(xml))) {
    const tcRegex = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
    let tc;
    const cellules = [];
    while ((tc = tcRegex.exec(tr[0]))) {
      const debutCellule = tr.index + tc.index;
      const finCellule = debutCellule + tc[0].length;
      const texte = tc[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      cellules.push({ debutCellule, finCellule, texte });
    }

    const titres = cellules
      .map((c) => (c.texte.length <= 60 ? BLOC_TITRE_REGEX.exec(c.texte) : null))
      .filter(Boolean)
      .map((m) => m[1]);
    if (titres.length > 0) {
      // Ligne de titres : (re)définit les blocs actifs pour les lignes
      // suivantes, dans l'ordre où ils apparaissent sur CETTE ligne.
      blocsActifs = titres;
      continue;
    }
    if (blocsActifs.length === 0) continue;

    const rangParLabel = {};
    for (const cellule of cellules) {
      // Sur ce type de gabarit, une cellule "libellé" ne contient QUE le
      // libellé (ex. "Nom :") — un match exact (pas juste "commence par")
      // évite de confondre avec une cellule de contenu qui contiendrait par
      // coïncidence le même mot.
      let label = null;
      for (const candidat of new Set(Object.values(blocs).flatMap((b) => Object.keys(b)))) {
        if (labelVariants(candidat).includes(cellule.texte)) { label = candidat; break; }
      }
      if (!label) continue;
      const rang = rangParLabel[label] || 0;
      rangParLabel[label] = rang + 1;
      const blocNom = blocsActifs[rang];
      const sousLibelles = blocNom && blocs[blocNom];
      if (!sousLibelles || !sousLibelles[label]) continue;
      const [cle, valeur] = sousLibelles[label];
      if (!valeur) continue;
      if (CLES_LIBELLES_FIXES.has(cle) && !(cle in champsNonTrouves)) continue;
      if (clesPlacees.has(cle)) continue;
      for (const variant of labelVariants(label)) {
        const idx = xml.indexOf(variant, cellule.debutCellule);
        if (idx === -1 || idx >= cellule.finCellule) continue;
        ops.push({ idx, variant, cle, valeur, label });
        clesPlacees.add(cle);
        break;
      }
    }
  }

  // Application en ordre décroissant de position pour ne pas décaler les
  // positions restantes. « Tél./Téléc. » partagent souvent la même cellule →
  // épissure directe après le ":" (+ retrait des parenthèses vides) ; les
  // autres via insertion multi-lignes standard.
  ops.sort((a, b) => b.idx - a.idx);
  for (const op of ops) {
    const pos = op.idx + op.variant.length;
    if (op.label === 'Tél.' || op.label === 'Téléc.') {
      let fin = pos;
      const m = xml.substring(pos, pos + 40).match(/^[\s ]*\([\s ]*\)/);
      if (m) fin = pos + m[0].length;
      xml = xml.substring(0, pos) + ' ' + escapeXml(op.valeur) + xml.substring(fin);
    } else {
      const closeIdx = xml.indexOf('</w:t>', pos);
      if (closeIdx === -1) continue;
      xml = inserer(xml, closeIdx, true, op.valeur);
    }
  }
  return { xml, clesPlacees };
}

async function remplirBordereau(champs, buf) {
  const templateBuf = buf || await downloadBuffer(BUCKETS.DOCUMENTS, TEMPLATE_KEY);
  if (!templateBuf) throw new Error('Template bordereau introuvable (Supabase Storage).');
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file('word/document.xml').async('string');

  xml = normalizeXmlText(xml);

  // Nom officiel des fabricants/fournisseurs connus (ex. « Soprema Canada »),
  // quel que soit le gabarit — la variante saisie/extraite peut différer
  // (« Soprema », « SOPREMA inc. », etc.).
  const four = coordonneesConnues(champs.FOURNISSEUR);
  if (four) champs = { ...champs, FOURNISSEUR: four.nom };
  const fab = coordonneesConnues(champs.FABRICANT);
  if (fab) champs = { ...champs, FABRICANT: fab.nom };

  // ARTICLE toujours EN CHIFFRES, quel que soit le gabarit : l'IA renvoie
  // parfois le numéro suivi du titre complet (« 5 MEMBRANE ET SOLIN DE
  // FINITION ÉLASTOMÈRE ») — sur le document final on ne veut que « 5 »
  // (ou « 2.4.1.2 »), comme sur les bordereaux remplis à la main.
  if (champs.ARTICLE) {
    const num = String(champs.ARTICLE).match(/\d+(?:\.\d+)*/);
    if (num) champs = { ...champs, ARTICLE: num[0] };
  }

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
  // Variante du même concept sur les gabarits d'architectes tiers (ex.
  // Leclerc : « Tel que documents ») — au plus une des deux formulations
  // existe dans un gabarit donné, donc aucune double coche possible.
  xml = cocherCaseACocher(xml, 'Tel que documents');

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
  const valeursPlacees = new Set();
  for (const [champKey, label, valeur] of remplacements) {
    const resultat = remplirChampDansXml(xml, label, valeur);
    xml = resultat.xml;
    if (!resultat.trouve && valeur) champsNonTrouves[champKey] = valeur;
    else if (resultat.trouve && valeur) valeursPlacees.add(valeur);
  }

  // Un champ introuvable dont la valeur est IDENTIQUE à celle d'un champ déjà
  // placé ne passe pas au repli IA : celui-ci réécrirait le même texte à un
  // second endroit — souvent le même run (bug constaté : TITRE === DESCRIPTION
  // sur la plupart des produits → « Soprastar Flam GR FRSoprastar Flam GR FR »
  // dans le champ Description d'un gabarit Leclerc).
  for (const [cle, valeur] of Object.entries(champsNonTrouves)) {
    if (valeursPlacees.has(valeur)) delete champsNonTrouves[cle];
  }

  // Blocs d'intervenants titrés en colonnes (gabarits tiers) : remplissage
  // déterministe AVANT le repli IA — les clés placées ici lui sont retirées.
  try {
    const blocRes = remplirBlocsIntervenants(xml, champs, champsNonTrouves);
    xml = blocRes.xml;
    for (const cle of blocRes.clesPlacees) delete champsNonTrouves[cle];
    if (blocRes.clesPlacees.size > 0) {
      console.log('[bordereau-filler] Blocs intervenants remplis (déterministe):', [...blocRes.clesPlacees].join(', '));
    }
  } catch (e) {
    console.error('[bordereau-filler] remplirBlocsIntervenants échoué (repli IA conservé):', e.message);
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
