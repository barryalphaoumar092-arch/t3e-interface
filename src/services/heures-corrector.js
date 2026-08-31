// Etape 1 du module "Heures" (voir plan squishy-skipping-cook) : transforme
// une feuille de temps brute (export du logiciel de suivi, ~70 colonnes) dans
// le format deja utilise/valide manuellement (C:\RAPPORT HEURES\*.xlsx) :
// 44 colonnes precises, projets R-/I-/SHOP exclus, un onglet par semaine.
//
// Purement logique (tableaux d'objets {enTete: valeur}) -- independant de la
// librairie Excel utilisee pour lire/ecrire, pour rester testable et pour
// que le "vrai" moteur de lecture (xlsx) et d'ecriture (exceljs) restent
// interchangeables sans toucher cette logique metier.

// Ordre et liste EXACTS des colonnes a conserver, confirmes en comparant un
// export brut (Downloads\FDT ...) avec un fichier deja corrige (RAPPORT
// HEURES) colonne par colonne — identification par NOM d'en-tete (pas par
// lettre de colonne), plus robuste si l'ordre brut varie legerement. "Date"
// apparait deux fois dans le brut (colonnes 30 et 33) -- les deux sont
// conservees separement (voir resolveHeaders).
const COLONNES_GARDEES = [
  ' ', 'No, Projet', 'Task', 'User', 'Started at', 'Completed at', 'datetimeinput_0',
  'contremaitre', 'nom', 'prénom', 'numéro_employé', 'catégorie_employé',
  'déplacement', 'début_hors_chantier', 'début_chantier', 'fin_chantier',
  'fin_hors_chantier', 'Diner?', 'total_hors_chantier', 'total_chantier',
  'total', 'note', 'Group', 'Total_H-C', 'Total-C', 'Total_T',
  'Couvreur total (-diner)', 'Vérifié Dinér', 'Nom Compléte', 'Date', 'Jour',
  'Verifiée #', 'Date', 'Employee', 'Last Name', 'Project-#', 'Activity',
  'Group', 'Sector', 'Trade', 'Annex', 'Region', 'Rate Type', 'Hours',
];

// Colonnes brutes explicitement supprimees (documentees pour memoire/audit —
// pas utilisees par le code, la liste GARDEES ci-dessus suffit a filtrer).
const COLONNES_SUPPRIMEES_CONNUES = [
  'Asset', 'richtext_0', 'longtextinput_0', 'yesnona_0', 'signature_0',
  'longtextinput_1', 'Approuvé', 'Note de Surintendant', 'Company', 'Bonus',
  'Equipment', 'Years or Level', 'Union Code', 'Shift', 'Hourly Rate',
  'Equipment Rate', 'Bank', 'W/C - CSST Activity', 'PBB Activity',
  'Reference', 'Work Order', 'Comment',
];

// Codes projet a exclure automatiquement (confirmes absents de tous les
// fichiers deja corriges) : commence par R- ou I-, ou se termine par SHOP.
// RS- et Garantie- ajoutes suite a une comparaison cellule par cellule avec
// les fichiers deja corriges manuellement (voir session) : ces codes (avec
// de vraies heures associees) sont absents de TOUS les fichiers de
// reference, confirmes par l'utilisateur comme categories non-projet
// (comme R-/I-/SHOP) a exclure systematiquement.
function estProjetExclu(code) {
  const c = String(code || '').trim();
  if (!c) return false;
  return /^R-/i.test(c) || /^I-/i.test(c) || /SHOP$/i.test(c) || /^RS-/i.test(c) || /^Garantie-/i.test(c);
}

// Un code "standard" ressemble a NN-NNN (ex: 26-057) ou NN-NNNN. Tout code
// non standard qui n'est PAS deja exclu par estProjetExclu() est ambigu —
// jamais decide silencieusement, toujours remonte au reviseur (voir plan :
// "26-00JC", "26-040P" rencontres cette session).
function estCodeStandard(code) {
  return /^\d{2}-\d{3,5}[A-Z]?$/i.test(String(code || '').trim());
}

// header brut -> index de colonne (0-based), en gerant le doublon "Date"
// (2 occurrences dans le brut, la 1ere = date de saisie/pivot, la 2e = date
// technique du rapport detaille — les deux sont gardees separement donc pas
// besoin de les distinguer ici, juste de prendre chaque occurrence dans
// l'ordre ou elle apparait dans COLONNES_GARDEES).
function resoudreIndexColonnes(enTetesBrutes) {
  const dejaVus = {};
  const indices = [];
  for (const nomGarde of COLONNES_GARDEES) {
    const occurrence = (dejaVus[nomGarde] = (dejaVus[nomGarde] || 0) + 1);
    let vu = 0;
    let idxTrouve = -1;
    for (let i = 0; i < enTetesBrutes.length; i++) {
      if (String(enTetesBrutes[i] || '').trim() === nomGarde) {
        vu++;
        if (vu === occurrence) { idxTrouve = i; break; }
      }
    }
    indices.push(idxTrouve); // -1 si colonne absente du brut (signale, pas d'echec)
  }
  return indices;
}

