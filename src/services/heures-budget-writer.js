// Complete les "Hrs Budgetees" manquantes dans Suivi des Heures.xlsx pour un
// projet donne, a partir des valeurs extraites (et confirmees/corrigees par
// le reviseur) d'un MUE 4.2 — voir heures-mue-extractor.js.
//
// MEME PIEGE que heures-suivi-writer.js : ce fichier contient un Tableau
// structure Excel + des formules SUBTOTAL(). JAMAIS exceljs (deja corrompu
// ce fichier deux fois cette session) — uniquement JSZip + manipulation XML
// ciblee, ici encore plus simple que l'insertion de colonne : on edite des
// cellules EXISTANTES (colonne E), jamais de decalage de colonne.
//
// ATTENTION (regle utilisateur, absolue) : ne JAMAIS toucher a la colonne
// "Hrs Reelles" (COL_HRS_REELLES) autrement que pour appliquer/retirer le remplissage rouge
// quand elle depasse E — jamais modifier sa valeur.
const XLSX = require('xlsx');
const JSZip = require('jszip');
const {
  NOM_FEUILLE, COL_PROJET, COL_METIER, COL_HRS_BUDGETEES, COL_HRS_REELLES,
  trouverCheminFeuille, tokeniserLigne, nombreDeColonne, lettreDeColonne,
} = require('./heures-suivi-writer');

const METIERS_BUDGET = ['Couvreur', 'Ferblantier', 'Menuiser', 'Grutier'];
const ROUGE_RGB = 'FFD65A5A'; // rouge attenue, meme convention que le style manuel

function normaliser(s) { return String(s == null ? '' : s).trim(); }

// Lit Suivi des Heures et regroupe les lignes par bloc projet (TOTAL + 4 metiers).
// Retourne Map projet -> { total: {ligne, budgetee}, metiers: { Couvreur: {ligne, budgetee}, ... } }.
function analyserBlocsProjets(bufferSuivi) {
  const wb = XLSX.read(bufferSuivi, { type: 'buffer' });
  const feuille = wb.Sheets[NOM_FEUILLE];
  const lignes = XLSX.utils.sheet_to_json(feuille, { header: 1, defval: null });

  const blocs = new Map();
  let projetCourant = null;
  for (let i = 1; i < lignes.length; i++) {
    const ligne = lignes[i];
    const projetCell = normaliser(ligne[COL_PROJET - 1]);
    const metier = normaliser(ligne[COL_METIER - 1]);
    if (projetCell) projetCourant = projetCell;
    if (!projetCourant) continue;

    if (!blocs.has(projetCourant)) blocs.set(projetCourant, { total: null, metiers: {} });
    const bloc = blocs.get(projetCourant);
    const budgetee = ligne[COL_HRS_BUDGETEES - 1];
    const reelles = ligne[COL_HRS_REELLES - 1];
    const numLigne = i + 1; // 1-based

    if (metier === 'TOTAL') {
      bloc.total = { ligne: numLigne, budgetee, reelles };
    } else if (METIERS_BUDGET.includes(metier)) {
      bloc.metiers[metier] = { ligne: numLigne, budgetee, reelles };
    }
  }
  return blocs;
}

// Liste des codes projet (colonne "No, Projet") presents dans le fichier
// corrige (etape 1) d'UN depot — sert a restreindre la detection ci-dessous
// au depot en cours plutot qu'a tout Suivi des Heures (des centaines de projets
// historiques sans rapport avec la semaine consultee).
function extraireProjetsDepot(bufferCorrige) {
  const wb = XLSX.read(bufferCorrige, { type: 'buffer' });
  const feuille = wb.Sheets[wb.SheetNames[0]];
  const lignes = XLSX.utils.sheet_to_json(feuille, { defval: null });
  const projets = new Set();
  for (const ligne of lignes) {
    const projet = normaliser(ligne['No, Projet']);
    if (projet) projets.add(projet);
  }
  return projets;
}

// bufferSuivi : contenu actuel de Suivi des Heures.xlsx. Retourne la liste des
// projets ou AU MOINS UN des 4 metiers a une case "Hrs Budgetees" vide —
// jamais de faux positif si toutes les valeurs sont deja presentes.
// filtreProjets (optionnel) : Set de codes projet — si fourni, ne retourne
// que les projets du depot en cours (voir extraireProjetsDepot), pas tout
// l'historique d'Suivi des Heures.
function detecterProjetsSansBudget(bufferSuivi, filtreProjets) {
  const blocs = analyserBlocsProjets(bufferSuivi);
  const resultat = [];
  for (const [projet, bloc] of blocs) {
    if (filtreProjets && !filtreProjets.has(projet)) continue;
    const manquants = METIERS_BUDGET.filter(m => {
      const info = bloc.metiers[m];
      return !info || info.budgetee === null || info.budgetee === undefined || info.budgetee === '';
    });
    if (manquants.length > 0) resultat.push({ projet, metiersManquants: manquants });
  }
  // Ordre stable et lisible pour l'affichage.
  resultat.sort((a, b) => a.projet.localeCompare(b.projet));
  return resultat;
}

function echapperXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Cherche l'attribut s="" (index de style) d'une cellule XML deja tokenisee — null si absent.
function extraireStyleIndex(celluleXml) {
  const m = /<c[^>]*\ss="(\d+)"/.exec(celluleXml);
  return m ? parseInt(m[1], 10) : null;
}

// Construit/reutilise (cache local a l'appel) un index de style clone du
// style de base avec un remplissage rouge solide en plus — jamais de
// reindexation des styles existants, seulement des AJOUTS en fin de
// collection (meme principe que le dxf rouge de heures-suivi-writer.js).
function creerGestionnaireStyleRouge(stylesXmlInitial) {
  let stylesXml = stylesXmlInitial;
  const cache = new Map(); // baseStyleIndex (ou 'defaut') -> nouvelIndex

  // Rouge attenue (D65A5A) — meme convention que la coloration statique
  // appliquee manuellement cette session sur le fichier reel, plus douce
  // que le rouge pur d'origine (FFFF0000).
  function assurerFillRouge() {
    const mFills = /<fills count="(\d+)">([\s\S]*?)<\/fills>/.exec(stylesXml);
    if (!mFills) throw new Error('<fills> introuvable dans styles.xml');
    // Reutilise si deja cree lors d'un appel precedent (idempotent).
    const dejaLa = /<fill><patternFill patternType="solid"><fgColor rgb="FFD65A5A"\/><bgColor indexed="64"\/><\/patternFill><\/fill>/.exec(mFills[2]);
    if (dejaLa) {
      const avant = mFills[2].slice(0, dejaLa.index);
      return (avant.match(/<fill>/g) || []).length;
    }
    const count = parseInt(mFills[1], 10);
    const nouveauFill = '<fill><patternFill patternType="solid"><fgColor rgb="FFD65A5A"/><bgColor indexed="64"/></patternFill></fill>';
    stylesXml = stylesXml.replace(mFills[0], `<fills count="${count + 1}">${mFills[2]}${nouveauFill}</fills>`);
    return count;
  }

  // Police en gras pour le texte des cellules rougies — meme convention que
  // la coloration statique manuelle (texte plus visible sur fond rouge).
  function assurerPoliceGrasseDepuis(fontIdBase) {
    const mFonts = /<fonts count="(\d+)"([^>]*)>([\s\S]*?)<\/fonts>/.exec(stylesXml);
    if (!mFonts) throw new Error('<fonts> introuvable dans styles.xml');
    const entreesFonts = [...mFonts[3].matchAll(/<font>[\s\S]*?<\/font>/g)].map(m => m[0]);
    const baseFont = entreesFonts[fontIdBase] || '<font><sz val="11"/><name val="Calibri"/></font>';
    if (/<b\/>/.test(baseFont)) {
      // Deja en gras : reutilise tel quel (evite un doublon inutile).
      return fontIdBase;
    }
    const count = parseInt(mFonts[1], 10);
    const policeGrasse = baseFont.replace('<font>', '<font><b/>');
    stylesXml = stylesXml.replace(mFonts[0], `<fonts count="${count + 1}"${mFonts[2]}>${mFonts[3]}${policeGrasse}</fonts>`);
    return count;
  }

  function indexPourStyleRouge(baseStyleIndex) {
    const cle = baseStyleIndex === null ? 'defaut' : String(baseStyleIndex);
    if (cache.has(cle)) return cache.get(cle);

    const idFillRouge = assurerFillRouge();

    const mXfs = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    if (!mXfs) throw new Error('<cellXfs> introuvable dans styles.xml');
    const count = parseInt(mXfs[1], 10);
    const entrees = [...mXfs[2].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(m => m[0]);
    const base = baseStyleIndex !== null && entrees[baseStyleIndex] ? entrees[baseStyleIndex] : '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';

    const fontIdBase = (/fontId="(\d+)"/.exec(base) || [null, '0'])[1];
    const idPoliceGrasse = assurerPoliceGrasseDepuis(parseInt(fontIdBase, 10));

    // Clone la balise ouvrante en remplacant/ajoutant fillId+fontId (+ les
    // "apply" correspondants), en conservant tout le reste (bordures,
    // format) intact.
    let ligneOuvrante = base.match(/^<xf\b[^>]*?(?:\/>|>)/)[0];
    let nouvelleOuvrante = /fillId="\d+"/.test(ligneOuvrante)
      ? ligneOuvrante.replace(/fillId="\d+"/, `fillId="${idFillRouge}"`)
      : ligneOuvrante.replace(/^<xf\b/, `<xf fillId="${idFillRouge}"`);
    nouvelleOuvrante = /applyFill="\d+"/.test(nouvelleOuvrante)
      ? nouvelleOuvrante.replace(/applyFill="\d+"/, 'applyFill="1"')
      : nouvelleOuvrante.replace(/\/?>$/, m => ` applyFill="1"${m}`);
    nouvelleOuvrante = /fontId="\d+"/.test(nouvelleOuvrante)
      ? nouvelleOuvrante.replace(/fontId="\d+"/, `fontId="${idPoliceGrasse}"`)
      : nouvelleOuvrante.replace(/^<xf\b/, `<xf fontId="${idPoliceGrasse}"`);
    nouvelleOuvrante = /applyFont="\d+"/.test(nouvelleOuvrante)
      ? nouvelleOuvrante.replace(/applyFont="\d+"/, 'applyFont="1"')
      : nouvelleOuvrante.replace(/\/?>$/, m => ` applyFont="1"${m}`);
    const nouvelleEntree = base.endsWith('/>') ? nouvelleOuvrante : nouvelleOuvrante + base.slice(ligneOuvrante.length);

    stylesXml = stylesXml.replace(mXfs[0], `<cellXfs count="${count + 1}">${mXfs[2]}${nouvelleEntree}</cellXfs>`);
    cache.set(cle, count);
    return count;
  }

  return { indexPourStyleRouge, obtenirStylesXml: () => stylesXml };
}

// Remplace/insere une cellule (colonne cible, valeur numerique ou formule)
// dans une ligne <row> deja localisee — jamais de recherche/insertion ad-hoc
// dans une chaine hors de cette ligne isolee (meme approche que
// heures-suivi-writer.js : tokenisation, comparaison numerique de position).
function ecrireCelluleDansLigne(xml, numLigne, colCible, construireXmlCellule) {
  const reLigne = new RegExp(`<row r="${numLigne}"([^>]*)>(.*?)<\\/row>`, 's');
  const m = reLigne.exec(xml);
  if (!m) throw new Error(`Ligne ${numLigne} introuvable dans la feuille`);

  const cellules = tokeniserLigne(m[2]);
  const existante = cellules.find(c => c.colIndex === colCible);
  const nouvelleCelluleXml = construireXmlCellule(existante ? existante.xml : null);

  let parties;
  if (existante) {
    parties = cellules.map(c => c.colIndex === colCible ? nouvelleCelluleXml : c.xml);
  } else {
    let inseree = false;
    parties = [];
    for (const c of cellules) {
      if (!inseree && c.colIndex > colCible) { parties.push(nouvelleCelluleXml); inseree = true; }
      parties.push(c.xml);
    }
    if (!inseree) parties.push(nouvelleCelluleXml);
  }

  return xml.replace(m[0], `<row r="${numLigne}"${m[1]}>${parties.join('')}</row>`);
}

// bufferSuivi : contenu actuel de Suivi des Heures.xlsx.
// projet : code projet (ex "26-062").
// valeursMue : { couv, ferb, meu, grue, atelier } — deja confirmees/corrigees
// par le reviseur (jamais ecrites sans validation humaine).
// Retourne { buffer, ecrit: { Couvreur, Ferblantier, Menuiser, Grutier }, celluesRougies }.
async function ecrireHeuresBudgetees(bufferSuivi, projet, valeursMue) {
  const blocs = analyserBlocsProjets(bufferSuivi);
  const bloc = blocs.get(normaliser(projet));
  if (!bloc || !bloc.total) throw new Error(`Projet "${projet}" introuvable dans Suivi des Heures.xlsx`);

  const valeursParMetier = {
    Couvreur: valeursMue.couv,
    Ferblantier: (Number(valeursMue.ferb) || 0) + (Number(valeursMue.atelier) || 0),
    Menuiser: valeursMue.meu,
    Grutier: valeursMue.grue,
  };

  const zip = await JSZip.loadAsync(bufferSuivi);
  const cheminFeuille = await trouverCheminFeuille(zip, NOM_FEUILLE);
  let xml = await zip.file(cheminFeuille).async('string');

  const colE = lettreDeColonne(COL_HRS_BUDGETEES);
  const colReelles = lettreDeColonne(COL_HRS_REELLES);

  const ecrit = {};
  let totalBudgete = 0;
  let ligneDebut = null, ligneFin = null;

  for (const metier of METIERS_BUDGET) {
    const info = bloc.metiers[metier];
    if (!info) continue; // pas de ligne pour ce metier dans ce bloc, on n'invente rien
    const valeur = valeursParMetier[metier];
    if (valeur === null || valeur === undefined || Number.isNaN(Number(valeur))) continue;
    const v = Number(valeur);
    totalBudgete += v;
    ecrit[metier] = v;
    ligneDebut = ligneDebut === null ? info.ligne : Math.min(ligneDebut, info.ligne);
    ligneFin = ligneFin === null ? info.ligne : Math.max(ligneFin, info.ligne);

    xml = ecrireCelluleDansLigne(xml, info.ligne, COL_HRS_BUDGETEES, (existanteXml) => {
      const style = existanteXml ? extraireStyleIndex(existanteXml) : null;
      const sAttr = style !== null ? ` s="${style}"` : '';
      return `<c r="${colE}${info.ligne}"${sAttr}><v>${v}</v></c>`;
    });
  }

  // Ligne TOTAL : formule SUBTOTAL(109, ...) — meme convention que le reste
  // du fichier — seulement si elle est absente (jamais d'ecrasement d'une
  // formule/valeur deja saisie manuellement).
  if (ligneDebut !== null && (bloc.total.budgetee === null || bloc.total.budgetee === undefined || bloc.total.budgetee === '')) {
    xml = ecrireCelluleDansLigne(xml, bloc.total.ligne, COL_HRS_BUDGETEES, (existanteXml) => {
      const style = existanteXml ? extraireStyleIndex(existanteXml) : null;
      const sAttr = style !== null ? ` s="${style}"` : '';
      return `<c r="${colE}${bloc.total.ligne}"${sAttr}><f>SUBTOTAL(109,${colE}${ligneDebut}:${colE}${ligneFin})</f><v>${totalBudgete}</v></c>`;
    });
  }

  // Coloration rouge des cellules "Hrs Reelles" (H) qui depassent desormais
  // leur budget — remplissage statique direct sur la cellule, meme
  // convention que les ~100 cellules deja coloriees manuellement dans ce
  // fichier (pas une regle de mise en forme conditionnelle ici). JAMAIS de
  // modification de la VALEUR de H — uniquement son style.
  const stylesXmlInitial = await zip.file('xl/styles.xml').async('string');
  const gestionnaireStyle = creerGestionnaireStyleRouge(stylesXmlInitial);
  let celluesRougies = 0;

  const lignesAVerifier = [bloc.total.ligne, ...METIERS_BUDGET.filter(m => ecrit[m] !== undefined).map(m => bloc.metiers[m].ligne)];
  for (const numLigne of lignesAVerifier) {
    const info = numLigne === bloc.total.ligne ? bloc.total : Object.values(bloc.metiers).find(i => i.ligne === numLigne);
    const budgetee = numLigne === bloc.total.ligne ? totalBudgete : ecrit[METIERS_BUDGET.find(m => bloc.metiers[m] && bloc.metiers[m].ligne === numLigne)];
    const reellesActuel = info ? info.reelles : null;
    const h = typeof reellesActuel === 'number' ? reellesActuel : parseFloat(reellesActuel);
    if (!Number.isFinite(h) || !Number.isFinite(budgetee) || h <= budgetee) continue;

    xml = ecrireCelluleDansLigne(xml, numLigne, COL_HRS_REELLES, (existanteXml) => {
      if (!existanteXml) return `<c r="${colReelles}${numLigne}"/>`; // ne devrait pas arriver (Hrs Réelles a une valeur)
      const styleActuel = extraireStyleIndex(existanteXml);
      const nouveauStyle = gestionnaireStyle.indexPourStyleRouge(styleActuel);
      const avecNouveauStyle = /\ss="\d+"/.test(existanteXml)
        ? existanteXml.replace(/\ss="\d+"/, ` s="${nouveauStyle}"`)
        : existanteXml.replace(/^<c\b/, `<c s="${nouveauStyle}"`);
      return avecNouveauStyle;
    });
    celluesRougies++;
  }

  zip.file('xl/styles.xml', gestionnaireStyle.obtenirStylesXml());
  zip.file(cheminFeuille, xml);

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, ecrit, celluesRougies };
}

module.exports = { detecterProjetsSansBudget, ecrireHeuresBudgetees, extraireProjetsDepot, METIERS_BUDGET };
