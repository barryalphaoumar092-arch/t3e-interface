const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');

const TMP_DIR = os.tmpdir();

// Convertit le .docx REMPLI (sortie de remplirBordereau, contenu réel inchangé)
// en PDF via LibreOffice headless. Rendu fidèle au template Word (logo, tableaux,
// mise en page identiques) car c'est le vrai moteur de rendu Word-compatible,
// contrairement à une recréation/réinterprétation du contenu.
function convertirDocxEnPdfLocal(docxBuffer) {
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

// Vercel (serverless) n'a pas soffice : convertirDocxEnPdfLocal échoue toujours
// là-bas. Dans ce cas on délègue la même conversion à l'instance Render, qui a
// LibreOffice (voir Dockerfile) — c'est le même moteur, le même .docx, aucune
// recréation du contenu ou de la mise en page, juste exécuté ailleurs.
async function convertirDocxEnPdfDistant(docxBuffer) {
  const url = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!url || !secret) {
    throw new Error(`fallback distant non configuré (URL: ${url ? 'ok' : 'MANQUANTE'}, secret: ${secret ? 'ok' : 'MANQUANT'})`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/internal/convertir-docx-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-convert-secret': secret },
      body: docxBuffer,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const corps = await resp.text().catch(() => '');
      throw new Error(`service distant a répondu ${resp.status}: ${corps.slice(0, 200)}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

// Le message d'erreur final combine les deux tentatives (locale + distante) afin
// que la cause exacte soit visible partout où l'appelant journalise e.message,
// sans dépendre de l'accès aux logs d'une plateforme spécifique.
async function convertirDocxEnPdf(docxBuffer) {
  let erreurLocaleMsg;
  try {
    return await convertirDocxEnPdfLocal(docxBuffer);
  } catch (erreurLocale) {
    erreurLocaleMsg = erreurLocale.message;
  }
  try {
    return await convertirDocxEnPdfDistant(docxBuffer);
  } catch (erreurDistante) {
    throw new Error(`conversion locale échouée (${erreurLocaleMsg}) ; conversion distante échouée (${erreurDistante.message})`);
  }
}

module.exports = { convertirDocxEnPdf, convertirDocxEnPdfLocal };
