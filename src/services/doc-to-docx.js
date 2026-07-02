const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');

const TMP_DIR = os.tmpdir();

// Certains gabarits d'architectes sont encore envoyés en .doc (format binaire
// OLE, Word 97-2003) plutôt qu'en .docx (zip OOXML). bordereau-filler.js ne
// sait lire que du .docx (JSZip sur word/document.xml) : sans cette
// conversion préalable, un .doc produit un bordereau silencieusement vide
// (JSZip ne trouve pas word/document.xml, l'erreur est avalée plus haut).
// Même mécanisme que convertirDocxEnPdfLocal : LibreOffice headless.
function convertirDocEnDocxLocal(docBuffer) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(TMP_DIR, `lo_doc_${id}`);
    const docPath = path.join(workDir, 'bordereau.doc');
    const docxPath = path.join(workDir, 'bordereau.docx');
    const profileDir = path.join(workDir, 'profile');

    const nettoyer = () => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    };

    try {
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(docPath, docBuffer);
    } catch (e) {
      nettoyer();
      return reject(e);
    }

    const args = [
      '--headless',
      '--norestore',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'docx',
      '--outdir', workDir,
      docPath,
    ];

    execFile('soffice', args, { timeout: 30000 }, (err) => {
      if (err) {
        nettoyer();
        return reject(new Error('Conversion LibreOffice (.doc → .docx) échouée: ' + err.message));
      }
      try {
        if (!fs.existsSync(docxPath)) {
          throw new Error('LibreOffice n\'a pas produit de .docx');
        }
        const buf = fs.readFileSync(docxPath);
        nettoyer();
        resolve(buf);
      } catch (e) {
        nettoyer();
        reject(e);
      }
    });
  });
}

// Vercel (serverless) n'a pas soffice : on délègue au service Render distant
// qui a LibreOffice — même principe que convertirDocxEnPdfDistant.
async function convertirDocEnDocxDistant(docBuffer) {
  const url = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!url || !secret) {
    throw new Error(`fallback distant non configuré (URL: ${url ? 'ok' : 'MANQUANTE'}, secret: ${secret ? 'ok' : 'MANQUANT'})`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/internal/convertir-doc-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-convert-secret': secret },
      body: docBuffer,
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

async function convertirDocEnDocx(docBuffer) {
  let erreurLocaleMsg;
  try {
    return await convertirDocEnDocxLocal(docBuffer);
  } catch (erreurLocale) {
    erreurLocaleMsg = erreurLocale.message;
  }
  try {
    return await convertirDocEnDocxDistant(docBuffer);
  } catch (erreurDistante) {
    throw new Error(`conversion locale échouée (${erreurLocaleMsg}) ; conversion distante échouée (${erreurDistante.message})`);
  }
}

// Un .docx est un zip OOXML : signature "PK". Un .doc est un fichier OLE
// (Compound File Binary), signature D0 CF 11 E0. On distingue les deux sans
// dépendre de l'extension du nom de fichier (souvent peu fiable/renommée).
function estDocLegacy(buf) {
  if (!buf || buf.length < 4) return false;
  return buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0;
}

function estDocxValide(buf) {
  if (!buf || buf.length < 2) return false;
  return buf[0] === 0x50 && buf[1] === 0x4B; // "PK"
}

module.exports = { convertirDocEnDocx, convertirDocEnDocxLocal, estDocLegacy, estDocxValide };
