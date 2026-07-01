const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const TMP_DIR = path.join(__dirname, '..', '..', 'uploads');

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
      fs.mkdirSync(workDir, { recursive: true });
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

    execFile('soffice', args, { timeout: 30000 }, (err) => {
      if (err) {
        nettoyer();
        return reject(new Error(`LibreOffice ${formatEntree}→${formatSortie} échoué: ${err.message}`));
      }
      try {
        if (!fs.existsSync(outputPath)) {
          throw new Error(`LibreOffice n'a pas produit de .${formatSortie}`);
        }
        const buf = fs.readFileSync(outputPath);
        nettoyer();
        resolve(buf);
      } catch (e) {
        nettoyer();
        reject(e);
      }
    });
  });
}

function convertirDocxEnPdf(docxBuffer) {
  return convertirViaLibreOffice(docxBuffer, 'docx', 'pdf');
}

function convertirPdfEnDocx(pdfBuffer) {
  return convertirViaLibreOffice(pdfBuffer, 'pdf', 'docx');
}

module.exports = { convertirDocxEnPdf, convertirPdfEnDocx };
