// Etape 1 (suite) : lecture du fichier brut depose (xlsx, deja en
// dependance) + ecriture du fichier corrige.
//
// IMPORTANT : le fichier corrige doit rester visuellement IDENTIQUE a
// l'original (couleurs, largeurs de colonnes, styles, bordures) — la seule
// correction autorisee est la SUPPRESSION de colonnes/lignes inutiles.
// Constate en test reel : reconstruire un classeur neuf (ancienne version de
// ce fichier) perdait toute la mise en forme — corrige en operant EN PLACE
// sur le classeur charge (ExcelJS), jamais en reconstruisant les cellules.
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { COLONNES_GARDEES, estProjetExclu, estCodeStandard, construirePivotStatique } = require('./heures-corrector');

// Lit un classeur brut (via xlsx, plus simple pour un simple apercu des
// onglets/lignes) et retourne un tableau {nomOnglet, entetes, lignes} par
// onglet — utilise pour /apercu-onglets et pour le calcul du pivot (qui n'a
// pas besoin de la mise en forme, seulement des valeurs).
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

// Traite un classeur brut deja depose : pour l'onglet demande, charge le
// classeur EN PLACE (ExcelJS), supprime les colonnes/lignes non voulues sur
// CETTE feuille (formatage intact partout ailleurs), retire les autres
// onglets du classeur (chaque semaine devient son propre fichier), ajoute
// "Feuil2" (pivot, feuille neuve — aucune mise en forme a preserver puisque
// absente de l'original).
async function corrigerDepot(buffer, mappingSemaines) {
  const resultats = [];

  for (const [nomOnglet, semaine] of Object.entries(mappingSemaines)) {
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer); // recharge a chaque onglet : spliceColumns/Rows mute le classeur
      const ws = wb.getWorksheet(nomOnglet);
      if (!ws) { resultats.push({ nomOnglet, erreur: `onglet "${nomOnglet}" introuvable dans le fichier` }); continue; }

      // Retire tous les AUTRES onglets — un fichier corrige = une semaine.
      for (const autre of wb.worksheets.slice()) {
        if (autre.name !== nomOnglet) wb.removeWorksheet(autre.id);
      }

      const entetesBrutes = (ws.getRow(1).values || []).slice(1).map(v => (v === null || v === undefined ? '' : String(v)));
      const idxProjetBrut = entetesBrutes.findIndex(h => h.trim() === 'No, Projet') + 1; // 1-based
      if (idxProjetBrut === 0) { resultats.push({ nomOnglet, erreur: 'colonne "No, Projet" introuvable' }); continue; }

      // 1) Determiner les lignes a retirer (projets R-/I-/SHOP) + les codes
      // ambigus a signaler — AVANT toute suppression de colonne, pendant
      // qu'on connait encore l'index brut de la colonne projet.
      const lignesASupprimer = [];
      const lignesExclues = [];
      const codesAConfirmerSet = new Set();
      const nbLignes = ws.rowCount;
      for (let r = 2; r <= nbLignes; r++) {
        const code = String(ws.getCell(r, idxProjetBrut).value || '').trim();
        if (!code) { lignesASupprimer.push(r); continue; } // ligne vide (separateur brut)
        if (estProjetExclu(code)) { lignesASupprimer.push(r); lignesExclues.push({ code }); continue; }
        if (!estCodeStandard(code)) codesAConfirmerSet.add(code);
      }
      // spliceRows du bas vers le haut pour ne pas decaler les index restants.
      for (let i = lignesASupprimer.length - 1; i >= 0; i--) ws.spliceRows(lignesASupprimer[i], 1);

      // 2) Determiner les colonnes a retirer (tout ce qui n'est pas dans
      // COLONNES_GARDEES) — gere les doublons ("Date" x2) en gardant CHAQUE
      // occurrence presente dans COLONNES_GARDEES, dans l'ordre.
      const comptesGardees = {};
      COLONNES_GARDEES.forEach(nom => { comptesGardees[nom] = (comptesGardees[nom] || 0) + 1; });
      const vusBrut = {};
      const colonnesAGarder = new Set(); // index 1-based
      entetesBrutes.forEach((nom, i) => {
        const cle = nom.trim();
        vusBrut[cle] = (vusBrut[cle] || 0) + 1;
        if (vusBrut[cle] <= (comptesGardees[cle] || 0)) colonnesAGarder.add(i + 1);
      });
      const colonnesASupprimer = [];
      for (let c = 1; c <= entetesBrutes.length; c++) if (!colonnesAGarder.has(c)) colonnesASupprimer.push(c);
      for (let i = colonnesASupprimer.length - 1; i >= 0; i--) ws.spliceColumns(colonnesASupprimer[i], 1);

      // 3) Pivot (Feuil2) — calcule a partir des valeurs deja filtrees.
      const entetesFinales = (ws.getRow(1).values || []).slice(1).map(v => (v === null || v === undefined ? '' : String(v)));
      const lignesFinales = [];
      for (let r = 2; r <= ws.rowCount; r++) {
        lignesFinales.push(ws.getRow(r).values.slice(1));
      }
      const pivot = construirePivotStatique(entetesFinales, lignesFinales);
      const feuilPivot = wb.addWorksheet('Feuil2');
      feuilPivot.addRow([]);
      feuilPivot.addRow([]);
      for (const ligne of pivot) feuilPivot.addRow(ligne);
      feuilPivot.getRow(3).font = { bold: true };

      const labelSemaine = `${semaine.debut} au ${semaine.fin}`;
      const fichier = Buffer.from(await wb.xlsx.writeBuffer());

      resultats.push({
        nomOnglet, semaine, labelSemaine,
        nbLignes: lignesFinales.length,
        nbLignesExclues: lignesExclues.length,
        lignesExclues,
        codesAConfirmer: Array.from(codesAConfirmerSet),
        fichier,
      });
    } catch (e) {
      resultats.push({ nomOnglet, erreur: e.message });
    }
  }

  return resultats;
}

module.exports = { lireClasseurBrut, corrigerDepot };
