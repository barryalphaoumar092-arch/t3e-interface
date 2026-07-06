// Génère documents/manuel-template.docx (librairie "docx", devDependency),
// avec la convention "LIBELLÉ :" utilisée par bordereau-template.docx —
// remplirManuel() (src/services/manuel-filler.js) réutilise le même moteur
// de remplissage (src/services/docx-xml-utils.js).
//
// À relancer si le contenu/la mise en page du template doit changer :
//   node scripts/generer-manuel-template.js
// puis uploader documents/manuel-template.docx dans le bucket Supabase
// "documents" (page Connaissances du site, ou script d'upload direct).
//
// IMPORTANT : ne PAS utiliser `styles.paragraphStyles` avec des id "Title"/
// "Heading1"/"Heading2" — la librairie "docx" (v9.7.1) DUPLIQUE alors la
// definition de style (l'entrée par défaut de la librairie ET la nôtre
// coexistent dans styles.xml avec le même w:styleId), ce qui rend le rendu
// incohérent selon le moteur (Word vs LibreOffice). Le formatage des titres
// est donc appliqué directement sur chaque paragraphe (TextRun + bordure),
// jamais via un style nommé.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, PageBreak, ImageRun,
  Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, VerticalAlign,
} = require('docx');

const RACINE = path.join(__dirname, '..');

const ROUGE_T3E = 'C8102E';
const GRIS_T3E = '6D6E71';
const NBSP = ' ';
const BORDURE_H1 = { bottom: { color: ROUGE_T3E, space: 4, style: BorderStyle.SINGLE, size: 8 } };

function labelRun(text, opts = {}) {
  return new TextRun({ text: text + NBSP + ':', bold: true, ...opts });
}
function labelPara(text, opts = {}) {
  return new Paragraph({ children: [labelRun(text)], spacing: { before: 200, after: 100 }, ...opts });
}
// Titre de section numéroté (ex: "1. Liste des intervenants") — rouge, gras, bordure inférieure
function titre(numero, text) {
  return new Paragraph({
    children: [new TextRun({ text: `${numero}. ${text}`, bold: true, color: ROUGE_T3E, size: 30 })],
    spacing: { before: 300, after: 220 },
    border: BORDURE_H1,
  });
}
// Titre de niveau 1 sans numéro (page de couverture, table des matières)
function titreH1(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, color: ROUGE_T3E, size: 30 })],
    spacing: { before: 200, after: 300 },
    border: BORDURE_H1,
    ...opts,
  });
}
// Sous-titre (gris)
function sousTitre(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, color: GRIS_T3E, size: 24 })],
    spacing: { before: 200, after: 150 },
    ...opts,
  });
}
function texte(text, opts = {}) {
  return new Paragraph({ children: [new TextRun(text)], spacing: { after: 150 }, ...opts });
}

const CHECKLIST_ITEMS = [
  'Inspection de tous les éléments émergeant de la membrane de toiture (évents, ventilateurs, cheminées, etc.).',
  'Vérification de tous les drains.',
  'Vérification de la condition générale de la couverture (débris, clous, feuilles, saletés, sédiments et autres matériaux).',
  'Inspection de la membrane et de tous ses joints. S’assurer que la membrane est toujours utilisée pour l’usage pour lequel elle a été conçue (éviter : entreposage, tables de pique-nique, chaises, décorations).',
  'Vérification de l’étanchéité de tous les solins métalliques, si applicable.',
  'Vérification de la présence de granules en quantité suffisante sur toute la surface de la membrane.',
  'Communication aux personnes concernées de toute anomalie des éléments environnants et des éléments reliés à la couverture (murs de maçonnerie, sorties mécaniques, lanterneaux, etc.).',
  'Vérification des équipements mécaniques installés sur la toiture (supports, fixations, étanchéité des pénétrations).',
  'Anomalie(s) ou autre(s) problème(s) observé(s).',
];

