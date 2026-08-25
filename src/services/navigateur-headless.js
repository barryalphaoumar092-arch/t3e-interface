// Lance une instance Chromium headless via @sparticuz/chromium + playwright-core
// — fonctionne sur Vercel (fonction serverless, aucun binaire natif a installer),
// deja valide en production par seao-scraper.js. Toute fonctionnalite ayant
// besoin d'un navigateur headless doit reutiliser ce lanceur plutot que
// dupliquer la resolution de l'executable Chromium (voir plan-vision.js).
async function lancerNavigateurHeadless() {
  const chromium = require('@sparticuz/chromium');
  const { chromium: playwrightChromium } = require('playwright-core');
  const executablePath = await chromium.executablePath();
  return playwrightChromium.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
}

module.exports = { lancerNavigateurHeadless };
