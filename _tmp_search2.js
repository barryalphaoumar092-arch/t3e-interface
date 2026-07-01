const xlsx = require("xlsx");
const wb = xlsx.readFile("documents/Liste des matériaux avec sds.xlsx");
const sheet = wb.Sheets[wb.SheetNames[0]];
const range = xlsx.utils.decode_range(sheet["!ref"]);

const keywords = [
  "densdeck","elastocol stick","sopravap","duotack","sopra-iso plus",
  "soprasmart iso hd","sopralene flam 250","sopraply flam stick","georgia pacific"
];

const matches = [];
for(let r = 9; r <= range.e.r; r++){
  const row = [];
  for(let c = 0; c <= 9; c++){
    const cell = sheet[xlsx.utils.encode_cell({r,c})];
    row.push(cell ? String(cell.v || "") : "");
  }
  const rowStr = row.join(" ").toLowerCase();
  if(keywords.some(k => rowStr.includes(k))){
    matches.push({
      type: row[0], systeme: row[1], fabricant: row[2], 
      fournisseur: row[3], produit: row[4], dimension: row[5]
    });
    console.log("PRODUIT: " + row[4] + " | Fab: " + row[2] + " | Fourn: " + row[3] + " | Sys: " + row[1]);
  }
}
console.log("\nTotal trouvés:", matches.length);
