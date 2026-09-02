// Extraction des heures budgetees (par metier) depuis un fichier "MUE 4.2"
// (Excel ou PDF) uploade manuellement par le reviseur — le site n'a AUCUN
// acces au reseau \\t3e.ca\dfs\... et ne peut jamais aller chercher ce
// fichier lui-meme.
//
// Logique validee manuellement cette session sur 6 MUE reels via Excel COM
// (Cells.Find avec correspondance EXACTE — une recherche partielle sur
// "Grue" matchait a tort une autre section "COUTS NACELLES" ailleurs sur la
// feuille) :
//   - Une cellule contenant EXACTEMENT "COUV" marque le bloc toiture/menuiserie/grue.
//     "MEU" et "Grue" sont 1 et 2 lignes SOUS "COUV", MEME colonne.
//   - Une cellule contenant EXACTEMENT "FERB" marque le bloc ferblanterie.
//     "Atelier" est 1 ligne SOUS "FERB", meme colonne.
//   - Dans les deux cas, la valeur numerique est 4 colonnes A DROITE du label.
//   - La feuille contenant ces labels n'est pas toujours la meme (ex.
//     "1 - SOUMISSION") — on cherche dans TOUTES les feuilles du classeur.
const XLSX = require('xlsx');

function normaliser(s) { return String(s == null ? '' : s).trim(); }

function versNombre(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Cherche dans une grille 2D (tableau de tableaux, tel que retourne par
// sheet_to_json({header:1})) la premiere cellule dont le texte normalise
// correspond EXACTEMENT a `label`. Retourne {r, c} (0-based) ou null.
function trouverCelluleExacte(grille, label) {
  for (let r = 0; r < grille.length; r++) {
    const ligne = grille[r] || [];
    for (let c = 0; c < ligne.length; c++) {
      if (normaliser(ligne[c]) === label) return { r, c };
    }
  }
  return null;
}

function valeurA(grille, r, c) {
  const ligne = grille[r];
  if (!ligne) return null;
  return versNombre(ligne[c]);
}

// buffer : contenu du fichier .xlsx uploade. Retourne
// {couv, meu, grue, ferb, atelier} — champ a null si introuvable (jamais de
// valeur inventee).
function extraireHeuresMueXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });

  for (const nomFeuille of wb.SheetNames) {
    const feuille = wb.Sheets[nomFeuille];
    const grille = XLSX.utils.sheet_to_json(feuille, { header: 1, defval: null, raw: true });

    const posCouv = trouverCelluleExacte(grille, 'COUV');
    const posFerb = trouverCelluleExacte(grille, 'FERB');
    if (!posCouv && !posFerb) continue; // pas la bonne feuille, on continue de chercher

    const couv = posCouv ? valeurA(grille, posCouv.r, posCouv.c + 4) : null;
    const meu = posCouv ? valeurA(grille, posCouv.r + 1, posCouv.c + 4) : null;
    const grue = posCouv ? valeurA(grille, posCouv.r + 2, posCouv.c + 4) : null;
    const ferb = posFerb ? valeurA(grille, posFerb.r, posFerb.c + 4) : null;
    const atelier = posFerb ? valeurA(grille, posFerb.r + 1, posFerb.c + 4) : null;

    return { couv, meu, grue, ferb, atelier };
  }

  return { couv: null, meu: null, grue: null, ferb: null, atelier: null };
}

// Extraction best-effort depuis un PDF — la mise en page en grille n'est PAS
// garantie dans le texte brut extrait, donc nettement moins fiable que
// xlsx. Cherche chaque label suivi (dans une fenetre de texte raisonnable)
// du premier nombre plausible. Si rien n'est trouve, retourne des champs a
// null plutot que de deviner — le formulaire de confirmation reste dans
// tous les cas modifiable a la main.
async function extraireHeuresMuePdf(buffer) {
  let texte = '';
  try {
    const pdfParse = require('pdf-parse');
    const resultat = await pdfParse(buffer);
    texte = resultat.text || '';
  } catch (e) {
    return { couv: null, meu: null, grue: null, ferb: null, atelier: null };
  }

  function chercherApres(label) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[\\s\\S]{0,40}?(-?\\d[\\d\\s]*[.,]?\\d*)', 'i');
    const m = re.exec(texte);
    if (!m) return null;
    return versNombre(m[1].replace(/\s/g, ''));
  }

  return {
    couv: chercherApres('COUV'),
    meu: chercherApres('MEU'),
    grue: chercherApres('Grue'),
    ferb: chercherApres('FERB'),
    atelier: chercherApres('Atelier'),
  };
}

module.exports = { extraireHeuresMueXlsx, extraireHeuresMuePdf };
