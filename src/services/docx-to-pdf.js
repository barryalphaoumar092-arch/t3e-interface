const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const TMP_DIR = path.join(__dirname, '../../uploads');

async function convertirDocxEnPdf(docxBuffer) {
  const id = crypto.randomBytes(8).toString('hex');
  const docxPath = path.join(TMP_DIR, `tmp_${id}.docx`);
  const pdfPath = path.join(TMP_DIR, `tmp_${id}.pdf`);

  try {
    fs.writeFileSync(docxPath, docxBuffer);

    execSync(`soffice --headless --norestore --convert-to pdf --outdir "${TMP_DIR}" "${docxPath}"`, {
      timeout: 30000,
      stdio: 'pipe',
    });

    if (!fs.existsSync(pdfPath)) {
      throw new Error('LibreOffice n\'a pas produit de PDF');
    }

    return fs.readFileSync(pdfPath);
  } finally {
    try { fs.unlinkSync(docxPath); } catch (_) {}
    try { fs.unlinkSync(pdfPath); } catch (_) {}
  }
}

module.exports = { convertirDocxEnPdf };