function celluleTexte(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, size: 18, ...opts })] })],
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}
function celluleCommentaire(numero) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: `Commentaire ${numero}${NBSP}:`, size: 16 })] })],
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}
function ligneChecklist(texteItem, numero) {
  return new TableRow({
    children: [
      celluleTexte(texteItem, { size: 16 }),
      celluleTexte('☐', { size: 20 }),
      celluleTexte('☐', { size: 20 }),
      celluleCommentaire(numero),
    ],
  });
}
function celluleEntete(text) {
  return new TableCell({
    shading: { fill: GRIS_T3E },
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 18 })] })],
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}
const entetesChecklist = new TableRow({
  tableHeader: true,
  children: [
    celluleEntete('Point de vérification'),
    celluleEntete('OK'),
    celluleEntete('Suivi requis'),
    celluleEntete('Commentaire'),
  ],
});

const tableChecklist = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  columnWidths: [5500, 900, 1400, 2200],
  rows: [entetesChecklist, ...CHECKLIST_ITEMS.map((t, i) => ligneChecklist(t, i + 1))],
});

// ── Table des matières (sommaire statique — pas de numéros de page dynamiques,
//    ceux-ci ne se recalculent pas de façon fiable lors d'une conversion PDF
//    automatisée/headless, contrairement à Word ouvert manuellement) ──
const SOMMAIRE = [
  'Liste des intervenants',
  'Liste des fournisseurs et sous-traitants',
  'Description des travaux exécutés',
  'Détails et imprévus',
  "Directives d'exploitation et d'entretien",
  'Garanties',
  "Manuel d'entretien préventif",
  'Attestation de conformité CNESST',
  'Attestation de conformité CCQ',
  "Dessins d'atelier",
  'Fiches techniques',
  'Plans tels que construits (as-built)',
];

function lignesSommaire() {
  return SOMMAIRE.map((titreSection, i) => new Paragraph({
    children: [new TextRun({ text: `${i + 1}.  ${titreSection}` })],
    spacing: { after: 160 },
  }));
}

