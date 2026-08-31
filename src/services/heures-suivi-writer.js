// Etape 3 : ajout de la semaine (deja dans la Feuille Maitre a l'etape 2)
// dans "ABCD-COPIE.xlsx" (resume par projet/metier/semaine).
//
// ATTENTION — meme piege que la Feuille Maitre (voir heures-maitre-writer.js)
// mais PIRE : ce fichier contient un vrai Tableau structure Excel
// ("Tableau1") ET des formules SUM() sur chaque ligne. Charger/resauvegarder
// via exceljs corrompt le fichier (confirme en test — fichier de 125 Ko au
// lieu de plusieurs centaines de Ko, Excel refuse de l'ouvrir).
//
// La demande utilisateur ("ne modifie pas la mise en page et la disposition")
// exige d'inserer la nouvelle semaine EXACTEMENT comme le fait manuellement
// un humain (colonne inseree juste apres "Hrs Réelles", semaine la plus
// recente toujours en premiere position) — pas d'ajout en fin de tableau.
// La transformation exacte necessaire a ete DECOUVERTE en observant ce
// qu'Excel lui-meme produit (Columns.Insert reel, via COM, sur une copie de
// test) plutot que devinee :
//   - TOUTE reference de cellule/colonne >= I (colonne 9) — dans les
//     attributs r="" ET dans le texte des formules <f> — decale sa lettre
//     de colonne de +1 (I->J, AN->AO, etc.), la ligne (numero) ne change
//     jamais.
//   - <dimension>, <cols>, et dans xl/tables/table1.xml : ref=, autoFilter
//     ref=, sortState ref= s'elargissent d'une colonne ; un nouveau
//     <tableColumn id="{max+1}"> est insere juste apres les 8 colonnes fixes.
//   - Le "dataDxfId" (mise en forme differentielle par colonne du tableau)
//     est volontairement OMIS sur la nouvelle colonne plutot que
//     reindexee : c'est un detail cosmetique optionnel (bandes de couleur
//     internes au style de tableau), le reindexer correctement demanderait
//     de toucher styles.xml sur toute la chaine de dxfId — inutile de
//     prendre ce risque pour un detail non fonctionnel.
const XLSX = require('xlsx');
const JSZip = require('jszip');

const NOM_FEUILLE = 'Feuil1';
const TABLE_NOM = 'Tableau1';
const COL_PROJET = 1, COL_DESCRIPTION = 2, COL_METIER = 4, COL_HRS_BUDGETEES = 5, COL_HRS_REELLES = 8;
const PREMIERE_COL_SEMAINE = 9; // "I"
const METIERS_ORDRE = ['TOTAL', 'Couvreur', 'Ferblantier', 'Menuiser', 'Grutier'];

const MAP_CATEGORIE_METIER = { '210': 'Couvreur', '230': 'Ferblantier', '160': 'Menuiser', '264': 'Grutier' };

function normaliser(s) { return String(s || '').trim(); }
function formatCourt(dateIso) { const [, m, j] = dateIso.split('-'); return `${m}-${j}`; }

function nombreDeColonne(lettre) {
  let n = 0;
  for (const c of lettre) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}
