const xlsx = require("xlsx");
const wb = xlsx.readFile("documents/Liste des matériaux avec sds.xlsx");
const sheetNames = wb.SheetNames;
console.log("Feuilles:", sheetNames);
const sheet = wb.Sheets[sheetNames[0]];
// Lire les 30 premieres lignes brutes
const range = xlsx.utils.decode_range(sheet["!ref"]);
for(let r = 0; r <= Math.min(30, range.e.r); r++){
  const row = [];
  for(let c = 0; c <= Math.min(10, range.e.c); c++){
    const cell = sheet[xlsx.utils.encode_cell({r,c})];
    row.push(cell ? (cell.v || "") : "");
  }
  if(row.some(v => v !== "")) console.log("Ligne " + r + ": " + JSON.stringify(row));
}