// lignesBrutes : tableau de tableaux (une ligne = un tableau de valeurs,
// meme ordre que enTetesBrutes), typiquement obtenu via xlsx (sheet_to_json
// avec header:1). Retourne les lignes trimmees/filtrees + ce qui a ete
// ignore/signale, jamais une decision silencieuse sur un cas ambigu.
function corrigerFeuille(enTetesBrutes, lignesBrutes) {
  const indices = resoudreIndexColonnes(enTetesBrutes);
  const idxProjet = COLONNES_GARDEES.indexOf('No, Projet');

  const lignesCorrigees = [];
  const lignesExclues = [];
  const codesAConfirmerSet = new Set();

  for (const ligne of lignesBrutes) {
    const code = ligne[indices[idxProjet]];
    if (!code) continue; // ligne vide (souvent un separateur/sous-total du brut)

    if (estProjetExclu(code)) {
      lignesExclues.push({ code, motif: 'R-/I-/SHOP' });
      continue;
    }
    if (!estCodeStandard(code)) {
      codesAConfirmerSet.add(String(code).trim());
    }

    const ligneTrimmee = indices.map(idx => (idx === -1 ? null : ligne[idx]));
    lignesCorrigees.push(ligneTrimmee);
  }

  return {
    entetes: COLONNES_GARDEES,
    lignes: lignesCorrigees,
    lignesExclues,
    codesAConfirmer: Array.from(codesAConfirmerSet),
  };
}

function parseHeuresNombre(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v || '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// Construit l'equivalent du tableau croise dynamique "Feuil2" (No Projet >
// User > Date > Hours) SOUS FORME DE LIGNES A PLAT deja triees/regroupees,
// pretes a etre ecrites telles quelles dans une feuille (voir
// heures-excel-writer.js) — reproduit la mise en page "compacte" observee
// dans C:\RAPPORT HEURES (une colonne "Etiquettes de lignes" indentee par
// niveau, une colonne "Somme de Hours"). PAS un vrai PivotTable Excel natif
// (risque technique non valide avec exceljs sans environnement de test local
// — voir plan, fallback assume).
// Retourne des lignes {texte, valeur, niveau} — niveau = profondeur d'indentation
// (0=projet, 1=employe, 2=date), reproduisant la mise en forme "compacte" d'un
// vrai PivotTable Excel (indentation croissante, PAS de gras/bordure — verifie
// cellule par cellule sur un fichier de reference reel via Excel COM).
// La colonne "Date" (pas "Started at", qui contient une heure) est utilisee,
// pour matcher exactement le champ utilise par le vrai PivotTable de reference.
function construirePivotStatique(entetes, lignes) {
  const idxProjet = entetes.indexOf('No, Projet');
  const idxUser = entetes.indexOf('User');
  const idxDate = entetes.indexOf('Date');
  const idxHeures = entetes.indexOf('Hours');

  const parProjet = new Map();
  for (const ligne of lignes) {
    const projet = String(ligne[idxProjet] || '').trim();
    const user = String(ligne[idxUser] || '').trim();
    const date = String(ligne[idxDate] || '').trim().slice(0, 10);
    const heures = parseHeuresNombre(ligne[idxHeures]);
    if (!projet) continue;

    if (!parProjet.has(projet)) parProjet.set(projet, { total: 0, users: new Map() });
    const p = parProjet.get(projet);
    p.total += heures;
    if (!p.users.has(user)) p.users.set(user, { total: 0, dates: new Map() });
    const u = p.users.get(user);
    u.total += heures;
    u.dates.set(date, (u.dates.get(date) || 0) + heures);
  }

  const rows = [{ texte: 'Étiquettes de lignes', valeur: 'Somme de Hours', niveau: 0 }];
  for (const [projet, p] of parProjet) {
    rows.push({ texte: projet, valeur: Math.round(p.total * 100) / 100, niveau: 0 });
    for (const [user, u] of p.users) {
      rows.push({ texte: user, valeur: Math.round(u.total * 100) / 100, niveau: 1 });
      for (const [date, h] of u.dates) {
        if (date) rows.push({ texte: date, valeur: Math.round(h * 100) / 100, niveau: 2 });
      }
    }
  }
  return rows;
}

module.exports = {
  COLONNES_GARDEES,
  COLONNES_SUPPRIMEES_CONNUES,
  estProjetExclu,
  estCodeStandard,
  resoudreIndexColonnes,
  corrigerFeuille,
  construirePivotStatique,
};
