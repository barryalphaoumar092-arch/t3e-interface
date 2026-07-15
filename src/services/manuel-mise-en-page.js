// Mise en page « modèle Norma McAlister » du manuel de fin de chantier —
// toutes les pages générées (couverture, table des matières, sections
// rédigées, pages séparatrices) sont dessinées directement en pdf-lib pour
// reproduire fidèlement le modèle approuvé par l'utilisateur (2026-07-15) :
// bandeau rouge T3E, photo de couverture encadrée, tableau « Informations du
// projet », encadrés gris à titres rouges, pages séparatrices à numéro en
// filigrane, sommaire à pointillés cliquable.
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');

const ROUGE_T3E = rgb(0.784, 0.063, 0.180);      // #C8102E
const GRIS_TEXTE = rgb(0.35, 0.35, 0.35);
const GRIS_SOUS_TITRE = rgb(0.45, 0.45, 0.45);
const GRIS_FONCE = rgb(0.2, 0.2, 0.2);
const GRIS_BANDE = rgb(0.937, 0.937, 0.937);      // #efefef
const GRIS_BOITE = rgb(0.969, 0.969, 0.969);      // #f7f7f7
const GRIS_BORDURE = rgb(0.8, 0.8, 0.8);
const GRIS_FILIGRANE = rgb(0.88, 0.88, 0.88);
const BLANC = rgb(1, 1, 1);
const NOIR_DOUX = rgb(0.15, 0.15, 0.15);

const PAGE_LARGEUR = 612;   // Letter
const PAGE_HAUTEUR = 792;
const MARGE = 50;

// Les polices standard pdf-lib (Helvetica) n'encodent que WinAnsi — tout
// caractère hors plage (☐, œ isolé de certaines saisies, tirets typographiques
// exotiques…) fait planter drawText (même piège que sur les formulaires SEAO).
function nettoyerWinAnsi(texte) {
  return String(texte || '')
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/œ/g, 'oe').replace(/Œ/g, 'OE')
    .replace(/[☐☑☒]/g, '[ ]')
    .replace(/[^\x20-\x7E -ÿ\n]/g, ' ');
}

async function preparerPolices(pdfDoc) {
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return { font, fontBold };
}

// Découpe un texte en lignes qui tiennent dans maxWidth (retours à la ligne
// explicites respectés).
function couperLignes(font, texte, taille, maxWidth) {
  const lignes = [];
  for (const paragraphe of nettoyerWinAnsi(texte).split('\n')) {
    const mots = paragraphe.split(/\s+/).filter(Boolean);
    if (mots.length === 0) { lignes.push(''); continue; }
    let courante = '';
    for (const mot of mots) {
      const essai = courante ? courante + ' ' + mot : mot;
      if (font.widthOfTextAtSize(essai, taille) <= maxWidth || !courante) {
        courante = essai;
      } else {
        lignes.push(courante);
        courante = mot;
      }
    }
    if (courante) lignes.push(courante);
  }
  return lignes;
}

// ── En-tête / pied de page des pages de contenu générées ────────────────────
function dessinerEnTete(page, fonts, { dossier } = {}) {
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 0, y: height - 24, width, height: 24, color: ROUGE_T3E });
  page.drawRectangle({ x: 0, y: height - 32, width, height: 8, color: GRIS_BANDE });
  page.drawText('Toitures Trois Étoiles Inc.', {
    x: MARGE, y: height - 56, size: 12, font: fonts.font, color: NOIR_DOUX,
  });
  if (dossier) {
    const texte = nettoyerWinAnsi('Dossier ' + dossier);
    const w = fonts.font.widthOfTextAtSize(texte, 11);
    page.drawText(texte, { x: width - MARGE - w, y: height - 56, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE });
  }
  page.drawLine({
    start: { x: MARGE, y: 46 }, end: { x: width - MARGE, y: 46 },
    thickness: 0.5, color: GRIS_BORDURE,
  });
}

