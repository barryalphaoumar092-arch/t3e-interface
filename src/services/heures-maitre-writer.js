// Etape 2 : ajout d'une semaine validee (etape 1) dans le fichier maitre
// "Feuilles Maître heures - 2026.xlsx" (feuille "Rapport Detaillé"), stocke
// sur Supabase (bucket HEURES_MAITRES) — voir plan squishy-skipping-cook.
//
// Le fichier maitre a SES PROPRES noms/ordre de colonnes (44 aussi, mais pas
// dans le meme ordre que le fichier corrige de l'etape 1, et avec une
// colonne "Projet" (description) en plus que l'etape 1 n'a pas) : le
// mapping se fait par NOM d'en-tete normalise (trim + minuscules), jamais
// par position, pour rester robuste si l'ordre differe legerement.
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const NOM_FEUILLE_MAITRE = 'Rapport Detaillé';
const MASTER_KEY = 'Feuilles-Maitre-heures.xlsx';

function normaliser(s) {
  return String(s || '').trim().toLowerCase();
}

// Lit la 1ere feuille d'un fichier corrige (etape 1) -> {entetes, lignes}
// (tableaux de valeurs, header:1 — meme convention que heures-excel-writer).
function lireFeuilleCorrigee(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const feuille = wb.Sheets[wb.SheetNames[0]];
  const tout = XLSX.utils.sheet_to_json(feuille, { header: 1, raw: false, defval: null });
  const entetes = (tout[0] || []).map(h => (h === null ? '' : String(h)));
  const lignes = tout.slice(1).filter(l => l.some(v => v !== null && v !== ''));
  return { entetes, lignes };
}

// Construit, pour chaque colonne du MAITRE (dans son ordre a lui), l'index
// correspondant dans les entetes du fichier CORRIGE (ou -1 si absente — la
// cellule restera vide, jamais devinee). Gere les entetes dupliquees
// ("Date" apparait 2 fois des deux cotes) en associant les occurrences dans
// l'ordre ou elles apparaissent de chaque cote.
function construireMapping(entetesMaitre, entetesCorrige) {
  const comptesCorrige = {};
  const indexParOccurrence = {}; // "nom|occurrence" -> index dans entetesCorrige
  entetesCorrige.forEach((nom, i) => {
    const cle = normaliser(nom);
    comptesCorrige[cle] = (comptesCorrige[cle] || 0) + 1;
    indexParOccurrence[cle + '|' + comptesCorrige[cle]] = i;
  });

  const comptesMaitre = {};
  return entetesMaitre.map(nom => {
    const cle = normaliser(nom);
    comptesMaitre[cle] = (comptesMaitre[cle] || 0) + 1;
    const idx = indexParOccurrence[cle + '|' + comptesMaitre[cle]];
    return idx === undefined ? -1 : idx;
  });
}

// Retourne l'index de ligne (1-based, feuille exceljs) AVANT lequel inserer
// pour respecter l'ordre chronologique, en comparant la colonne "Date" du
// maitre. Si toutes les dates existantes sont <= dateDebutSemaine (cas
// normal d'un depot recent), retourne null => ajouter a la fin.
function trouverPointInsertion(worksheet, idxColDate, dateDebutSemaine) {
  const seuil = new Date(dateDebutSemaine);
  const nbLignes = worksheet.rowCount;
  for (let r = 2; r <= nbLignes; r++) {
    const v = worksheet.getRow(r).getCell(idxColDate).value;
    const d = v instanceof Date ? v : new Date(v);
    if (!isNaN(d) && d > seuil) return r;
  }
  return null;
}

// bufferMaitre : contenu actuel de Feuilles-Maitre-heures.xlsx (Supabase).
// Retourne { buffer, nbLignesAjoutees } — jamais d'ecrasement de lignes
// existantes, uniquement une insertion.
async function ajouterSemaineDansMaitre(bufferMaitre, bufferCorrige, semaine) {
  const { entetes: entetesCorrige, lignes: lignesCorrigees } = lireFeuilleCorrigee(bufferCorrige);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bufferMaitre);
  const ws = wb.getWorksheet(NOM_FEUILLE_MAITRE);
  if (!ws) throw new Error(`Feuille "${NOM_FEUILLE_MAITRE}" introuvable dans le fichier maître`);

  const entetesMaitre = ws.getRow(1).values.slice(1); // exceljs: index 0 inutilise
  const mapping = construireMapping(entetesMaitre, entetesCorrige);
  const idxColDate = entetesMaitre.findIndex(n => normaliser(n) === 'date') + 1; // 1-based pour exceljs

  const nouvellesLignes = lignesCorrigees.map(ligneCorrigee =>
    mapping.map(idx => (idx === -1 ? null : ligneCorrigee[idx]))
  );

  let pointInsertion = idxColDate > 0 ? trouverPointInsertion(ws, idxColDate, semaine.debut) : null;

  if (pointInsertion === null) {
    nouvellesLignes.forEach(ligne => ws.addRow(ligne));
  } else {
    // insertRows a la meme position, dans l'ordre, pour ne pas les inverser.
    ws.insertRows(pointInsertion, nouvellesLignes, 'i');
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, nbLignesAjoutees: nouvellesLignes.length, pointInsertion };
}

module.exports = { MASTER_KEY, NOM_FEUILLE_MAITRE, lireFeuilleCorrigee, construireMapping, ajouterSemaineDansMaitre };
