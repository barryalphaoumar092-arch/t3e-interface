// Etape 1 (suite) : lecture du fichier brut depose (xlsx, deja en
// dependance) + ecriture du fichier corrige au format cible (exceljs,
// necessaire pour la mise en forme / creation de feuilles multiples que la
// version communautaire de xlsx ne gere pas proprement en ecriture).
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { corrigerFeuille, construirePivotStatique } = require('./heures-corrector');

// Lit un classeur brut et retourne un tableau {nomOnglet, entetes, lignes}
// par onglet (header:1 => tableaux de valeurs, pas d'objets, pour pouvoir
// gerer les en-tetes en double comme dans heures-corrector.js).
function lireClasseurBrut(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return wb.SheetNames.map(nom => {
    const feuille = wb.Sheets[nom];
    const tout = XLSX.utils.sheet_to_json(feuille, { header: 1, raw: false, defval: null });
    const entetes = (tout[0] || []).map(h => (h === null ? '' : String(h)));
    const lignes = tout.slice(1).filter(l => l.some(v => v !== null && v !== ''));
    return { nomOnglet: nom, entetes, lignes };
  });
}

// Construit le classeur corrige (2 feuilles, meme convention que
// C:\RAPPORT HEURES) pour UNE semaine deja isolee, et retourne le Buffer
// .xlsx pret a etre uploade sur Supabase (bucket HEURES_CORRIGEES).
async function ecrireClasseurCorrige(labelSemaine, entetes, lignes, pivot) {
  const wb = new ExcelJS.Workbook();

  const feuilData = wb.addWorksheet(labelSemaine.slice(0, 31)); // limite Excel = 31 car.
  feuilData.addRow(entetes);
  feuilData.getRow(1).font = { bold: true };
  for (const ligne of lignes) feuilData.addRow(ligne);

  const feuilPivot = wb.addWorksheet('Feuil2');
  // memes 2 lignes vides en haut que le format observe (le pivot commence en
  // A3 dans les fichiers deja corriges), pour rester visuellement identique.
  feuilPivot.addRow([]);
  feuilPivot.addRow([]);
  for (const ligne of pivot) feuilPivot.addRow(ligne);
  feuilPivot.getRow(3).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Traite un classeur brut deja depose : pour CHAQUE onglet (deja associe a
// une semaine par l'utilisateur au depot, voir mappingSemaines
// { nomOnglet: {debut, fin} }), applique la correction et construit le
// classeur cible correspondant. Retourne un resultat par semaine — jamais
// d'ecriture directe sur Supabase ici (fait par l'appelant, routes/heures.js)
// pour garder cette fonction testable independamment du stockage.
async function corrigerDepot(buffer, mappingSemaines) {
  const onglets = lireClasseurBrut(buffer);
  const resultats = [];

  for (const onglet of onglets) {
    const semaine = mappingSemaines[onglet.nomOnglet];
    if (!semaine) {
      resultats.push({ nomOnglet: onglet.nomOnglet, erreur: 'aucune semaine associee a cet onglet' });
      continue;
    }
    const { entetes, lignes, lignesExclues, codesAConfirmer } = corrigerFeuille(onglet.entetes, onglet.lignes);
    const pivot = construirePivotStatique(entetes, lignes);
    const labelSemaine = `${semaine.debut} au ${semaine.fin}`;
    const fichier = await ecrireClasseurCorrige(labelSemaine, entetes, lignes, pivot);

    resultats.push({
      nomOnglet: onglet.nomOnglet,
      semaine,
      labelSemaine,
      nbLignes: lignes.length,
      nbLignesExclues: lignesExclues.length,
      lignesExclues,
      codesAConfirmer,
      fichier, // Buffer .xlsx
    });
  }
  return resultats;
}

module.exports = { lireClasseurBrut, ecrireClasseurCorrige, corrigerDepot };
