const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const TMP_DIR = path.join(__dirname, '..', '..', 'uploads');

// Convertit le .docx REMPLI (sortie de remplirBordereau, contenu réel inchangé)
// en PDF via LibreOffice headless. Rendu fidèle au template Word (logo, tableaux,
// mise en page identiques) car c'est le vrai moteur de rendu Word-compatible,
// contrairement à une recréation/réinterprétation du contenu.
function convertirDocxEnPdf(docxBuffer) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(TMP_DIR, `lo_${id}`);
    const docxPath = path.join(workDir, 'bordereau.docx');
    const pdfPath = path.join(workDir, 'bordereau.pdf');
    const profileDir = path.join(workDir, 'profile');

    const nettoyer = () => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    };

    try {
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(docxPath, docxBuffer);
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
      '--convert-to', 'pdf',
      '--outdir', workDir,
      docxPath,
    ];

    execFile('soffice', args, { timeout: 30000 }, (err) => {
      if (err) {
        nettoyer();
        return reject(new Error('Conversion LibreOffice échouée: ' + err.message));
      }
      try {
        if (!fs.existsSync(pdfPath)) {
          throw new Error('LibreOffice n\'a pas produit de PDF');
        }
        const buf = fs.readFileSync(pdfPath);
        nettoyer();
        resolve(buf);
      } catch (e) {
        nettoyer();
        reject(e);
      }
    });
  });
}

module.exports = { convertirDocxEnPdf };
