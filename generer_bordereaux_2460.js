/**
 * Génération automatique des bordereaux pour projet 2460 - APCHQ
 * Devis: 2460_20260401_A_devis_soumission.pdf
 * 9 matériaux — Section 07 52 00 — Couverture à membrane élastomère
 *
 * Étapes :
 * 1. Remplir chaque bordereau .docx (bordereau-filler.js)
 * 2. Convertir .docx → PDF via Word COM (PowerShell)
 * 3. Fusionner bordereau PDF + fiche technique PDF (pdf-lib)
 * 4. Sauvegarder dans C:\Users\Projets\Bordereaux_2460\
 */

const { remplirBordereau } = require('./src/services/bordereau-filler');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// === CONFIGURATION ===
const FT_DIR = path.join(__dirname, 'documents', 'FT', 'Soprema');
const TEMP_DIR = path.join(__dirname, '_tmp_bordereaux');
const OUTPUT_DIR = 'C:\\Users\\Projets\\Bordereaux_2460';

// Champs fixes T3E
const CHAMPS_FIXES = {
  NOM: 'Toitures Trois Étoiles',
  SPECIALITE: 'COUVREUR',
  ADRESSE: '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
};

// Champs projet extraits du devis 2460
const PROJET = {
  NOM_DU_PROJET: 'APCHQ RÉGION MAURICIE-LANAUDIÈRE — AGRANDISSEMENT BÂTIMENT EXISTANT',
  NUMERO_DU_PROJET: '2460',
};

// === 9 MATÉRIAUX ===
const MATERIAUX = [
  {
    slug: '01_Densdeck',
    TITRE: 'Densdeck 12.5mm',
    FABRICANT: 'Georgia Pacific',
    FOURNISSEUR: 'Soprema / Roofmart',
    SECTION: '07 52 00',
    ARTICLE: '2.1',
    DESCRIPTION: 'Panneau de gypse type extérieur, mat de fibre de verre incombustible, âme résistante à l\'humidité. 12.5mm.',
    REMARQUE: '',
    ftFile: null,
  },
  {
    slug: '02_Elastocol_Stick',
    TITRE: 'Elastocol Stick',
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.2',
    DESCRIPTION: 'Apprêt SBS à base de caoutchouc synthétique. Appliquer avant la pose de membranes autocollantes.',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-elastocol-stick.pdf'),
  },
  {
    slug: '03_Sopravap_r',
    TITRE: "Sopravap'R",
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.3',
    DESCRIPTION: 'Coupe-vapeur autocollant bitume SBS. Résistance vapeur : 0.016 perm. Grille polyéthylène haute densité.',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-sopravapr.pdf'),
  },
  {
    slug: '04_Duotack',
    TITRE: 'Duotack',
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.4',
    DESCRIPTION: 'Adhésif 2 composants polyuréthane à faible expansion. Collage isolants, panneaux de recouvrement et barrières thermiques.',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-duotack.pdf'),
  },
  {
    slug: '05_Sopra_Iso_Plus',
    TITRE: 'Sopra-Iso Plus',
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.5',
    DESCRIPTION: 'Isolant polyisocyanurate alvéolaire fermé, revêtement fibres de verre. Panneaux 1220x1220mm. CAN/ULC-S701-97. Collé à l\'adhésif.',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-sopra-iso-plus.pdf'),
  },
  {
    slug: '06_Sopra_Iso_Plus_Pente',
    TITRE: 'Sopra-Iso Plus Pente',
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.6',
    DESCRIPTION: 'Isolant polyisocyanurate en pente (1% ou 2%). Panneaux 1220x1220mm. Épaisseur min. au drain : 13mm. Collé à l\'adhésif.',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-sopra-iso-tapered.pdf'),
  },
  {
    slug: '07_Soprasmart_ISO_HD',
    TITRE: '2-1 Soprasmart ISO HD',
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.7',
    DESCRIPTION: 'Membrane SBS + voile de verre laminée sur panneau fibre de roche 13mm. Format 0.91x2.59m. Film thermo-soudable. Collé à l\'adhésif.',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-2-1-soprasmart-iso-hd.pdf'),
  },
  {
    slug: '08_Sopralene_Flam_250GR',
    TITRE: 'Sopralene Flam 250 GR',
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.8',
    DESCRIPTION: 'Couche de finition, armature polyester 250g/m². Granules colorés en surface. Soudage au chalumeau. Couleur : gris pâle (blanc vestibule 113).',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-sopralene-flam-250-gr.pdf'),
  },
  {
    slug: '09_Sopraply_Flam_Stick',
    TITRE: 'Sopraply Flam Stick',
    FABRICANT: 'Soprema',
    FOURNISSEUR: 'Soprema',
    SECTION: '07 52 00',
    ARTICLE: '2.9',
    DESCRIPTION: 'Sous-couche autocollante 2.5mm avec apprêt. Sur remontées de parapet seulement.',
    REMARQUE: '',
    ftFile: path.join(FT_DIR, 'sopca-fr-ca-tds-sopraply-flam-stick.pdf'),
  },
];