// ── Couverture ───────────────────────────────────────────────────────────────
// photoImage : PDFImage (embedJpg/embedPng) déjà embarquée, ou null.
function dessinerCouverture(pdfDoc, fonts, champs, photoImage) {
  const page = pdfDoc.addPage([PAGE_LARGEUR, PAGE_HAUTEUR]);
  const { width, height } = page.getSize();

  // Bandeau rouge + sous-bande grise
  page.drawRectangle({ x: 0, y: height - 115, width, height: 115, color: ROUGE_T3E });
  page.drawText('Toitures Trois Étoiles Inc.', {
    x: MARGE, y: height - 52, size: 15, font: fonts.font, color: BLANC,
  });
  page.drawText('Manuel de fin de chantier', {
    x: MARGE, y: height - 88, size: 30, font: fonts.fontBold, color: BLANC,
  });
  page.drawRectangle({ x: 0, y: height - 152, width, height: 37, color: GRIS_BANDE });
  page.drawText('Projet de réfection de toiture', {
    x: MARGE, y: height - 141, size: 15, font: fonts.font, color: GRIS_FONCE,
  });

  // Photo encadrée (optionnelle)
  let yPanel = height - 200;
  if (photoImage) {
    const cadreX = 92, cadreW = width - 184;
    const cadreH = 230, cadreY = height - 185 - cadreH;
    page.drawRectangle({
      x: cadreX, y: cadreY, width: cadreW, height: cadreH,
      color: BLANC, borderColor: GRIS_BORDURE, borderWidth: 1,
    });
    const maxW = cadreW - 56, maxH = cadreH - 24;
    const ratio = Math.min(maxW / photoImage.width, maxH / photoImage.height);
    const w = photoImage.width * ratio, h = photoImage.height * ratio;
    page.drawImage(photoImage, {
      x: cadreX + (cadreW - w) / 2, y: cadreY + (cadreH - h) / 2, width: w, height: h,
    });
    yPanel = cadreY - 22;
  }

  // Panneau « Informations du projet »
  const px = 58, pw = width - 116;
  const lignesInfo = [
    ['Nom du projet', champs.NOM_DU_PROJET],
    ['Client', champs.CLIENT],
    ['Adresse du projet', champs.ADRESSE_PROJET],
    ['Numéro de dossier TTE', champs.NUMERO_DOSSIER],
    ['Date', champs.DATE],
  ].filter((l) => l[1]);

  const colLabelW = 170, colValX = px + 14 + colLabelW + 14;
  const colValW = pw - 28 - colLabelW - 28 - 14;
  const rangees = lignesInfo.map(([label, valeur]) => {
    const lignes = couperLignes(fonts.font, valeur, 12, colValW);
    return { label, lignes, h: Math.max(36, lignes.length * 17 + 20) };
  });
  const enteteH = 34;
  const panneauH = enteteH + 12 + rangees.reduce((s, r) => s + r.h, 0) + 16;

  const py = yPanel - panneauH;
  page.drawRectangle({ x: px, y: py, width: pw, height: panneauH, color: BLANC, borderColor: GRIS_BORDURE, borderWidth: 1 });
  page.drawRectangle({ x: px, y: py + panneauH - enteteH, width: pw, height: enteteH, color: GRIS_BANDE, borderColor: GRIS_BORDURE, borderWidth: 1 });
  page.drawText('Informations du projet', {
    x: px + 16, y: py + panneauH - enteteH + 11, size: 13, font: fonts.font, color: GRIS_FONCE,
  });

  let ry = py + panneauH - enteteH - 12;
  for (const r of rangees) {
    ry -= r.h;
    page.drawRectangle({ x: px + 14, y: ry, width: pw - 28, height: r.h, color: BLANC, borderColor: GRIS_BORDURE, borderWidth: 0.6 });
    page.drawRectangle({ x: px + 14, y: ry, width: colLabelW, height: r.h, color: GRIS_BOITE, borderColor: GRIS_BORDURE, borderWidth: 0.6 });
    page.drawText(nettoyerWinAnsi(r.label), { x: px + 26, y: ry + r.h - 24, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE });
    let ly = ry + r.h - 24;
    for (const ligne of r.lignes) {
      page.drawText(ligne, { x: colValX, y: ly, size: 12, font: fonts.font, color: NOIR_DOUX });
      ly -= 17;
    }
  }

  // Pied de couverture : coordonnées T3E
  page.drawText('7550, rue Saint-Patrick, LaSalle (Québec) H8N 1V1', {
    x: MARGE, y: 74, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE,
  });
  page.drawText('Tél. 514 365-6600  ·  info@toiturestroisetoiles.com  ·  toiturestroisetoiles.com', {
    x: MARGE, y: 56, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE,
  });

  return page;
}

// ── Titre de section rédigée (« N. Titre » rouge + filet + sous-titre) ──────
function dessinerTitreSection(page, fonts, { numero, titre, sousTitre }) {
  const { width, height } = page.getSize();
  page.drawText(nettoyerWinAnsi(`${numero}. ${titre}`), {
    x: MARGE, y: height - 105, size: 22, font: fonts.font, color: ROUGE_T3E,
  });
  page.drawLine({
    start: { x: MARGE, y: height - 116 }, end: { x: width - MARGE, y: height - 116 },
    thickness: 1.2, color: ROUGE_T3E,
  });
  if (sousTitre) {
    page.drawText(nettoyerWinAnsi(sousTitre), { x: MARGE, y: height - 138, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE });
  }
  return height - 170;
}

