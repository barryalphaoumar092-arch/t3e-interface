const fs = require("fs");
const text = fs.readFileSync("C:/Users/Projets/AppData/Local/Temp/claude/C--Users-Projets/fc62b5d5-8b06-4c16-a3f6-2c164ca6661f/scratchpad/devis_full.txt", "utf8");
// Extraire la section 07 52 00
const start = text.indexOf("07 52 00");
const secondOccurrence = text.indexOf("07 52 00", start + 10);
// Chercher le debut de la section
const sectionStart = text.indexOf("Section 07 52 00", start);
const actualStart = Math.min(start, sectionStart > 0 ? sectionStart : Infinity);
// Prendre 20000 chars de la section
const extract = text.substring(actualStart - 500, actualStart + 20000);
console.log(extract);
