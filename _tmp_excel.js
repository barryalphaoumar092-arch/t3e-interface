const xlsx = require("xlsx");
// Utiliser le bon chemin avec accent
const wb = xlsx.readFile("documents/Liste des matériaux avec sds.xlsx");
const sheet = wb.Sheets[wb.SheetNames[0]];
const data = xlsx.utils.sheet_to_json(sheet, { defval: "" });
console.log("=== COLONNES ===");
if(data.length > 0) console.log(Object.keys(data[0]).join(" | "));
console.log("\n=== 5 PREMIERES LIGNES ===");
data.slice(0,5).forEach(r => console.log(JSON.stringify(r)));
console.log("\n=== MATERIAUX SOPRA/DENSDECK ===");
const keywords = ["densdeck","elastocol","sopravap","duotack","sopra-iso","soprasmart","sopralene","sopraply","georgia"];
for(const row of data){
  const vals = Object.values(row).join(" ").toLowerCase();
  if(keywords.some(k => vals.includes(k))){
    console.log(JSON.stringify(row));
  }
}
