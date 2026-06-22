const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const FIELD_MAP = [
  { label: 'NOM DU PROJET', field: 'client', xOffset: 160, fontSize: 10 },
  { label: 'NUMÉRO DU PROJET', field: 'numero', xOffset: 180, fontSize: 10 },
  { label: 'NOM :', field: '_entrepreneur', xOffset: 50, fontSize: 9, value: 'Toitures Trois Étoiles' },
  { label: 'SPÉCIALITÉ', field: '_specialite', xOffset: 100, fontSize: 9, value: 'Couvreur' },
  { label: 'ADRESSE :', field: 'adresse', xOffset: 80, fontSize: 9 },
  { label: 'Titre :', field: '_titre_mat', xOffset: 55, fontSize: 9 },
  { label: 'Description :', field: '_description', xOffset: 90, fontSize: 9 },
  { label: 'Fournisseur :', field: '_fournisseur', xOffset: 95, fontSize: 9 },
  { label: 'Fabricant :', field: '_fabricant', xOffset: 75, fontSize: 9 },
];

async function fillTemplatePdf(templateBuffer, projet, materiaux) {
  const pdfDoc = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Essayer de remplir les champs de formulaire PDF si ils existent
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    if (fields.length > 0) {
      for (const field of fields) {
        const name = field.getName().toLowerCase();
        if (name.includes('projet') && name.includes('nom')) field.setText(projet.client || '');
        else if (name.includes('projet') && name.includes('num')) field.setText(projet.numero || '');
        else if (name.includes('adresse')) field.setText(projet.adresse || '');
        else if (name.includes('architecte')) field.setText(projet.architecte || '');
      }
      form.flatten();
      return pdfDoc;
    }
  } catch (e) { }

  // Sinon, superposer du texte sur les pages existantes
  const pages = pdfDoc.getPages();
  if (pages.length === 0) return pdfDoc;

  const firstPage = pages[0];
  const { height } = firstPage.getSize();

  // Extraire le texte pour trouver les positions des labels
  // On utilise des positions estimées basées sur le template T3E standard
  const mat = materiaux && materiaux.length > 0 ? materiaux[0] : null;

  const data = {
    client: projet.client || '',
    numero: projet.numero || '',
    adresse: projet.adresse || '',
    architecte: projet.architecte || '',
    _entrepreneur: 'Toitures Trois Étoiles',
    _specialite: 'Couvreur',
    _titre_mat: mat ? mat.nom : '',
    _description: mat ? [mat.type_produit, mat.type_systeme, mat.dimension].filter(Boolean).join(' — ') : '',
    _fournisseur: mat ? mat.fabricant : '',
    _fabricant: mat ? mat.fabricant : '',
  };

  // Positions Y approximatives pour le bordereau T3E standard (LETTER, du haut)
  // PDF coordinates: y=0 en bas, y=792 en haut
  const fieldPositions = [
    { field: 'numero', x: 230, y: height - 125, size: 10 },
    { field: 'client', x: 230, y: height - 105, size: 10 },
    { field: '_entrepreneur', x: 130, y: height - 185, size: 9 },
    { field: '_specialite', x: 130, y: height - 205, size: 9 },
    { field: 'adresse', x: 130, y: height - 225, size: 9 },
    { field: '_titre_mat', x: 130, y: height - 340, size: 9 },
    { field: '_description', x: 130, y: height - 380, size: 9 },
    { field: '_fournisseur', x: 130, y: height - 400, size: 9 },
    { field: '_fabricant', x: 350, y: height - 400, size: 9 },
  ];

  for (const pos of fieldPositions) {
    const val = data[pos.field];
    if (val) {
      firstPage.drawText(val, {
        x: pos.x,
        y: pos.y,
        size: pos.size || 9,
        font: font,
        color: rgb(0, 0, 0.6),
      });
    }
  }

  // S'il y a plusieurs matériaux, les lister sur les pages suivantes
  if (materiaux && materiaux.length > 1 && pages.length > 0) {
    for (let i = 1; i < materiaux.length && i < pages.length; i++) {
      const m = materiaux[i];
      const page = pages[i] || pages[0];
      const ph = page.getSize().height;
      const mData = [
        { field: m.nom, x: 130, y: ph - 340 },
        { field: [m.type_produit, m.type_systeme, m.dimension].filter(Boolean).join(' — '), x: 130, y: ph - 380 },
        { field: m.fabricant, x: 130, y: ph - 400 },
        { field: m.fabricant, x: 350, y: ph - 400 },
      ];
      for (const md of mData) {
        if (md.field) {
          page.drawText(md.field, { x: md.x, y: md.y, size: 9, font, color: rgb(0, 0, 0.6) });
        }
      }
    }
  }

  return pdfDoc;
}

module.exports = { fillTemplatePdf };
