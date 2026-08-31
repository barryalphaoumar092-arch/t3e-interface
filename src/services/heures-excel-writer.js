// Etape 1 (suite) : lecture du fichier brut depose (xlsx, deja en
// dependance) + ecriture du fichier corrige.
//
// IMPORTANT : le fichier corrige doit rester visuellement IDENTIQUE a
// l'original (couleurs, largeurs de colonnes, styles, bordures) — la seule
// correction autorisee est la SUPPRESSION de colonnes/lignes inutiles.
//
// Deux approches testees et rejetees en cours de session :
// 1) reconstruire un classeur neuf avec addRow(valeurs) -- perd TOUTE la
//    mise en forme (aucun style copie).
// 2) ws.spliceColumns()/spliceRows() sur le classeur charge -- ExcelJS ne
//    deplace pas correctement les largeurs de colonnes (worksheet.columns
//    reste indexe sur les positions d'origine) ni certains styles de
//    cellule apres suppression -- constate en test reel (en-tete devenu
//    gras + fond blanc alors que l'original ne l'etait pas).
// Solution retenue : copier cellule par cellule (valeur ET style deep-clone)
// dans une feuille neuve, en ne gardant que les lignes/colonnes voulues,
// puis copier explicitement les largeurs de colonnes et hauteurs de lignes
// conservees depuis leurs positions d'origine -- fidelite garantie car on ne
// depend plus des methodes splice internes d'ExcelJS.
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { COLONNES_GARDEES, estProjetExclu, estCodeStandard, construirePivotStatique } = require('./heures-corrector');