// === HELPER: convertir .docx → .pdf via Word COM (script .ps1 temporaire) ===
function convertDocxToPdf(docxPath, pdfPath) {
  const absDocx = path.resolve(docxPath).replace(/\\/g, '\\\\');
  const absPdf  = path.resolve(pdfPath).replace(/\\/g, '\\\\');
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    '$word = New-Object -ComObject Word.Application',
    '$word.Visible = $false',
    '$word.DisplayAlerts = 0',
    `$doc = $word.Documents.Open("${absDocx}")`,
    `$doc.SaveAs2("${absPdf}", 17)`,
    '$doc.Close($false)',
    '$word.Quit()',
    '[System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null',
    'Write-Host "CONVERSION_OK"',
  ].join('\r\n');

  const ps1Path = path.join(TEMP_DIR, `_convert_${Date.now()}.ps1`);
  fs.writeFileSync(ps1Path, psScript, 'utf8');

  try {
    const result = execSync(
      `powershell -NonInteractive -ExecutionPolicy Bypass -File "${ps1Path}"`,
      { timeout: 60000, encoding: 'utf8' }
    );
    if (!result.includes('CONVERSION_OK')) {
      throw new Error(`Word COM: résultat inattendu — ${result.trim()}`);
    }
  } finally {
    try { fs.unlinkSync(ps1Path); } catch {}
  }
}

// === HELPER: fusionner PDFs avec pdf-lib ===
async function fusionnerPdfs(pdfPaths, outputPath) {
  const merged = await PDFDocument.create();
  for (const pdfPath of pdfPaths) {
    if (!fs.existsSync(pdfPath)) {
      console.log(`  ⚠  PDF non trouvé, ignoré : ${path.basename(pdfPath)}`);
      continue;
    }
    const buf = fs.readFileSync(pdfPath);
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  const bytes = await merged.save();
  fs.writeFileSync(outputPath, bytes);
}

// === MAIN ===
async function main() {
  // Créer les dossiers
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`GÉNÉRATION BORDEREAUX — PROJET 2460 — APCHQ`);
  console.log(`Section 07 52 00 — Couverture à membrane élastomère`);
  console.log(`${'='.repeat(60)}\n`);

  const rapport = [];

  for (const mat of MATERIAUX) {
    console.log(`\n▶ [${mat.slug}] ${mat.TITRE}`);

    try {
      // 1. Remplir le bordereau .docx
      const champs = {
        ...CHAMPS_FIXES,
        ...PROJET,
        TITRE: mat.TITRE,
        FABRICANT: mat.FABRICANT,
        FOURNISSEUR: mat.FOURNISSEUR,
        SECTION: mat.SECTION,
        ARTICLE: mat.ARTICLE,
        DESCRIPTION: mat.DESCRIPTION,
        REMARQUE: mat.REMARQUE,
      };
      const docxBuf = await remplirBordereau(champs);
      const docxPath = path.join(TEMP_DIR, `${mat.slug}.docx`);
      fs.writeFileSync(docxPath, docxBuf);
      console.log(`  ✓ Bordereau .docx rempli`);

      // 2. Convertir .docx → PDF via Word COM
      const bordereauPdfPath = path.join(TEMP_DIR, `${mat.slug}_bordereau.pdf`);
      convertDocxToPdf(docxPath, bordereauPdfPath);
      console.log(`  ✓ Converti en PDF`);

      // 3. Fusionner bordereau PDF + FT PDF
      const pdfsToBeMerged = [bordereauPdfPath];
      let hasFT = false;
      if (mat.ftFile && fs.existsSync(mat.ftFile)) {
        pdfsToBeMerged.push(mat.ftFile);
        hasFT = true;
        console.log(`  ✓ Fiche technique trouvée : ${path.basename(mat.ftFile)}`);
      } else {
        console.log(`  ⚠  Aucune fiche technique dans la base — bordereau seul`);
      }

      const outputPdfPath = path.join(OUTPUT_DIR, `Bordereau_${mat.slug}.pdf`);
      await fusionnerPdfs(pdfsToBeMerged, outputPdfPath);
      console.log(`  ✓ PDF final : ${outputPdfPath}`);

      rapport.push({ materiau: mat.TITRE, statut: 'OK', ft: hasFT ? path.basename(mat.ftFile) : 'AUCUNE', fichier: `Bordereau_${mat.slug}.pdf` });
    } catch (err) {
      console.error(`  ✗ ERREUR : ${err.message}`);
      rapport.push({ materiau: mat.TITRE, statut: `ERREUR: ${err.message}`, ft: '-', fichier: '-' });
    }
  }

  // Rapport final
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RAPPORT FINAL`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Dossier de sortie : ${OUTPUT_DIR}\n`);
  rapport.forEach((r, i) => {
    const icon = r.statut === 'OK' ? '✓' : '✗';
    console.log(`${icon} [${i+1}] ${r.materiau}`);
    if (r.statut === 'OK') {
      console.log(`    Fichier : ${r.fichier}`);
      console.log(`    FT      : ${r.ft}`);
    } else {
      console.log(`    ${r.statut}`);
    }
  });
  console.log(`\nTotal : ${rapport.filter(r=>r.statut==='OK').length}/${rapport.length} réussis`);

  // Nettoyage temp
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  console.log(`\nFichiers temporaires supprimés.`);
}

main().catch(e => {
  console.error('Erreur fatale:', e);
  process.exit(1);
});
