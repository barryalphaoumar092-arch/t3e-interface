const XLSX = require('xlsx');
const path = require('path');

const files = [
  path.join('C:', 'Users', 'Projets', 'Desktop', 'Doc Claude1', 'Liste des matériaux avec sds.xlsx'),
  path.join('C:', 'Users', 'Projets', 'Desktop', 'Doc Claude1', 'Liste ARCHITECTES.xlsx'),
];

for (const filePath of files) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`FICHIER: ${path.basename(filePath)}`);
  console.log('='.repeat(80));

  const wb = XLSX.readFile(filePath);

  for (const sheetName of wb.SheetNames) {
    console.log(`\n--- Feuille: "${sheetName}" ---`);
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    console.log(`Plage: ${ws['!ref']} (${range.e.r + 1} lignes x ${range.e.c + 1} colonnes)`);

    // Afficher les 5 premières lignes en détail
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    console.log(`\nPremières lignes (max 8):`);
    for (let i = 0; i < Math.min(8, data.length); i++) {
      console.log(`  Ligne ${i}: ${JSON.stringify(data[i])}`);
    }

    // Chercher les hyperliens
    const hyperlinks = [];
    for (const cellRef in ws) {
      if (cellRef[0] === '!') continue;
      const cell = ws[cellRef];
      if (cell.l && cell.l.Target) {
        hyperlinks.push({ cell: cellRef, text: cell.v, url: cell.l.Target });
      }
    }

    if (hyperlinks.length > 0) {
      console.log(`\nHyperliens trouvés: ${hyperlinks.length}`);
      for (let i = 0; i < Math.min(10, hyperlinks.length); i++) {
        console.log(`  ${hyperlinks[i].cell}: "${hyperlinks[i].text}" -> ${hyperlinks[i].url}`);
      }
      if (hyperlinks.length > 10) {
        console.log(`  ... et ${hyperlinks.length - 10} autres liens`);
      }
    } else {
      console.log('\nAucun hyperlien trouvé dans cette feuille.');
    }

    // Afficher les dernières lignes aussi
    if (data.length > 8) {
      console.log(`\nDernières lignes:`);
      for (let i = Math.max(8, data.length - 3); i < data.length; i++) {
        console.log(`  Ligne ${i}: ${JSON.stringify(data[i])}`);
      }
    }
  }
}
