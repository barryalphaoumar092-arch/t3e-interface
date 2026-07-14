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

  // Blocs FOURNISSEUR et FABRICANT : nom + (si fabricant connu, ex. Soprema)
  // adresse et téléphone officiels, scopés après l'ancre de chaque bloc —
  // ordre des cellules vérifié : la 1re occurrence de « Adresse : »/« Tél. : »
  // après chaque titre appartient bien à son bloc.
  const infoFournisseur = coordonneesConnues(champs.FOURNISSEUR);
  fill('FOURNISSEUR', 'FOURNISSEUR', infoFournisseur ? infoFournisseur.nom : champs.FOURNISSEUR);
  const ancreFournisseur = xml.indexOf('FOURNISSEUR');
  if (infoFournisseur && ancreFournisseur !== -1) {
    fill('FOURNISSEUR_ADRESSE', 'Adresse', infoFournisseur.adresse, ancreFournisseur);
    episser('FOURNISSEUR_TEL', 'Tél.', infoFournisseur.telephone, ancreFournisseur, true);
  }

  const infoFabricant = coordonneesConnues(champs.FABRICANT);
  fill('FABRICANT', 'FABRICANT', infoFabricant ? infoFabricant.nom : champs.FABRICANT);
  const ancreFabricant = xml.indexOf('FABRICANT');
  if (infoFabricant && ancreFabricant !== -1) {
    fill('FABRICANT_ADRESSE', 'Adresse', infoFabricant.adresse, ancreFabricant);
    episser('FABRICANT_TEL', 'Tél.', infoFabricant.telephone, ancreFabricant, true);
  }

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
    // « Section : » et « Articles : » reçoivent TOUJOURS des valeurs EN
    // CHIFFRES (comme sur les exemples remplis : Section 2.4 / Articles
    // 2.4.1.2). L'IA renvoie parfois l'article avec son TITRE complet
    // (« 5 MEMBRANE ET SOLIN DE FINITION ÉLASTOMÈRE ») — on extrait la
    // partie numérique (5, 2.8, 2.4.1.2…) et on dérive la section parente
    // (préfixe à 2 segments ; l'article lui-même s'il est déjà court).
    const numerique = (String(champs.ARTICLE).match(/\d+(?:\.\d+)*/) || [String(champs.ARTICLE).trim()])[0];
    const sousSection = numerique.split('.').slice(0, 2).join('.') || numerique;
    episser('ARTICLE', 'Articles', numerique, ancreDevis);
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
// Ici on parcourt les lignes/cellules du tableau en suivant le bloc actif PAR
// COLONNE : un titre de bloc rencontré dans la colonne c s'applique aux
// cellules suivantes de cette même colonne, jusqu'au titre suivant. Chaque
// sous-libellé est alors rempli d'après le bloc de SA colonne — zéro IA.
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
  const blocParColonne = {};
  const trRegex = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
  let tr;
  while ((tr = trRegex.exec(xml))) {
    const tcRegex = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
    let tc;
    let colonne = 0;
    while ((tc = tcRegex.exec(tr[0]))) {
      const debutCellule = tr.index + tc.index;
      const finCellule = debutCellule + tc[0].length;
      const texte = tc[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const titre = texte.length <= 60 ? BLOC_TITRE_REGEX.exec(texte) : null;
      if (titre) {
        // Tout titre (même un bloc qu'on ne remplit pas, ex. ENTREPRENEUR)
        // remplace le bloc actif de la colonne — évite de déborder plus bas.
        blocParColonne[colonne] = titre[1];
      } else if (blocParColonne[colonne] && blocs[blocParColonne[colonne]]) {
        const sousLibelles = blocs[blocParColonne[colonne]];
        for (const [label, [cle, valeur]] of Object.entries(sousLibelles)) {
          if (!valeur) continue;
          if (CLES_LIBELLES_FIXES.has(cle) && !(cle in champsNonTrouves)) continue;
          if (clesPlacees.has(cle)) continue;
          for (const variant of labelVariants(label)) {
            const idx = xml.indexOf(variant, debutCellule);
            if (idx === -1 || idx >= finCellule) continue;
            ops.push({ idx, variant, cle, valeur, label });
            clesPlacees.add(cle);
            break;
          }
        }
      }
      colonne++;
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
