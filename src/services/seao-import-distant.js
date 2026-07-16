// Déclenche l'import direct SEAO (scraper Playwright) sur le service Render —
// même principe que docx-to-pdf.js/convertirDocxEnPdfDistant, mais sans repli
// local puisque Vercel ne peut PAS exécuter Chromium (fonction serverless,
// pas de navigateur). Fire-and-forget : le service Render répond 202
// immédiatement et continue le travail (connexion, navigation, téléchargements,
// analyse IA) après la réponse — le statut réel se lit ensuite dans
// appels_offres_seao.statut_import et l'historique de l'appel.
async function lancerImportSeaoDistant({ appelOffreId, url, numeroAvis }) {
  const serviceUrl = (process.env.CONVERT_SERVICE_URL || '').trim();
  const secret = (process.env.CONVERT_SERVICE_SECRET || '').trim();
  if (!serviceUrl || !secret) {
    return { ok: false, error: "Service d'import SEAO non configuré (CONVERT_SERVICE_URL/CONVERT_SERVICE_SECRET manquants)." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(serviceUrl.replace(/\/$/, '') + '/internal/seao-importer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-convert-secret': secret },
      body: JSON.stringify({ appelOffreId, url, numeroAvis }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const corps = await resp.text().catch(() => '');
      return { ok: false, error: `service distant a répondu ${resp.status}: ${corps.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { lancerImportSeaoDistant };
