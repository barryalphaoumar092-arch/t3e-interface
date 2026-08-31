// Etape 2 : ajout d'une semaine validee (etape 1) dans le fichier maitre
// "Feuilles Maître heures - 2026.xlsx" (feuille "Rapport Detaillé"), stocke
// sur Supabase (bucket HEURES_MAITRES) — voir plan squishy-skipping-cook.
//
// ATTENTION — piege majeur decouvert en test reel : ce fichier contient DEUX
// vrais PivotTables Excel natifs (feuilles "Feuil1"/"Feuil2") ET des colonnes
// calculees par formules (certaines via VLOOKUP vers un classeur EXTERNE
// lie, ex. '[1]code metier'). Charger le classeur via exceljs (load/insert/
// save) DETRUIT silencieusement les pivots (fichier corrompu, Excel refuse
// de le rouvrir — confirme en test). On manipule donc directement le XML de
// la SEULE feuille "Rapport Detaillé" (JSZip, deja en dependance), sans
// jamais toucher aux autres parties du fichier (Feuil1/Feuil2/pivotCache/
// pivotTables restent identiques, octet pour octet).
//
// Consequence du choix "valeurs, pas de formules" (decision utilisateur,
// vu qu'aucune formule ne peut etre executee sans Excel — le site n'en a
// jamais) : les nouvelles lignes sont ecrites comme des VALEURS figees,
// jamais comme des formules. Bonne nouvelle constatee en inspectant le XML
// existant : TOUTES les colonnes calculees du maitre (Total_H-C, Couvreur
// total, Nom Complète, Date, Activity, Trade, etc.) ont un equivalent DEJA
// PRESENT et deja calcule par le logiciel source dans le fichier corrige de
// l'etape 1 (memes noms de colonnes) — on copie donc directement ces
// valeurs plutot que de re-implementer la logique des formules (dont les
// VLOOKUP externes, de toute facon inaccessibles au site).
const XLSX = require('xlsx');
const JSZip = require('jszip');

const NOM_FEUILLE_MAITRE = 'Rapport Detaillé';
const MASTER_KEY = 'Feuilles-Maitre-heures.xlsx';

// Colonnes du fichier maitre, DANS L'ORDRE (A..AR), par nom d'en-tete —
// "Date" apparait 2 fois (AD=1ere occurrence, AG="Date2"=2eme, renommee par
// Excel a la construction du fichier), "Group" idem (W=1ere, AL="Group2").
// Le nom ici sert a retrouver la valeur correspondante dans le fichier
// corrige (meme technique de correspondance par occurrence que
// heures-corrector.js) — jamais par position, plus robuste.
const COLONNES_MAITRE = [
  ' ', 'No, Projet', 'Task', 'User', 'Started at', 'Completed at', 'datetimeinput_0',
  'contremaitre', 'nom', 'prénom', 'numéro_employé', 'catégorie_employé',
  'déplacement', 'début_hors_chantier', 'début_chantier', 'fin_chantier',
  'fin_hors_chantier', 'Diner?', 'total_hors_chantier', 'total_chantier',
  'total', 'note', 'Group', 'Total_H-C', 'Total-C', 'Total_T',
  'Couvreur total (-diner)', 'Vérifié Dinér', 'Nom Compléte', 'Date', 'Jour',
  'Verifiée #', 'Date', 'Employee', 'Last Name', 'Project-#', 'Activity',
  'Group', 'Sector', 'Trade', 'Annex', 'Region', 'Rate Type', 'Hours',
];

// Styles (attribut s=) sampled sur la derniere ligne reelle du fichier de
// reference (la plus recente, donc la plus representative visuellement) —
// purement cosmetique, aucune incidence sur la validite/le calcul.
const STYLES_COLONNES = [
  '', '', '', '', '301', '301', '289', '', '363', '363', '363', '363', '366',
  '291', '291', '291', '291', '292', '293', '293', '293', '', '294', '295',
  '295', '295', '296', '295', '296', '297', '298', '294', '299', '300', '300',
  '300', '300', '300', '300', '300', '300', '300', '300', '300',
];

function normaliser(s) {
  return String(s || '').trim().toLowerCase();
}

function echapperXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Numero de colonne (1-based) -> lettre Excel (1->A, 27->AA, ...).
function lettreColonne(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Serial Excel (jours depuis 1899-12-30) — utilise seulement pour les
// quelques colonnes datetime brutes (Started at/Completed at/
// datetimeinput_0) qu'aucun calcul en aval ne relit ; formule standard.
function versSerialExcel(date) {
  const epoch = Date.UTC(1899, 11, 30);
  return (date.getTime() - epoch) / 86400000;
}

// Lit le fichier corrige (etape 1) avec les VRAIS types (raw:true) pour
// distinguer nombres/dates/texte — necessaire pour ecrire des cellules
// numeriques valides (notamment "Hours", utilise par les PivotTables du
// maitre : une valeur texte y serait invisible dans les sommes).
function lireFeuilleCorrigee(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const feuille = wb.Sheets[wb.SheetNames[0]];
  const tout = XLSX.utils.sheet_to_json(feuille, { header: 1, raw: true, defval: null });
  const entetes = (tout[0] || []).map(h => (h === null ? '' : String(h)));
  const lignes = tout.slice(1).filter(l => l.some(v => v !== null && v !== ''));
  return { entetes, lignes };
}

// Pour chaque colonne du MAITRE (dans son ordre), l'index correspondant
// dans les entetes du fichier CORRIGE (ou -1 si absente). Gere les entetes
// dupliquees (" "x1 implicite, "Date"x2, "Group"x2) en associant les
// occurrences dans l'ordre ou elles apparaissent de chaque cote — les deux
// fichiers partagent la MEME liste/le MEME ordre de colonnes (voir
// heures-corrector.js/COLONNES_GARDEES), donc cette correspondance est fiable.
function construireMapping(entetesCorrige) {
  const comptesCorrige = {};
  const indexParOccurrence = {};
  entetesCorrige.forEach((nom, i) => {
    const cle = normaliser(nom);
    comptesCorrige[cle] = (comptesCorrige[cle] || 0) + 1;
    indexParOccurrence[cle + '|' + comptesCorrige[cle]] = i;
  });

  const comptesMaitre = {};
  return COLONNES_MAITRE.map(nom => {
    const cle = normaliser(nom);
    comptesMaitre[cle] = (comptesMaitre[cle] || 0) + 1;
    const idx = indexParOccurrence[cle + '|' + comptesMaitre[cle]];
    return idx === undefined ? -1 : idx;
  });
}

function construireCelluleXml(colLettre, ligneNum, valeur, style) {
  const ref = `${colLettre}${ligneNum}`;
  const sAttr = style ? ` s="${style}"` : '';
  if (valeur === null || valeur === undefined || valeur === '') {
    return `<c r="${ref}"${sAttr}/>`;
  }
  if (typeof valeur === 'number' && !isNaN(valeur)) {
    return `<c r="${ref}"${sAttr}><v>${valeur}</v></c>`;
  }
  if (valeur instanceof Date) {
    return `<c r="${ref}"${sAttr}><v>${versSerialExcel(valeur)}</v></c>`;
  }
  // Nombres stockes en texte (ex: "9,75" avec virgule francophone) —
  // convertis en vraie valeur numerique pour rester utilisables par les
  // PivotTables/formules du fichier (voir Hours notamment).
  const commeNombre = parseFloat(String(valeur).replace(',', '.'));
  if (!isNaN(commeNombre) && /^-?[\d,.]+$/.test(String(valeur).trim())) {
    return `<c r="${ref}"${sAttr}><v>${commeNombre}</v></c>`;
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${echapperXml(valeur)}</t></is></c>`;
}

// Retrouve, dans le zip du classeur, le chemin XML (xl/worksheets/sheetN.xml)
// correspondant a un nom de feuille donne — via workbook.xml (nom->r:id)
// puis workbook.xml.rels (r:id->cible). Jamais par position/nommage suppose
// (ExcelJS/Excel peuvent numeroter les sheetN.xml dans un ordre different
// de l'ordre d'affichage des feuilles).
async function trouverCheminFeuille(zip, nomFeuille) {
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const mSheet = new RegExp(`<sheet[^>]*name="${nomFeuille.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*r:id="(rId\\d+)"`).exec(workbookXml)
    || new RegExp(`<sheet[^>]*r:id="(rId\\d+)"[^>]*name="${nomFeuille.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(workbookXml);
  if (!mSheet) throw new Error(`Feuille "${nomFeuille}" introuvable dans workbook.xml`);
  const rId = mSheet[1];

  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const mRel = new RegExp(`Id="${rId}"[^>]*Target="worksheets/(sheet\\d+\\.xml)"`).exec(relsXml)
    || new RegExp(`Target="worksheets/(sheet\\d+\\.xml)"[^>]*Id="${rId}"`).exec(relsXml);
  if (!mRel) throw new Error(`Relation ${rId} introuvable dans workbook.xml.rels`);
  return `xl/worksheets/${mRel[1]}`;
}

// bufferMaitre : contenu actuel de Feuilles-Maitre-heures.xlsx (Supabase).
// Retourne { buffer, nbLignesAjoutees } — insertion en ANNEXE (fin de la
// feuille, apres la derniere ligne existante) : renumeroter/reinserer au
// milieu par ordre chronologique demanderait de deplacer des milliers de
// lignes de formules/styles existantes, bien plus risque qu'un simple ajout
// en fin — l'ordre chronologique strict de ce detail brut est secondaire
// (les deux PivotTables du fichier resument par date independamment de
// l'ordre des lignes source).
async function ajouterSemaineDansMaitre(bufferMaitre, bufferCorrige, semaine) {
  const { entetes: entetesCorrige, lignes: lignesCorrigees } = lireFeuilleCorrigee(bufferCorrige);
  const mapping = construireMapping(entetesCorrige);

  // Garde-fou : si des lignes existantes du maitre couvrent DEJA cette
  // periode (colonne "Date"), c'est un depot en double — on refuse plutot
  // que de dupliquer silencieusement des heures deja comptabilisees.
  const idxDateMaitre = COLONNES_MAITRE.indexOf('Date'); // 1ere occurrence
  const wbVerif = XLSX.read(bufferMaitre, { type: 'buffer', cellDates: true });
  const feuilleVerif = wbVerif.Sheets[NOM_FEUILLE_MAITRE];
  const lignesVerif = XLSX.utils.sheet_to_json(feuilleVerif, { header: 1, defval: null });
  const debut = new Date(semaine.debut), fin = new Date(semaine.fin);
  const dejaPresent = lignesVerif.slice(1).some(ligne => {
    const v = ligne[idxDateMaitre];
    if (!v) return false;
    const d = v instanceof Date ? v : new Date(v);
    return !isNaN(d) && d >= debut && d <= fin;
  });
  if (dejaPresent) {
    throw new Error(`Des lignes couvrant la période ${semaine.debut} au ${semaine.fin} existent déjà dans Feuilles Maître heures - 2026.xlsx — dépôt en double, rien n'a été modifié.`);
  }

  const zip = await JSZip.loadAsync(bufferMaitre);
  const cheminFeuille = await trouverCheminFeuille(zip, NOM_FEUILLE_MAITRE);
  let xml = await zip.file(cheminFeuille).async('string');

  const mDim = /<dimension ref="[A-Z]+1:[A-Z]+(\d+)"\/>/.exec(xml);
  if (!mDim) throw new Error(`<dimension> introuvable dans ${cheminFeuille} — structure inattendue, insertion annulee par securite`);
  const dernierRowActuel = parseInt(mDim[1], 10);

  const nouvellesLignesXml = lignesCorrigees.map((ligneCorrigee, i) => {
    const numLigne = dernierRowActuel + 1 + i;
    const cellules = mapping.map((idxCorrige, colIdx) => {
      const valeur = idxCorrige === -1 ? null : ligneCorrigee[idxCorrige];
      return construireCelluleXml(lettreColonne(colIdx + 1), numLigne, valeur, STYLES_COLONNES[colIdx]);
    }).join('');
    return `<row r="${numLigne}" spans="1:44" x14ac:dyDescent="0.25">${cellules}</row>`;
  }).join('');

  xml = xml.replace('</sheetData>', nouvellesLignesXml + '</sheetData>');

  const dernierRowApres = dernierRowActuel + lignesCorrigees.length;
  xml = xml.replace(/<dimension ref="([A-Z]+)1:([A-Z]+)\d+"\/>/, `<dimension ref="$11:$2${dernierRowApres}"/>`);

  zip.file(cheminFeuille, xml);

  // Etend la plage source des PivotCaches existants pour que les nouvelles
  // lignes soient incluses lors du PROCHAIN rafraichissement manuel du
  // pivot dans Excel (n'ajoute/ne modifie aucune structure, juste la
  // reference de plage — un simple attribut texte, sans risque).
  const cheminsPivotCache = Object.keys(zip.files).filter(p => /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(p));
  for (const chemin of cheminsPivotCache) {
    let pcXml = await zip.file(chemin).async('string');
    const mSrc = new RegExp(`<worksheetSource ref="([A-Z]+)1:([A-Z]+)${dernierRowActuel}" sheet="${NOM_FEUILLE_MAITRE}"/>`).exec(pcXml);
    if (mSrc) {
      pcXml = pcXml.replace(mSrc[0], `<worksheetSource ref="${mSrc[1]}1:${mSrc[2]}${dernierRowApres}" sheet="${NOM_FEUILLE_MAITRE}"/>`);
      zip.file(chemin, pcXml);
    }
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, nbLignesAjoutees: lignesCorrigees.length, dernierRowApres };
}

module.exports = { MASTER_KEY, NOM_FEUILLE_MAITRE, ajouterSemaineDansMaitre };