const logoBuffer = fs.readFileSync(path.join(RACINE, 'documents/assets/t3e-logo.jpg'));

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 22 } },
    },
  },
  sections: [{
    properties: {},
    children: [
      // ── PAGE 1 — COUVERTURE ──
      new Paragraph({
        children: [new ImageRun({ type: 'jpg', data: logoBuffer, transformation: { width: 110, height: 110 } })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 600, after: 400 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'MANUEL DE FIN DE CHANTIER', bold: true, color: ROUGE_T3E, size: 44 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
      new Paragraph({ children: [new TextRun({ text: 'Toitures Trois Étoiles Inc.', color: GRIS_T3E, italics: true })], alignment: AlignmentType.CENTER, spacing: { after: 600 } }),
      new Paragraph({ children: [labelRun('NOM DU PROJET')], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
      new Paragraph({ children: [labelRun('CLIENT')], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
      new Paragraph({ children: [labelRun('ADRESSE DU PROJET')], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
      new Paragraph({ children: [labelRun('NUMÉRO DE DOSSIER TTE')], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
      new Paragraph({ children: [labelRun('DATE')], alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
      new Paragraph({ children: [new PageBreak()] }),

      // ── TABLE DES MATIÈRES ──
      titreH1('Table des matières'),
      ...lignesSommaire(),
      new Paragraph({ children: [new PageBreak()] }),

      // ── 1. LISTE DES INTERVENANTS ──
      titre(1, 'Liste des intervenants'),
      sousTitre('Propriétaire'),
      labelPara('Propriétaire'),
      sousTitre('Consultant'),
      labelPara('Consultant'),
      sousTitre('Entrepreneur général'),
      labelPara('Entrepreneur général'),
      sousTitre('Entrepreneur couvreur'),
      labelPara('Entrepreneur couvreur'),
      new Paragraph({ children: [new PageBreak()] }),

      // ── 2. FOURNISSEURS ET SOUS-TRAITANTS ──
      titre(2, 'Liste des fournisseurs et sous-traitants'),
      sousTitre('Fournisseurs'),
      labelPara('Fournisseur 1'),
      labelPara('Fournisseur 2'),
      labelPara('Fournisseur 3'),
      labelPara('Fournisseur 4'),
      sousTitre('Sous-traitants'),
      labelPara('Sous-traitant 1'),
      labelPara('Sous-traitant 2'),
      new Paragraph({ children: [new PageBreak()] }),

      // ── 3. DESCRIPTION DES TRAVAUX ──
      titre(3, 'Description des travaux exécutés'),
      texte('Composition complète de la toiture installée, telle que décrite au devis (coupe-vapeur, isolant et épaisseur/pente, panneaux de support, membrane(s), relevés, solins, etc.) :', { spacing: { after: 200 } }),
      labelPara('Description'),
      new Paragraph({ children: [new PageBreak()] }),

      // ── 4. DÉTAILS ET IMPRÉVUS ──
      titre(4, 'Détails et imprévus'),
      texte('Précisions, particularités ou événements imprévus survenus en cours de chantier, le cas échéant :'),
      labelPara('Détails'),
      new Paragraph({ children: [new PageBreak()] }),

      // ── 5. DIRECTIVES D'ENTRETIEN + CHECKLIST ──
      titre(5, "Directives d'exploitation et d'entretien"),
      texte('Les inspections préventives devraient être réalisées au moins deux fois par année, à l’automne et à la fin de l’hiver. Il est également recommandé de le faire à la suite d’événements climatiques majeurs (pluies abondantes, verglas, grands vents) ainsi qu’après toute installation ou tout travaux d’entretien d’appareils (climatisation, ventilation) sur la toiture.'),
      texte('Limitez l’accès au personnel autorisé uniquement. N’utilisez pas la toiture comme terrasse ou patio sans protection adéquate.'),
      sousTitre('Liste de contrôle d’entretien', { spacing: { before: 300, after: 150 } }),
      tableChecklist,
      new Paragraph({ children: [new PageBreak()] }),

      // ── 6. GARANTIES ──
      titre(6, 'Garanties'),
      sousTitre('Certificat de garantie — Toitures Trois Étoiles Inc.'),
      new Paragraph({ children: [labelRun('Numéro de garantie')], spacing: { after: 150 } }),
      new Paragraph({ children: [labelRun('Surface garantie')], spacing: { after: 150 } }),
      new Paragraph({ children: [labelRun('Durée de la garantie')], spacing: { after: 150 } }),
      new Paragraph({ children: [labelRun('Date de fin de garantie')], spacing: { after: 300 } }),
      texte('Cette garantie couvre les défauts de matériaux et de main-d’œuvre relatifs aux travaux de couverture décrits au présent document, pour la durée indiquée ci-dessus à compter de la date de fin des travaux. Elle s’annule automatiquement en cas de modifications, réparations ou ouvertures non autorisées apportées à la toiture, au pontage ou à l’entretoit sans approbation écrite préalable de Toitures Trois Étoiles Inc.'),
      texte('La responsabilité financière en vertu de la présente garantie est limitée au coût des travaux de couverture prévu au contrat original. Cette garantie n’est ni négociable ni transférable sans le consentement écrit de Toitures Trois Étoiles Inc.'),
      texte('[NOTE INTERNE T3E : ce texte est un gabarit générique — à faire valider par la direction avant usage officiel, notamment au regard du libellé légal habituel de T3E.]', { spacing: { before: 200 } }),
      texte('La garantie du fabricant des matériaux, lorsqu’applicable, est jointe en annexe du présent manuel (voir section Garantie fabricant).'),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  const outPath = path.join(RACINE, 'documents/manuel-template.docx');
  fs.writeFileSync(outPath, buf);
  console.log('OK - manuel-template.docx généré,', buf.length, 'octets ->', outPath);
}).catch(e => { console.error('ERREUR génération:', e); process.exit(1); });