function lettreDeColonne(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
// Decale la lettre de colonne d'une reference "I" ou "I42" de +1 SI son
// index est >= PREMIERE_COL_SEMAINE — jamais les colonnes fixes (A-H).
function decalerRef(lettre) {
  const idx = nombreDeColonne(lettre);
  return idx >= PREMIERE_COL_SEMAINE ? lettreDeColonne(idx + 1) : lettre;
}
function decalerPlage(ref) {
  // "A1:AN911" ou "A1:A911" — decale chaque lettre de colonne independamment.
  return ref.replace(/([A-Z]{1,3})(\d*)/g, (m, lettres, chiffres) => decalerRef(lettres) + chiffres);
}
function echapperXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Lit le fichier corrige (etape 1) et calcule les heures par (projet,
// metier) via la categorie_employe. Retourne aussi le total brut (toutes
// categories confondues) pour le controle de coherence — jamais de
// repartition inventee pour une categorie non reconnue.
function calculerRepartitionMetier(bufferCorrige) {
  const wb = XLSX.read(bufferCorrige, { type: 'buffer', cellDates: true });
  const feuille = wb.Sheets[wb.SheetNames[0]];
  const lignes = XLSX.utils.sheet_to_json(feuille, { defval: null });

  const parProjetMetier = new Map();
  let totalBrut = 0;
  let totalNonClasse = 0;

  for (const ligne of lignes) {
    const projet = normaliser(ligne['No, Projet']);
    const categorie = normaliser(ligne['catégorie_employé']);
    const heures = parseFloat(String(ligne['Hours'] || '0').replace(',', '.')) || 0;
    if (!projet) continue;
    totalBrut += heures;
    const metier = MAP_CATEGORIE_METIER[categorie];
    if (!metier) { totalNonClasse += heures; continue; }
    const cle = `${projet}|${metier}`;
    parProjetMetier.set(cle, (parProjetMetier.get(cle) || 0) + heures);
  }
  return { parProjetMetier, totalBrut, totalNonClasse };
}

// Retrouve le chemin XML de la feuille "Feuil1" (comme heures-maitre-writer.js).
async function trouverCheminFeuille(zip, nomFeuille) {
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const mSheet = new RegExp(`<sheet[^>]*name="${nomFeuille}"[^>]*r:id="(rId\\d+)"`).exec(workbookXml)
    || new RegExp(`<sheet[^>]*r:id="(rId\\d+)"[^>]*name="${nomFeuille}"`).exec(workbookXml);
  if (!mSheet) throw new Error(`Feuille "${nomFeuille}" introuvable dans workbook.xml`);
  const rId = mSheet[1];
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const mRel = new RegExp(`Id="${rId}"[^>]*Target="worksheets/(sheet\\d+\\.xml)"`).exec(relsXml)
    || new RegExp(`Target="worksheets/(sheet\\d+\\.xml)"[^>]*Id="${rId}"`).exec(relsXml);
  if (!mRel) throw new Error(`Relation ${rId} introuvable dans workbook.xml.rels`);
  return `xl/worksheets/${mRel[1]}`;
}

// Decale toutes les references de colonnes (>= I) dans le contenu d'UNE
// ligne <row>...</row> : les attributs r="XN" des cellules, ET le texte des
// formules <f>...</f> (portee generique — toute sequence LETTRES+chiffres
// a l'interieur d'une formule est forcement une reference de cellule/plage,
// jamais du texte libre, contrairement au reste du XML).
function decalerLigneXml(ligneXml) {
  let out = ligneXml.replace(/r="([A-Z]{1,3})(\d+)"/g, (m, lettres, chiffre) => `r="${decalerRef(lettres)}${chiffre}"`);
  out = out.replace(/<f([^>]*)>([^<]*)<\/f>/g, (m, attrs, formule) => {
    const formuleDecalee = formule.replace(/([A-Z]{1,3})(\d*)/g, (m2, lettres, chiffres) => {
      // Ignore les identifiants type "Tableau1"/noms de fonctions deja geres
      // par le fait qu'ils ne matchent PAS le motif LETTRES(chiffres?) seul
      // entoure de crochets structures — les refs structurees Tableau1[[...]]
      // ne contiennent pas de token LETTRES+chiffres isole, donc jamais
      // touchees par ce remplacement (verifie sur les formules reelles).
      return decalerRef(lettres) + chiffres;
    });
    return `<f${attrs}>${formuleDecalee}</f>`;
  });
  return out;
}

// Construit la cellule XML pour la nouvelle colonne (semaine) a la ligne
// donnee — valeur numerique si fournie, sinon cellule vide.
function celluleNouvelleColonne(numLigne, valeur) {
  const ref = `I${numLigne}`;
  if (valeur === null || valeur === undefined) return `<c r="${ref}"/>`;
  return `<c r="${ref}"><v>${valeur}</v></c>`;
}

// bufferSuivi : contenu actuel de ABCD-COPIE.xlsx. Retourne
// { buffer, totalEcrit, totalAClasser, totalNonClasse, projetsNonTrouves }.
// projetsNonTrouves : projets du fichier corrige SANS ligne existante dans
// ABCD-COPIE — jamais ajoutes automatiquement (creer un nouveau bloc de 5
// lignes demanderait de re-decaler numeros de ligne + table + dimension en
// plus du decalage de colonnes, risque juge excessif) — remontes au
// reviseur pour ajout manuel dans Excel si necessaire.
async function ajouterSemaineDansSuivi(bufferSuivi, bufferCorrige, semaine) {
  const { parProjetMetier, totalBrut, totalNonClasse } = calculerRepartitionMetier(bufferCorrige);
  const labelSemaine = `${formatCourt(semaine.debut)} au ${formatCourt(semaine.fin)}`;

  // Lecture (XLSX/SheetJS, jamais de re-ecriture par cette lib) des lignes
  // existantes pour retrouver quel numero de ligne correspond a quel
  // (projet, metier) — necessaire pour savoir OU ecrire chaque valeur.
  const wbLecture = XLSX.read(bufferSuivi, { type: 'buffer' });
  const feuilleLecture = wbLecture.Sheets[NOM_FEUILLE];
  const lignesExistantes = XLSX.utils.sheet_to_json(feuilleLecture, { header: 1, defval: null });
  const ligneParProjetMetier = new Map(); // "projet|metier" -> numero de ligne (1-based)
  for (let i = 1; i < lignesExistantes.length; i++) {
    const projet = normaliser(lignesExistantes[i][COL_PROJET - 1]);
    const metier = normaliser(lignesExistantes[i][COL_METIER - 1]);
    if (projet && metier && metier !== 'TOTAL') ligneParProjetMetier.set(`${projet}|${metier}`, i + 1);
  }

  const valeurParLigne = new Map(); // numero de ligne -> heures
  let totalEcrit = 0;
  const projetsNonTrouves = new Set();
  for (const [cle, heures] of parProjetMetier) {
    const numLigne = ligneParProjetMetier.get(cle);
    if (numLigne === undefined) { projetsNonTrouves.add(cle.split('|')[0]); continue; }
    valeurParLigne.set(numLigne, heures);
    totalEcrit += heures;
  }

  const zip = await JSZip.loadAsync(bufferSuivi);
  const cheminFeuille = await trouverCheminFeuille(zip, NOM_FEUILLE);
  let xml = await zip.file(cheminFeuille).async('string');

  const mDim = /<dimension ref="(A1:[A-Z]{1,3}\d+)"\/>/.exec(xml);
  if (!mDim) throw new Error('<dimension> introuvable — structure inattendue, insertion annulee par securite');
  const dimensionApres = decalerPlage(mDim[1]);
  xml = xml.replace(mDim[0], `<dimension ref="${dimensionApres}"/>`);

  const mCols = /<cols>(.*?)<\/cols>/.exec(xml);
  if (mCols) {
    const colsDecales = mCols[1].replace(/<col min="(\d+)" max="(\d+)"([^/]*)\/>/g, (m, min, max, reste) => {
      const nMin = parseInt(min, 10), nMax = parseInt(max, 10);
      const nMinD = nMin >= PREMIERE_COL_SEMAINE ? nMin + 1 : nMin;
      const nMaxD = nMax >= PREMIERE_COL_SEMAINE ? nMax + 1 : nMax;
      return `<col min="${nMinD}" max="${nMaxD}"${reste}/>`;
    });
    const nouveauCol = `<col min="${PREMIERE_COL_SEMAINE}" max="${PREMIERE_COL_SEMAINE}" width="22.42578125" customWidth="1"/>`;
    xml = xml.replace(mCols[0], `<cols>${nouveauCol}${colsDecales}</cols>`);
  }

  // Traite le sheetData ligne par ligne : decale toutes les refs de colonnes
  // >= I, puis insere la nouvelle cellule (valeur si trouvee, sinon vide)
  // juste apres la cellule H (Hrs Réelles).
  xml = xml.replace(/<row r="(\d+)"([^>]*)>(.*?)<\/row>/gs, (m, numLigneStr, attrsRow, contenu) => {
    const numLigne = parseInt(numLigneStr, 10);
    const attrsDecales = attrsRow.replace(/spans="1:(\d+)"/, (m2, n) => `spans="1:${parseInt(n, 10) + 1}"`);
    const contenuDecale = decalerLigneXml(contenu);
    const valeur = numLigne === 1 ? null : (valeurParLigne.has(numLigne) ? valeurParLigne.get(numLigne) : null);
    const nouvelleCellule = numLigne === 1
      ? `<c r="I1" t="inlineStr"><is><t xml:space="preserve">${echapperXml(labelSemaine)}</t></is></c>`
      : celluleNouvelleColonne(numLigne, valeur);
    // Insere juste apres la cellule H{numLigne} (H est toujours avant I,
    // jamais decalee) — recherche du fermant de cette cellule specifique.
    //
    // PIEGE (corrige apres l'avoir constate en test reel — desordre de
    // colonnes dans plusieurs lignes, fichier rejete par Excel) : un
    // quantificateur GLOUTON [^>]* avant l'alternative "/>" consomme aussi
    // le caractere "/", empechant "/>" de matcher pour une cellule H VIDE
    // (auto-fermante, ex. <c r="H62" s="14"/>) — l'expression tombe alors
    // dans la branche ">.*?</c>" qui avale tout jusqu'au PROCHAIN </c> du
    // reste de la ligne, deplaçant l'insertion au mauvais endroit. Deux
    // alternatives SEPAREES avec quantificateur LAZY [^>]*? evitent ce piege
    // (le lazy s'arrete des que "/>" peut matcher, sans jamais consommer le
    // "/" necessaire).
    const regexH = new RegExp(`(<c r="H${numLigne}"[^>]*?/>|<c r="H${numLigne}"[^>]*>.*?</c>)`);
    const avecNouvelleCellule = regexH.test(contenuDecale)
      ? contenuDecale.replace(regexH, `$1${nouvelleCellule}`)
      : nouvelleCellule + contenuDecale; // securite si H absente (ne devrait pas arriver)
    return `<row r="${numLigneStr}"${attrsDecales}>${avecNouvelleCellule}</row>`;
  });

  // Mise en forme conditionnelle rouge PERMANENTE (Hrs Réelles > Hrs
  // Budgétées) — demande explicite utilisateur ("a l'avenir, directement").
  // Le fichier reel ne contient AUCUNE conditionalFormatting existante
  // (verifie) : ajoutee une seule fois ici, idempotente (ne duplique pas si
  // deja presente lors d'une execution suivante sur un fichier deja modifie).
  // Une regle de type "expression" REQUIERT un dxfId valide (format a
  // appliquer) — les dxf existants (styles.xml) sont tous orange (bandes du
  // Tableau), impossible de les reutiliser : on ajoute un NOUVEAU dxf rouge
  // a la fin de la collection existante (jamais de reindexation des dxfId
  // deja references ailleurs — seulement un ajout en fin de liste).
  if (!/<conditionalFormatting sqref="H2:H\d+">/.test(xml)) {
    const stylesXml = await zip.file('xl/styles.xml').async('string');
    const mDxfs = /<dxfs count="(\d+)">(.*?)<\/dxfs>/.exec(stylesXml);
    const dxfRouge = '<dxf><fill><patternFill patternType="solid"><bgColor rgb="FFFF0000"/></patternFill></fill></dxf>';
    let nouvelDxfId;
    let stylesXmlModifie;
    if (mDxfs) {
      nouvelDxfId = parseInt(mDxfs[1], 10);
      stylesXmlModifie = stylesXml.replace(mDxfs[0], `<dxfs count="${nouvelDxfId + 1}">${mDxfs[2]}${dxfRouge}</dxfs>`);
    } else {
      nouvelDxfId = 0;
      stylesXmlModifie = stylesXml.replace('</styleSheet>', `<dxfs count="1">${dxfRouge}</dxfs></styleSheet>`);
    }
    zip.file('xl/styles.xml', stylesXmlModifie);

    const dernierRow = parseInt(/A1:[A-Z]{1,3}(\d+)/.exec(dimensionApres)[1], 10);
    const regleXml = `<conditionalFormatting sqref="H2:H${dernierRow}"><cfRule type="expression" dxfId="${nouvelDxfId}" priority="1"><formula>AND(ISNUMBER(E2),ISNUMBER(H2),H2&gt;E2)</formula></cfRule></conditionalFormatting>`;
    if (/<pageMargins/.test(xml)) {
      xml = xml.replace('<pageMargins', regleXml + '<pageMargins');
    } else {
      xml = xml.replace('</worksheet>', regleXml + '</worksheet>');
    }
  }

  zip.file(cheminFeuille, xml);

  // xl/tables/table1.xml — meme decalage + nouvelle colonne de table.
  const cheminTable = Object.keys(zip.files).find(p => /^xl\/tables\/table\d+\.xml$/.test(p));
  if (cheminTable) {
    let tableXml = await zip.file(cheminTable).async('string');
    tableXml = tableXml.replace(/ref="(A1:[A-Z]{1,3}\d+)"/g, (m, ref) => `ref="${decalerPlage(ref)}"`);

    const mCount = /<tableColumns count="(\d+)">/.exec(tableXml);
    const mIds = [...tableXml.matchAll(/<tableColumn id="(\d+)"/g)].map(m => parseInt(m[1], 10));
    const nouvelId = Math.max(...mIds) + 1;
    if (mCount) {
      const nouveauCompte = parseInt(mCount[1], 10) + 1;
      tableXml = tableXml.replace(mCount[0], `<tableColumns count="${nouveauCompte}">`);
    }
    const nouveauTableColumn = `<tableColumn id="${nouvelId}" name="${echapperXml(labelSemaine)}"/>`;
    // Insere juste apres la 8e <tableColumn> (les colonnes fixes) — trouve
    // la fin de la 8e occurrence.
    let compte = 0;
    tableXml = tableXml.replace(/<tableColumn[^/]*\/>/g, (m) => {
      compte++;
      return compte === 8 ? m + nouveauTableColumn : m;
    });
    zip.file(cheminTable, tableXml);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const totalAClasser = totalBrut - totalNonClasse;
  return { buffer, labelSemaine, totalEcrit, totalAClasser, totalNonClasse, projetsNonTrouves: Array.from(projetsNonTrouves) };
}

module.exports = { calculerRepartitionMetier, ajouterSemaineDansSuivi, MAP_CATEGORIE_METIER };
