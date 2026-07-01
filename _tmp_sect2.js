const fs = require("fs");
const text = fs.readFileSync("C:/Users/Projets/AppData/Local/Temp/claude/C--Users-Projets/fc62b5d5-8b06-4c16-a3f6-2c164ca6661f/scratchpad/devis_full.txt", "utf8");
// La section 07 52 00 commence autour de l'index 782587 (Densdeck trouvé)
const dendIdx = text.indexOf("Densdeck");
const sectionStart = text.lastIndexOf("07 52 00", dendIdx);
const sectionHeader = text.lastIndexOf("COUVERTURE", dendIdx);
const start = Math.max(sectionStart - 100, sectionHeader - 100);
const extract = text.substring(start, start + 15000);
console.log("=== SECTION 07 52 00 (depuis index " + start + ") ===");
console.log(extract);