// ── Section rédigée : blocs encadrés (texte ou liste à puces) ────────────────
// blocs : [{ titre, texte }] ou [{ titre, items: [...] }] ; intro optionnelle
// { titre, texte } affichée sans encadré au-dessus des blocs.
function dessinerSectionRedigee(pdfDoc, fonts, { numero, titre, sousTitre, dossier, intro, blocs }) {
  let page = pdfDoc.addPage([PAGE_LARGEUR, PAGE_HAUTEUR]);
  dessinerEnTete(page, fonts, { dossier });
  let y = dessinerTitreSection(page, fonts, { numero, titre, sousTitre });
  const largeurUtile = PAGE_LARGEUR - 2 * MARGE;

  const nouvellePageSiBesoin = (hauteurRequise) => {
    if (y - hauteurRequise < 70) {
      page = pdfDoc.addPage([PAGE_LARGEUR, PAGE_HAUTEUR]);
      dessinerEnTete(page, fonts, { dossier });
      y = PAGE_HAUTEUR - 90;
    }
  };

  if (intro) {
    if (intro.titre) {
      nouvellePageSiBesoin(24);
      page.drawText(nettoyerWinAnsi(intro.titre), { x: MARGE, y, size: 15, font: fonts.fontBold, color: GRIS_FONCE });
      y -= 24;
    }
    if (intro.texte) {
      const lignes = couperLignes(fonts.font, intro.texte, 11, largeurUtile - 60);
      nouvellePageSiBesoin(lignes.length * 16 + 14);
      for (const ligne of lignes) {
        page.drawText(ligne, { x: MARGE, y, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE });
        y -= 16;
      }
      y -= 14;
    }
  }

  let alterne = 0;
  for (const bloc of blocs) {
    const pad = 18;
    const corpsW = largeurUtile - 2 * pad - 14;
    let lignes;
    if (bloc.items) {
      lignes = [];
      for (const item of bloc.items) {
        const l = couperLignes(fonts.font, item, 12, corpsW - 18);
        l.forEach((t, i) => lignes.push({ t, puce: i === 0 }));
      }
    } else {
      lignes = couperLignes(fonts.font, bloc.texte, 12.5, corpsW).map((t) => ({ t, puce: false }));
    }
    const hauteur = pad + 18 + 14 + lignes.length * 19 + pad - 4;
    nouvellePageSiBesoin(hauteur + 8);

    const fond = alterne % 2 === 0 ? GRIS_BOITE : BLANC;
    page.drawRectangle({
      x: MARGE, y: y - hauteur, width: largeurUtile, height: hauteur,
      color: fond, borderColor: GRIS_BORDURE, borderWidth: 1,
    });
    page.drawText(nettoyerWinAnsi(bloc.titre), {
      x: MARGE + pad, y: y - pad - 12, size: 13.5, font: fonts.font, color: ROUGE_T3E,
    });
    let ly = y - pad - 12 - 26;
    for (const ligne of lignes) {
      if (ligne.puce) {
        page.drawCircle({ x: MARGE + pad + 5, y: ly + 4, size: 2.6, color: ROUGE_T3E });
      }
      page.drawText(ligne.t, {
        x: MARGE + pad + (bloc.items ? 18 : 2), y: ly, size: bloc.items ? 12 : 12.5,
        font: fonts.font, color: GRIS_FONCE,
      });
      ly -= 19;
    }
    y -= hauteur + 22;
    alterne++;
  }
}

// ── Page séparatrice (avant chaque catégorie de documents joints) ────────────
function dessinerPageSeparatrice(pdfDoc, fonts, { numero, titre, sousTitre, note }) {
  const page = pdfDoc.addPage([PAGE_LARGEUR, PAGE_HAUTEUR]);
  const { width, height } = page.getSize();

  // En-tête : bloc rouge à gauche + bande grise
  page.drawRectangle({ x: 0, y: height - 92, width, height: 52, color: GRIS_BANDE });
  page.drawRectangle({ x: 0, y: height - 92, width: 238, height: 92, color: ROUGE_T3E });
  page.drawText('Toitures Trois Étoiles Inc.', {
    x: MARGE, y: height - 62, size: 14, font: fonts.font, color: BLANC,
  });

  // Numéro en filigrane + titre
  if (numero) {
    page.drawText(String(numero), {
      x: MARGE, y: height - 270, size: 96, font: fonts.font, color: GRIS_FILIGRANE,
    });
  }
  page.drawText(nettoyerWinAnsi(titre), {
    x: 128, y: height - 232, size: 24, font: fonts.font, color: ROUGE_T3E,
  });
  page.drawLine({
    start: { x: 128, y: height - 244 }, end: { x: width - MARGE, y: height - 244 },
    thickness: 1.2, color: ROUGE_T3E,
  });
  if (sousTitre) {
    page.drawText(nettoyerWinAnsi(sousTitre), { x: 128, y: height - 266, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE });
  }

  const noteTexte = note || `Cette section contient les documents joints au dossier.`;
  const lignes = couperLignes(fonts.font, noteTexte, 13, width - 128 - MARGE - 76);
  const boxH = lignes.length * 19 + 44;
  page.drawRectangle({
    x: 128, y: height - 330 - boxH, width: width - 128 - MARGE, height: boxH, color: GRIS_BOITE,
  });
  let ly = height - 330 - 28;
  for (const ligne of lignes) {
    page.drawText(ligne, { x: 148, y: ly, size: 13, font: fonts.font, color: GRIS_FONCE });
    ly -= 19;
  }

  page.drawLine({
    start: { x: MARGE, y: 46 }, end: { x: width - MARGE, y: 46 },
    thickness: 0.5, color: GRIS_BORDURE,
  });
  return page;
}

