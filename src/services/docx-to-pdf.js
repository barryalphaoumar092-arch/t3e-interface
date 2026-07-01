const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const TMP_DIR = path.join(__dirname, '..', '..', 'uploads');

// Ordre de recherche du binaire LibreOffice selon l'environnement
const SOFFICE_PATHS = [
  'soffice',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice.bin',
  'libreoffice',
];

function convertirViaLibreOffice(inputBuffer, formatEntree, formatSortie) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(TMP_DIR, `lo_${id}`);
    const inputPath = path.join(workDir, `doc.${formatEntree}`);
    const outputPath = path.join(workDir, `doc.${formatSortie}`);
    const profileDir = path.join(workDir, 'profile');

    const nettoyer = () => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    };

    try {
      // Pré-créer le profileDir : LibreOffice peut échouer s'il ne peut pas l'initialiser
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(inputPath, inputBuffer);
    } catch (e) {
      nettoyer();
      return reject(e);
    }

    // -env:UserInstallation isole le profil LibreOffice par conversion pour
    // éviter les conflits de verrou entre appels successifs/concurrents
    const args = [
      '--headless',
      '--norestore',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', formatSortie,
      '--outdir', workDir,
      inputPath,
    ];

    // HOME nécessaire pour que LibreOffice puisse écrire ses fichiers temporaires
    const env = Object.assign({}, process.env, { HOME: process.env.HOME || '/tmp' });

    let tentative = 0;

    function essayer() {
      if (tentative >= SOFFICE_PATHS.length) {
        nettoyer();
        return reject(new Error(
          `soffice introuvable — essayé: ${SOFFICE_PATHS.join(', ')}`
        ));
      }

      const cmd = SOFFICE_PATHS[tentative++];

      execFile(cmd, args, { timeout: 90000, env }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return essayer();
          nettoyer();
          return reject(new Error(
            `LibreOffice ${formatEntree}→${formatSortie} échoué [${cmd}]: ${err.message}` +
            (stderr ? `\nstderr: ${stderr.substring(0, 600)}` : '') +
            (stdout ? `\nstdout: ${stdout.substring(0, 300)}` : '')
          ));
        }
        try {
          if (!fs.existsSync(outputPath)) {
            throw new Error(
              `LibreOffice n'a pas produit de .${formatSortie}` +
              (stderr ? `\nstderr: ${stderr.substring(0, 600)}` : '') +
              (stdout ? `\nstdout: ${stdout.substring(0, 300)}` : '')
            );
          }
          const buf = fs.readFileSync(outputPath);
          nettoyer();
          resolve(buf);
        } catch (e) {
          nettoyer();
          reject(e);
        }
      });
    }

    essayer();
  });
}

function convertirDocxEnPdf(docxBuffer) {
  return convertirViaLibreOffice(docxBuffer, 'docx', 'pdf');
}

function convertirPdfEnDocx(pdfBuffer) {
  return convertirViaLibreOffice(pdfBuffer, 'pdf', 'docx');
}

module.exports = { convertirDocxEnPdf, convertirPdfEnDocx };
