const XLSX = require('xlsx');
const path = require('path');

const filePath = path.join('C:', 'Users', 'Projets', 'Desktop', 'Doc Claude1', 'Liste des matériaux avec sds.xlsx');
const wb = XLSX.readFile(filePath);
const ws = wb.Sheets['Feuil1'];

const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// Trouver les lignes d'en-tête (chercher les lignes non vides avec du contenu significatif)
console.log('=== ANALYSE DÉTAILLÉE DU FICHIER MATÉRIAUX ===\n');

// Afficher les lignes 8-15 pour voir les en-têtes et premières données
console.log('--- Lignes 8 à 20 (colonnes A-L, soit 0-11) ---');
for (let i = 8; i < Math.min(25, data.length); i++) {
  const row = data[i];
  const cols = [];
  for (let j = 0; j < 12; j++) {
    if (row[j] !== '' && row[j] !== undefined && row[j] !== null) {
      cols.push(`[${j}]=${row[j]}`);
    }
  }
  if (cols.length > 0) {
    console.log(`  Ligne ${i}: ${cols.join(' | ')}`);
  }
}

// Trouver les en-têtes de colonnes
console.log('\n--- Recherche des en-têtes ---');
for (let i = 0; i < 15; i++) {
  const row = data[i];
  const nonEmpty = [];
  for (let j = 0; j < row.length; j++) {
    if (row[j] !== '' && row[j] !== undefined && row[j] !== null) {
      nonEmpty.push(`Col${j}(${XLSX.utils.encode_col(j)})="${row[j]}"`);
    }
  }
  if (nonEmpty.length > 0) {
    console.log(`  Ligne ${i}: ${nonEmpty.join(' | ')}`);
  }
}

// Analyser les hyperliens par colonne
console.log('\n--- Hyperliens par colonne ---');
const linksByCol = {};
for (const cellRef in ws) {
  if (cellRef[0] === '!') continue;
  const cell = ws[cellRef];
  if (cell.l && cell.l.Target) {
    const col = cellRef.replace(/[0-9]/g, '');
    if (!linksByCol[col]) linksByCol[col] = [];
    linksByCol[col].push({ cell: cellRef, text: cell.v, url: cell.l.Target });
  }
}
for (const col in linksByCol) {
  console.log(`  Colonne ${col}: ${linksByCol[col].length} liens`);
  if (linksByCol[col].length > 0) {
    console.log(`    Exemple: ${linksByCol[col][0].url.substring(0, 80)}...`);
  }
}

// Afficher quelques lignes complètes avec données et liens
console.log('\n--- Exemples de lignes avec données (lignes 10-20, toutes colonnes non vides) ---');
for (let i = 9; i < Math.min(25, data.length); i++) {
  const row = data[i];
  const cols = [];
  for (let j = 0; j < row.length; j++) {
    if (row[j] !== '' && row[j] !== undefined && row[j] !== null) {
      const colLetter = XLSX.utils.encode_col(j);
      cols.push(`${colLetter}="${row[j]}"`);
    }
  }
  if (cols.length > 0) {
    // Chercher les liens pour cette ligne
    const rowNum = i + 2; // Excel rows start at 2 because header offset
    const links = [];
    for (const cellRef in ws) {
      if (cellRef[0] === '!') continue;
      const cell = ws[cellRef];
      if (cell.l && cell.l.Target) {
        const match = cellRef.match(/^([A-Z]+)(\d+)$/);
        if (match && parseInt(match[2]) === rowNum) {
          links.push(`${match[1]}->${cell.l.Target.substring(0, 60)}`);
        }
      }
    }
    console.log(`\n  Ligne ${i} (Excel row ${rowNum}):`);
    console.log(`    Données: ${cols.join(' | ')}`);
    if (links.length > 0) {
      console.log(`    Liens: ${links.join(' | ')}`);
    }
  }
}

// Trouver les sections/groupes (lignes avec texte en colonne C mais sans liens)
console.log('\n\n--- Sections/Fabricants détectés ---');
for (let i = 8; i < data.length; i++) {
  const row = data[i];
  // Chercher des titres de sections (en gras, texte dans colonnes B ou C, pas de contenu en I/J)
  if (row[2] && !row[8] && !row[3]) {
    console.log(`  Ligne ${i}: "${row[2]}"`);
  }
}