// ── Sommaire pointillé cliquable + numérotation de toutes les pages ─────────
function ajouterLienInterne(pdfDoc, page, rect, targetPage) {
  const linkDict = pdfDoc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    Dest: [targetPage.ref, 'XYZ', null, null, null],
  });
  const linkRef = pdfDoc.context.register(linkDict);
  const existants = page.node.Annots();
  if (existants) existants.push(linkRef);
  else page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([linkRef]));
}

// Remplace la page 2 (placeholder) par la vraie table des matières — appelée
// APRÈS assemblage complet (les numéros de page ne sont connus qu'à la fin).
// sections : [{ label, pageDebut (1-based) }]
async function construireSommaireEtNumeroter(pdfDoc, sections, { dossier, sousTitre } = {}) {
  const fonts = await preparerPolices(pdfDoc);
  const { width, height } = pdfDoc.getPage(0).getSize();

  pdfDoc.removePage(1);
  const toc = pdfDoc.insertPage(1, [width, height]);
  dessinerEnTete(toc, fonts, { dossier });

  toc.drawText('Table des matières', {
    x: MARGE, y: height - 105, size: 24, font: fonts.font, color: ROUGE_T3E,
  });
  toc.drawLine({
    start: { x: MARGE, y: height - 116 }, end: { x: width - MARGE, y: height - 116 },
    thickness: 1.2, color: ROUGE_T3E,
  });
  if (sousTitre) {
    toc.drawText(nettoyerWinAnsi(sousTitre), { x: MARGE, y: height - 138, size: 11, font: fonts.font, color: GRIS_SOUS_TITRE });
  }

  let y = height - 185;
  let numero = 1;
  for (const section of sections) {
    const label = nettoyerWinAnsi(section.label);
    toc.drawText(`${numero}.`, { x: MARGE, y, size: 13, font: fonts.font, color: GRIS_FONCE });
    toc.drawText(label, { x: MARGE + 28, y, size: 13, font: fonts.font, color: GRIS_FONCE });

    const numTexte = String(section.pageDebut);
    const numLargeur = fonts.font.widthOfTextAtSize(numTexte, 13);
    toc.drawText(numTexte, { x: width - MARGE - numLargeur, y, size: 13, font: fonts.font, color: GRIS_FONCE });

    const labelFin = MARGE + 28 + fonts.font.widthOfTextAtSize(label, 13) + 14;
    toc.drawLine({
      start: { x: labelFin, y: y + 3 }, end: { x: width - MARGE - numLargeur - 12, y: y + 3 },
      thickness: 0.7, color: GRIS_BORDURE, dashArray: [1.5, 3.5],
    });

    const pageCible = pdfDoc.getPage(section.pageDebut - 1);
    ajouterLienInterne(pdfDoc, toc, [MARGE - 6, y - 6, width - MARGE + 6, y + 14], pageCible);

    y -= 34;
    numero++;
  }

  // Numérotation centrée en bas de TOUTES les pages (couverture incluse,
  // comme le modèle).
  const nbPages = pdfDoc.getPageCount();
  for (let i = 0; i < nbPages; i++) {
    const page = pdfDoc.getPage(i);
    const { width: w } = page.getSize();
    const texte = String(i + 1);
    const largeur = fonts.font.widthOfTextAtSize(texte, 9);
    page.drawText(texte, { x: w / 2 - largeur / 2, y: 26, size: 9, font: fonts.font, color: GRIS_SOUS_TITRE });
  }
}

module.exports = {
  preparerPolices,
  nettoyerWinAnsi,
  couperLignes,
  dessinerEnTete,
  dessinerCouverture,
  dessinerSectionRedigee,
  dessinerPageSeparatrice,
  construireSommaireEtNumeroter,
};