// Contournement d'un bug connu d'ExcelJS : le chargement d'un classeur avec
// des "formules partagees" (colonnes calculees du logiciel de temps, ex.
// Total_H-C/Total-C/Total_T) peut jeter "Shared Formula master must exist
// above and/or left of clone for cell XX" -- constate en test reel. On ne
// s'interesse jamais aux formules ici (seulement aux VALEURS deja mises en
// cache dans le fichier), donc on les retire du XML avant chargement : plus
// aucune formule partagee a resoudre, ExcelJS lit directement la valeur
// mise en cache (<v>) sans erreur.
async function retirerFormules(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const chemins = Object.keys(zip.files).filter(p => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  for (const chemin of chemins) {
    let xml = await zip.file(chemin).async('string');
    xml = xml.replace(/<f\b[^>]*\/>/g, '').replace(/<f\b[^>]*>[\s\S]*?<\/f>/g, '');
    zip.file(chemin, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

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

function clonerStyle(style) {
  return style ? JSON.parse(JSON.stringify(style)) : undefined;
}

async function corrigerDepot(buffer, mappingSemaines) {
  const resultats = [];
  const bufferSansFormules = await retirerFormules(buffer);

  for (const [nomOnglet, semaine] of Object.entries(mappingSemaines)) {
    try {
      const wbSource = new ExcelJS.Workbook();
      await wbSource.xlsx.load(bufferSansFormules);
      const wsSource = wbSource.getWorksheet(nomOnglet);
      if (!wsSource) { resultats.push({ nomOnglet, erreur: `onglet "${nomOnglet}" introuvable dans le fichier` }); continue; }

      const entetesBrutes = (wsSource.getRow(1).values || []).slice(1).map(v => (v === null || v === undefined ? '' : String(v)));
      const idxProjetBrut = entetesBrutes.findIndex(h => h.trim() === 'No, Projet') + 1; // 1-based
      if (idxProjetBrut === 0) { resultats.push({ nomOnglet, erreur: 'colonne "No, Projet" introuvable' }); continue; }

      // Colonnes a garder, dans l'ORDRE d'origine (verifie : l'ordre des 44
      // colonnes de reference est deja un sous-ensemble ordonne des colonnes
      // brutes — aucun reordonnancement necessaire, seulement un filtre).
      // Trim des deux cotes pour que la colonne d'en-tete vide (" ", en tete
      // de fichier, largeur 36 — presente dans le brut ET la reference)
      // matche correctement (sinon cle="" ne trouve jamais comptesGardees[" "]
      // et cette colonne etait silencieusement perdue — bug constate en test
      // reel : rendu s'arretant a AQ au lieu de AR).
      const comptesGardees = {};
      COLONNES_GARDEES.forEach(nom => { const cle = nom.trim(); comptesGardees[cle] = (comptesGardees[cle] || 0) + 1; });
      const vusBrut = {};
      const colsAGarder = [];
      entetesBrutes.forEach((nom, i) => {
        const cle = nom.trim();
        vusBrut[cle] = (vusBrut[cle] || 0) + 1;
        if (vusBrut[cle] <= (comptesGardees[cle] || 0)) colsAGarder.push(i + 1);
      });

      // Lignes a garder (exclut R-/I-/SHOP et lignes VRAIMENT vides) +
      // signalement des codes non standards (ni exclus, ni reconnus).
      //
      // IMPORTANT : une ligne separatrice/de remplissage du brut a TOUTES
      // ses colonnes vides — une ligne avec des donnees reelles (employe,
      // heures) mais un code projet vide N'EST PAS une ligne vide (constate
      // en test reel : une entree "walnut" / code vide, 5,25h, etait
      // silencieusement perdue alors que le fichier de reference la garde).
      // On ne supprime que les vraies lignes vides (aucune colonne remplie),
      // jamais sur le seul critere du code projet.
      const rowsAGarder = [];
      const lignesExclues = [];
      const codesAConfirmerSet = new Set();
      const nbLignesSource = wsSource.rowCount;
      for (let r = 2; r <= nbLignesSource; r++) {
        const rowVals = wsSource.getRow(r).values || [];
        const ligneEntierementVide = rowVals.every(v => v === null || v === undefined || v === '');
        if (ligneEntierementVide) continue;

        const code = String(wsSource.getCell(r, idxProjetBrut).value || '').trim();
        if (!code) { codesAConfirmerSet.add('(code projet vide)'); rowsAGarder.push(r); continue; }
        if (estProjetExclu(code)) { lignesExclues.push({ code }); continue; }
        if (!estCodeStandard(code)) codesAConfirmerSet.add(code);
        rowsAGarder.push(r);
      }

      // Construction de la feuille corrigee : copie cellule par cellule
      // (valeur + style), colonne par colonne, ligne par ligne.
      const wbCible = new ExcelJS.Workbook();
      const wsCible = wbCible.addWorksheet(nomOnglet.slice(0, 31));

      colsAGarder.forEach((srcCol, i) => {
        wsCible.getColumn(i + 1).width = wsSource.getColumn(srcCol).width;
      });

      const lignesSourceOrdre = [1, ...rowsAGarder]; // 1 = en-tete
      lignesSourceOrdre.forEach((srcRow, destIdx) => {
        const destRow = destIdx + 1;
        const rowSource = wsSource.getRow(srcRow);
        wsCible.getRow(destRow).height = rowSource.height;
        colsAGarder.forEach((srcCol, colIdx) => {
          const destCol = colIdx + 1;
          const celluleSource = rowSource.getCell(srcCol);
          const celluleCible = wsCible.getCell(destRow, destCol);
          celluleCible.value = celluleSource.value;
          celluleCible.style = clonerStyle(celluleSource.style);
        });
      });

      // Pivot (Feuil2) — feuille neuve, aucune mise en forme a preserver de
      // l'original. Reproduit precisement l'apparence d'un vrai PivotTable
      // Excel en mode "compact" (verifie cellule par cellule sur un fichier
      // de reference reel via Excel COM) : PAS de gras, PAS de bordure —
      // seule l'indentation croissante (0=projet, 1=employe, 2=date) cree
      // l'effet d'arbre visuel. Largeurs de colonnes copiees de la reference.
      const entetesFinales = colsAGarder.map((_, i) => String(wsCible.getCell(1, i + 1).value || ''));
      const lignesFinales = rowsAGarder.map((_, r) => colsAGarder.map((_, c) => wsCible.getCell(r + 2, c + 1).value));
      const pivot = construirePivotStatique(entetesFinales, lignesFinales);
      const feuilPivot = wbCible.addWorksheet('Feuil2');
      feuilPivot.getColumn(1).width = 27.86;
      feuilPivot.getColumn(2).width = 15.86;
      feuilPivot.addRow([]);
      feuilPivot.addRow([]);
      for (const { texte, valeur, niveau } of pivot) {
        const ligne = feuilPivot.addRow([texte, valeur]);
        ligne.getCell(1).alignment = { indent: niveau };
        ligne.getCell(2).numFmt = 'General';
      }

      const labelSemaine = `${semaine.debut} au ${semaine.fin}`;
      const fichier = Buffer.from(await wbCible.xlsx.writeBuffer());

      resultats.push({
        nomOnglet, semaine, labelSemaine,
        nbLignes: rowsAGarder.length,
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
