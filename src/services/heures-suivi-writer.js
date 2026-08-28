// Etape 3 : ajout de la semaine (deja dans la Feuille Maitre a l'etape 2)
// dans "ABCD-COPIE.xlsx" (resume par projet/metier/semaine) — reproduit
// EXACTEMENT la logique validee manuellement cette session (voir
// C:\...\scratchpad\ecrire_abcd.ps1) : insertion d'une colonne semaine,
// remplissage des lignes metier via la categorie_employe (210=Couvreur,
// 230=Ferblantier, 160=Menuiser, 264=Grutier — mapping valide a 100% sur les
// semaines recentes, voir plan), ajout des nouveaux projets, et mise en
// forme conditionnelle automatique (rouge si Hrs Reelles > Hrs Budgetees).
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const NOM_FEUILLE = 'Feuil1';
const COL_PROJET = 1, COL_DESCRIPTION = 2, COL_METIER = 4, COL_HRS_BUDGETEES = 5, COL_HRS_REELLES = 8;
const PREMIERE_COL_SEMAINE = 9;
const METIERS_ORDRE = ['TOTAL', 'Couvreur', 'Ferblantier', 'Menuiser', 'Grutier'];

const MAP_CATEGORIE_METIER = { '210': 'Couvreur', '230': 'Ferblantier', '160': 'Menuiser', '264': 'Grutier' };

function normaliser(s) { return String(s || '').trim(); }

// "2026-08-16" -> "08-16" (format des en-tetes de semaine dans ABCD-COPIE).
function formatCourt(dateIso) {
  const [, m, j] = dateIso.split('-');
  return `${m}-${j}`;
}

// Lit le fichier corrige de l'etape 1 (44 colonnes) et calcule les heures
// par (projet, metier) via la categorie_employe. Retourne aussi le total
// brut (toutes categories confondues) pour le controle de coherence —
// jamais de repartition inventee pour une categorie non reconnue : ces
// heures sont exclues du detail par metier mais comptees dans le total brut
// (remontees separement pour ne pas fausser silencieusement le controle).
function calculerRepartitionMetier(bufferCorrige) {
  const wb = XLSX.read(bufferCorrige, { type: 'buffer', cellDates: true });
  const feuille = wb.Sheets[wb.SheetNames[0]];
  const lignes = XLSX.utils.sheet_to_json(feuille, { defval: null });

  const parProjetMetier = new Map(); // "projet|metier" -> heures
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

// bufferSuivi : contenu actuel de ABCD-COPIE.xlsx. Retourne
// { buffer, totalEcrit, nbNouveauxProjets } — totalEcrit sert au controle de
// coherence (doit correspondre a totalBrut - totalNonClasse du calcul).
async function ajouterSemaineDansSuivi(bufferSuivi, bufferCorrige, semaine) {
  const { parProjetMetier, totalBrut, totalNonClasse } = calculerRepartitionMetier(bufferCorrige);
  const labelSemaine = `${formatCourt(semaine.debut)} au ${formatCourt(semaine.fin)}`;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bufferSuivi);
  const ws = wb.getWorksheet(NOM_FEUILLE) || wb.worksheets[0];

  // Insere UNE colonne vide en position 9 (la plus recente semaine est
  // toujours la plus a gauche, comme dans le fichier existant).
  ws.spliceColumns(PREMIERE_COL_SEMAINE, 0, []);
  ws.getCell(1, PREMIERE_COL_SEMAINE).value = labelSemaine;
  // copie la mise en forme depuis la colonne voisine (l'ancienne semaine la
  // plus recente, decalee d'un cran a droite) pour rester visuellement
  // identique — meme principe que l'insertion faite manuellement cette
  // session (PasteSpecial xlPasteFormats depuis la colonne de reference).
  const nbLignes = ws.rowCount;
  for (let r = 1; r <= nbLignes; r++) {
    const source = ws.getCell(r, PREMIERE_COL_SEMAINE + 1);
    const cible = ws.getCell(r, PREMIERE_COL_SEMAINE);
    cible.style = Object.assign({}, source.style);
  }

  let totalEcrit = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const projet = normaliser(ws.getCell(r, COL_PROJET).value);
    const metier = normaliser(ws.getCell(r, COL_METIER).value);
    if (!projet || !metier || metier === 'TOTAL') continue;
    const cle = `${projet}|${metier}`;
    if (parProjetMetier.has(cle)) {
      const h = parProjetMetier.get(cle);
      ws.getCell(r, PREMIERE_COL_SEMAINE).value = h;
      totalEcrit += h;
      parProjetMetier.delete(cle);
    }
  }

  // Projets restants (pas encore une ligne dans ABCD-COPIE) : ajoutes en bas,
  // meme bloc a 5 lignes (TOTAL + 4 metiers) que les projets existants,
  // style copie de la ligne 2 (bloc modele).
  const projetsRestants = new Map();
  for (const [cle, h] of parProjetMetier) {
    const [projet, metier] = cle.split('|');
    if (!projetsRestants.has(projet)) projetsRestants.set(projet, {});
    projetsRestants.get(projet)[metier] = h;
    totalEcrit += h;
  }

  let ligneSuivante = ws.rowCount + 1;
  for (const [projet, valeurs] of projetsRestants) {
    for (let j = 0; j < METIERS_ORDRE.length; j++) {
      const destRow = ligneSuivante + j;
      for (let c = 1; c <= ws.columnCount; c++) {
        ws.getCell(destRow, c).style = Object.assign({}, ws.getCell(2 + j, c).style);
      }
      ws.getCell(destRow, COL_PROJET).value = projet;
      ws.getCell(destRow, COL_DESCRIPTION).value = '';
      ws.getCell(destRow, COL_METIER).value = METIERS_ORDRE[j];
      if (METIERS_ORDRE[j] !== 'TOTAL' && valeurs[METIERS_ORDRE[j]]) {
        ws.getCell(destRow, PREMIERE_COL_SEMAINE).value = valeurs[METIERS_ORDRE[j]];
      }
    }
    ligneSuivante += METIERS_ORDRE.length;
  }

  assurerFormatConditionnelRouge(ws);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const totalAClasser = totalBrut - totalNonClasse;
  return { buffer, labelSemaine, totalEcrit, totalAClasser, totalNonClasse, nbNouveauxProjets: projetsRestants.size };
}

// Regle permanente (idempotente) : la cellule "Hrs Réelles" (col H) devient
// rouge des qu'elle depasse "Hrs Budgétées" (col E), sur toute la plage de
// donnees — demande explicite de l'utilisateur ("a l'avenir, directement").
function assurerFormatConditionnelRouge(ws) {
  const dejaPresente = (ws.conditionalFormattings || []).some(cf =>
    (cf.rules || []).some(r => (r.formulae || []).some(f => /H\d+>E\d+/i.test(f) || /\$H\d*>\$E\d*/i.test(f)))
  );
  if (dejaPresente) return;

  ws.addConditionalFormatting({
    ref: `H2:H${ws.rowCount}`,
    rules: [{
      type: 'expression',
      formulae: ['AND(ISNUMBER($E2),ISNUMBER($H2),$H2>$E2)'],
      style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFF0000' } } },
    }],
  });
}

module.exports = { calculerRepartitionMetier, ajouterSemaineDansSuivi, MAP_CATEGORIE_METIER };
