const fs = require("fs");
const pdfParse = require("pdf-parse");
const buf = fs.readFileSync("C:/Users/Projets/Downloads/2460_20260401_A_devis_soumission.pdf");
pdfParse(buf).then(data => {
  const text = data.text;
  const keywords = ["07 50", "07 60", "07 70", "COUVERTURE", "TOITURE", "SOPRA", "DENSDECK", "Division 07"];
  for(const kw of keywords){
    const idx = text.toUpperCase().indexOf(kw.toUpperCase());
    if(idx !== -1){
      console.log("=== TROUVE: " + kw + " a index " + idx + " ===");
      console.log(text.substring(Math.max(0,idx-100), idx+600));
      console.log("---");
    }
  }
  fs.writeFileSync("C:/Users/Projets/AppData/Local/Temp/claude/C--Users-Projets/fc62b5d5-8b06-4c16-a3f6-2c164ca6661f/scratchpad/devis_full.txt", text, "utf8");
  console.log("Fichier texte sauvegarde");
}).catch(e => console.error("Erreur:", e.message));
