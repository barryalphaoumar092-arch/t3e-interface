const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');

// Couleur T3E (#C8102E), reprise du gabarit Word du manuel.
const ROUGE_T3E = rgb(0.784, 0.063, 0.180);
const GRIS_FONCE = rgb(0.2, 0.2, 0.2);
const GRIS_NUMERO = rgb(0.3, 0.3, 0.3);

async function preparerPolices(pdfDoc) {
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  return { font, fontBold };
}

// Ajoute toutes les pages d'un buffer PDF externe à la fin de pdfDocCible et
// retourne les objets Page ajoutés (dans l'ordre), pour permettre au caller
// de savoir combien de pages ont été ajoutées et/ou de les tamponner.
async function ajouterBufferAuDocument(pdfDocCible, buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pages = await pdfDocCible.copyPages(doc, doc.getPageIndices());
  const ajoutees = [];
  for (const p of pages) {
    pdfDocCible.addPage(p);
    ajoutees.push(p);
  }
  return ajoutees;
}

// Page de titre de section (style T3E : titre rouge + ligne), générée par
// code plutôt qu'éditée dans le .docx — évite toute dépendance à la mise en
// page Word pour des sections dont la présence varie d'un manuel à l'autre.
function creerPageTitre(pdfDoc, fonts, titre, taillePage) {
  const { width, height } = taillePage;
  const page = pdfDoc.addPage([width, height]);
  page.drawText(titre, { x: 72, y: height - 110, size: 20, font: fonts.fontBold, color: ROUGE_T3E });
  page.drawLine({
    start: { x: 72, y: height - 122 },
    end: { x: width - 72, y: height - 122 },
    thickness: 1,
    color: GRIS_FONCE,
  });
  return page;
}

// Tamponne visuellement "PLANS TEL QUE CONSTRUIT" sur chaque page fournie
// (coin supérieur droit, bandeau semi-opaque) — appliqué uniquement aux
// pages de la section Plans tels que construits (as-built).
function estamperPagesAsBuilt(fonts, pages, texte = 'PLANS TEL QUE CONSTRUIT') {
  for (const page of pages) {
    const { width, height } = page.getSize();
    const taille = Math.max(9, Math.min(15, width * 0.017));
    const largeurTexte = fonts.fontBold.widthOfTextAtSize(texte, taille);
    const marge = 14;
    const boxW = largeurTexte + 24;
    const boxH = taille + 16;
    const x = width - boxW - marge;
    const y = height - boxH - marge;
    page.drawRectangle({
      x, y, width: boxW, height: boxH,
      color: rgb(1, 1, 1),
      opacity: 0.8,
      borderColor: ROUGE_T3E,
      borderWidth: 1.5,
    });
    page.drawText(texte, {
      x: x + 12, y: y + 8, size: taille, font: fonts.fontBold, color: ROUGE_T3E,
    });
  }
}

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
  if (existants) {
    existants.push(linkRef);
  } else {
    page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([linkRef]));
  }
}

// Remplace la page 2 (sommaire statique issu du .docx, toujours à cet index
// fixe puisque rien de longueur variable ne le précède) par un sommaire
// reconstruit avec les VRAIS numéros de page (connus seulement après
// assemblage complet, les sections 1-5 ayant une longueur variable), des
// liens cliquables vers chaque section, puis numérote toutes les pages de
// contenu (page 3 à la fin).
//
// `sections` : tableau ordonné de { label: string, pageDebut: number (1-based) }
// — une entrée par section RÉELLEMENT présente (les sections vides ne
// doivent pas être incluses par le caller).
async function construireSommaireEtNumeroter(pdfDoc, sections) {
  const fonts = await preparerPolices(pdfDoc);
  const { width, height } = pdfDoc.getPage(0).getSize();

  pdfDoc.removePage(1);
  const toc = pdfDoc.insertPage(1, [width, height]);

  toc.drawText('Table des matières', {
    x: 72, y: height - 110, size: 22, font: fonts.fontBold, color: ROUGE_T3E,
  });
  toc.drawLine({
    start: { x: 72, y: height - 122 },
    end: { x: width - 72, y: height - 122 },
    thickness: 1,
    color: GRIS_FONCE,
  });

  let y = height - 165;
  const lineHeight = 30;
  let numero = 1;
  for (const section of sections) {
    const label = `${numero}.  ${section.label}`;
    toc.drawText(label, { x: 72, y, size: 12, font: fonts.font, color: rgb(0, 0, 0) });

    const numTexte = String(section.pageDebut);
    const numLargeur = fonts.font.widthOfTextAtSize(numTexte, 12);
    toc.drawText(numTexte, { x: width - 72 - numLargeur, y, size: 12, font: fonts.font, color: rgb(0, 0, 0) });

    const pageCible = pdfDoc.getPage(section.pageDebut - 1);
    ajouterLienInterne(pdfDoc, toc, [64, y - 6, width - 64, y + 16], pageCible);

    y -= lineHeight;
    numero++;
  }

  const nbPages = pdfDoc.getPageCount();
  for (let i = 2; i < nbPages; i++) {
    const page = pdfDoc.getPage(i);
    const { width: w } = page.getSize();
    const texte = String(i + 1);
    const largeur = fonts.font.widthOfTextAtSize(texte, 9);
    page.drawText(texte, { x: w / 2 - largeur / 2, y: 28, size: 9, font: fonts.font, color: GRIS_NUMERO });
  }
}

module.exports = {
  preparerPolices,
  ajouterBufferAuDocument,
  creerPageTitre,
  estamperPagesAsBuilt,
  construireSommaireEtNumeroter,
};
