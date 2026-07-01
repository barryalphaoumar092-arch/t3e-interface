const xlsx = require("xlsx");
const wb = xlsx.readFile("documents/Liste des matériaux avec sds.xlsx");
const sheet = wb.Sheets[wb.SheetNames[0]];
const range = xlsx.utils.decode_range(sheet["!ref"]);
// Chercher sopralene et pente
const keywords2 = ["sopralene","sopra-iso plus pente","tapered","iso pente","pente"];
for(let r = 9; r <= range.e.r; r++){
  const row = [];
  for(let c = 0; c <= 9; c++){
    const cell = sheet[xlsx.utils.encode_cell({r,c})];
    row.push(cell ? String(cell.v || "") : "");
  }
  const rowStr = row.join(" ").toLowerCase();
  if(keywords2.some(k => rowStr.includes(k))){
    console.log("PRODUIT: " + row[4] + " | Fab: " + row[2] + " | Fourn: " + row[3] + " | Sys: " + row[1]);
  }
}
