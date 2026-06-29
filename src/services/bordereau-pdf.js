const PDFDocumentKit = require('pdfkit');

function creerBordereauPdf(champs) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocumentKit({ size: 'LETTER', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const c = champs;
    const W = 532; // largeur utile (letter - margins)

    // En-tête
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('IDENTIFICATION DE DESSINS D\'ATELIER', 40, 40, { align: 'center', width: W });
    doc.text('ÉCHANTILLONS ET FICHES TECHNIQUES', 40, 52, { align: 'center', width: W });
    doc.moveTo(40, 68).lineTo(40 + W, 68).stroke();

    // Projet
    doc.fontSize(8).font('Helvetica-Bold');
    const y1 = 75;
    doc.text('NOM DU PROJET :', 40, y1);
    doc.font('Helvetica').text(c.NOM_DU_PROJET || '', 160, y1, { width: 250 });
    doc.font('Helvetica-Bold').text('NUMÉRO DU PROJET :', 390, y1);
    doc.font('Helvetica').text(c.NUMERO_DU_PROJET || '', 510, y1);

    // Identification entrepreneur
    doc.moveTo(40, y1 + 18).lineTo(40 + W, y1 + 18).stroke();
    const y2 = y1 + 24;
    doc.font('Helvetica-Bold').fontSize(8).text('IDENTIFICATION DE L\'ENTREPRENEUR', 40, y2);

    const y3 = y2 + 14;
    doc.font('Helvetica-Bold').text('NOM :', 40, y3);
    doc.font('Helvetica').text(c.NOM || 'Toitures Trois Étoiles', 80, y3);
    doc.font('Helvetica-Bold').text('SPÉCIALITÉ :', 300, y3);
    doc.font('Helvetica').text(c.SPECIALITE || 'COUVREUR', 370, y3);

    const y4 = y3 + 14;
    doc.font('Helvetica-Bold').text('ADRESSE :', 40, y4);
    doc.font('Helvetica').text(c.ADRESSE || '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1', 100, y4, { width: 450 });

    // Identification produit
    doc.moveTo(40, y4 + 20).lineTo(40 + W, y4 + 20).stroke();
    const y5 = y4 + 26;
    doc.font('Helvetica-Bold').text('IDENTIFICATION', 40, y5);

    // Case Fiche technique cochée
    const y6 = y5 + 16;
    doc.font('Helvetica').fontSize(8);
    doc.text('Dessin d\'atelier          ☐', 40, y6);
    doc.text('Échantillon                ☐', 200, y6);
    doc.text('Fiche technique          ☒', 380, y6);

    // Champs produit
    const startY = y6 + 22;
    const lignes = [
      ['Titre :', c.TITRE || ''],
      ['Numéro de dessins :', ''],
      ['Nombre feuilles :', ''],
      ['Révision :', ''],
      ['Description :', ''],
      ['Fournisseur :', c.FOURNISSEUR || ''],
      ['Fabricant :', c.FABRICANT || ''],
    ];

    let yy = startY;
    for (const [label, val] of lignes) {
      doc.moveTo(40, yy).lineTo(40 + W, yy).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(8).text(label, 45, yy + 3);
      doc.font('Helvetica').text(val, 160, yy + 3, { width: 400 });
      yy += 18;
    }

    // Cases spéciales
    doc.moveTo(40, yy).lineTo(40 + W, yy).lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(8);
    doc.text('Tel que plans et devis  ☒', 45, yy + 3);
    doc.text('Équivalence              ☐', 300, yy + 3);
    yy += 18;

    // Section / Article
    doc.moveTo(40, yy).lineTo(40 + W, yy).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').text('Section (item) :', 45, yy + 3);
    doc.font('Helvetica').text(c.SECTION || '', 160, yy + 3, { width: 400 });
    yy += 18;

    doc.moveTo(40, yy).lineTo(40 + W, yy).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').text('Article :', 45, yy + 3);
    doc.font('Helvetica').text(c.ARTICLE || '', 160, yy + 3, { width: 400 });
    yy += 18;

    doc.moveTo(40, yy).lineTo(40 + W, yy).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').text('Délai :', 45, yy + 3);
    yy += 18;

    // Remarque
    doc.moveTo(40, yy).lineTo(40 + W, yy).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').text('Remarque :', 45, yy + 3);
    doc.font('Helvetica').text(c.REMARQUE || '', 120, yy + 3, { width: 440 });
    yy += 40;

    doc.moveTo(40, yy).lineTo(40 + W, yy).lineWidth(0.5).stroke();

    // Signatures
    yy += 20;
    doc.font('Helvetica-Bold').fontSize(7).text('SOUMIS PAR :', 40, yy);
    doc.text('ÉMIS PAR :', 350, yy);
    yy += 30;
    doc.moveTo(40, yy).lineTo(230, yy).stroke();
    doc.moveTo(350, yy).lineTo(540, yy).stroke();
    yy += 4;
    doc.font('Helvetica').fontSize(7);
    doc.text('Signature de Toitures Trois Étoiles', 40, yy);
    doc.text('Signature de l\'entrepreneur', 350, yy);

    doc.end();
  });
}

module.exports = { creerBordereauPdf };
