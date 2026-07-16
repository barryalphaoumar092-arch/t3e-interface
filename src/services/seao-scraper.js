// Scraper SEAO (seao.gouv.qc.ca) via navigateur headless (Playwright).
// N'EXÉCUTE JAMAIS SUR VERCEL — le site SEAO est une application JavaScript
// qui retourne une page vide à une requête HTTP simple (confirmé : fetch()
// direct sur seao.gouv.qc.ca renvoie un corps vide) et nécessite une session
// authentifiée. Ce module tourne uniquement sur le service Render (Dockerfile
// installe Chromium — voir `npx playwright install --with-deps chromium`),
// appelé depuis Vercel via /internal/seao-importer (même principe que
// docx-to-pdf.js/convertirDocxEnPdfDistant).
//
// AVERTISSEMENT — sélecteurs non vérifiés en conditions réelles : cet
// environnement de développement n'a aucun accès navigateur pour inspecter
// les pages SEAO authentifiées. Les sélecteurs ci-dessous visent le texte
// visible (français, insensible à la casse) plutôt que des classes CSS
// probablement instables, mais un ajustement après un premier test réel avec
// un vrai compte SEAO est attendu — voir logs `[seao-scraper]` et captures
// d'écran de secours (`capturerDiagnostic`) en cas d'échec.
const crypto = require('crypto');

const URL_BASE = 'https://seao.gouv.qc.ca';
const URL_CONNEXION = `${URL_BASE}/OpportunityPublication/Login.aspx`;
const TIMEOUT_NAVIGATION = 30000;

// Categorise un document par son nom de fichier — meme logique que les
// categories utilisees pour l'import manuel (appels-offres.js:CATEGORIES_DOCUMENTS).
function deviverCategorie(nomFichier) {
  const n = (nomFichier || '').toLowerCase();
  if (/(addenda|addendum|avis\s*de\s*modification)/.test(n)) return 'addenda';
  if (/(formulaire|bordereau.*soumission|soumission.*formulaire|prix)/.test(n)) return 'formulaire_soumission';
  if (/(plan|dessin)/.test(n)) return 'plans';
  if (/(devis|specification|cahier\s*des\s*charges)/.test(n)) return 'devis';
  return 'documents_administratifs';
}

function nettoyerNomFichier(nom) {
  return (nom || 'document').trim().replace(/[\r\n\t]/g, ' ').substring(0, 200);
}

// Se connecte à SEAO avec les identifiants fournis en variables d'environnement
// (jamais en dur, jamais transmis par l'appelant). Ne jette pas si déjà connecté.
async function seConnecter(page) {
  const identifiant = (process.env.SEAO_USERNAME || '').trim();
  const motDePasse = (process.env.SEAO_PASSWORD || '').trim();
  if (!identifiant || !motDePasse) {
    throw new Error('SEAO_USERNAME / SEAO_PASSWORD non configurés sur ce service.');
  }

  await page.goto(URL_CONNEXION, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVIGATION });

  // Le formulaire de connexion SEAO utilise historiquement des champs nommés
  // par leur libellé (courriel/mot de passe) — on tente plusieurs stratégies
  // de repérage plutôt qu'un sélecteur unique fragile.
  const champCourriel = page.locator(
    'input[type="email"], input[name*="courriel" i], input[id*="courriel" i], input[name*="email" i], input[id*="Login" i]'
  ).first();
  const champMotDePasse = page.locator('input[type="password"]').first();

  await champCourriel.waitFor({ state: 'visible', timeout: TIMEOUT_NAVIGATION });
  await champCourriel.fill(identifiant);
  await champMotDePasse.fill(motDePasse);

  const boutonConnexion = page.getByRole('button', { name: /connexion|se connecter|connecter/i }).first();
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: TIMEOUT_NAVIGATION }).catch(() => {}),
    boutonConnexion.click(),
  ]);

  // Vérification de session : un lien "Déconnexion"/"Mon dossier" apparaît
  // normalement après une connexion réussie.
  const connecte = await page.getByText(/déconnexion|mon dossier|mon compte/i).first().isVisible({ timeout: TIMEOUT_NAVIGATION }).catch(() => false);
  if (!connecte) {
    throw new Error("Connexion SEAO refusée ou page de connexion inattendue — vérifiez SEAO_USERNAME/SEAO_PASSWORD, ou la structure de la page a changé.");
  }
}

// Navigue vers un avis, soit directement via son URL, soit en le recherchant
// par numéro (le champ de recherche global SEAO accepte le numéro d'avis).
async function ouvrirAvis(page, { url, numeroAvis }) {
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVIGATION });
    return;
  }

  await page.goto(`${URL_BASE}/index.aspx`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVIGATION });
  const champRecherche = page.getByPlaceholder(/recherch/i).first()
    .or(page.locator('input[name*="recherch" i], input[id*="recherch" i]').first());
  await champRecherche.waitFor({ state: 'visible', timeout: TIMEOUT_NAVIGATION });
  await champRecherche.fill(numeroAvis);
  await champRecherche.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_NAVIGATION }).catch(() => {});

  const lienResultat = page.getByText(numeroAvis, { exact: false }).first();
  await lienResultat.waitFor({ state: 'visible', timeout: TIMEOUT_NAVIGATION });
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: TIMEOUT_NAVIGATION }).catch(() => {}),
    lienResultat.click(),
  ]);
}

// Extrait les métadonnées visibles de l'avis — chaque champ est cherché par
// son libellé français habituel sur SEAO, avec repli sur chaîne vide (jamais
// d'exception bloquante pour un champ manquant : mieux vaut une métadonnée
// vide et signalée "à vérifier" qu'un échec complet de l'import).
async function extraireMetadonnees(page) {
  async function texteApresLabel(libelleRegex) {
    try {
      const bloc = page.getByText(libelleRegex).first();
      const conteneur = bloc.locator('xpath=ancestor::tr[1] | xpath=ancestor::div[1]').first();
      const texte = (await conteneur.innerText({ timeout: 5000 })) || '';
      return texte.replace(libelleRegex, '').replace(/^[:\s]+/, '').trim();
    } catch (_) {
      return '';
    }
  }

  const titre = (await page.locator('h1, h2').first().innerText().catch(() => '')).trim();

  return {
    titre,
    numero_seao: await texteApresLabel(/numéro\s*(de\s*l'?)?(publication|avis)?/i),
    donneur_ouvrage: await texteApresLabel(/organisme|donneur\s*d'ouvrage/i),
    lieu_travaux: await texteApresLabel(/lieu\s*(de\s*livraison|des?\s*travaux)?/i),
    date_publication: await texteApresLabel(/date\s*de\s*publication/i),
    date_fermeture: await texteApresLabel(/date\s*et\s*heure\s*de\s*fermeture|date\s*de\s*fermeture/i),
    date_visite_obligatoire: await texteApresLabel(/visite\s*(obligatoire|des?\s*lieux)/i),
    url_seao: page.url(),
  };
}

// Repère et télécharge tous les documents listés sur la page de l'avis
// (section "Documents de l'appel d'offres" ou équivalent). Playwright
// intercepte l'événement 'download' du navigateur plutôt que de suivre les
// href directement — SEAO utilise probablement un endpoint de téléchargement
// nécessitant la session active, pas un lien statique.
async function telechargerDocuments(page) {
  const documents = [];

  // Onglet/section "Documents" — clic si présent, sinon on reste sur la page
  // courante (certains avis affichent déjà la liste sans onglet séparé).
  const ongletDocuments = page.getByText(/documents\s*(de\s*l'appel\s*d'offres|joints|annexés)?/i).first();
  if (await ongletDocuments.isVisible({ timeout: 5000 }).catch(() => false)) {
    await ongletDocuments.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT_NAVIGATION }).catch(() => {});
  }

  const liensDocuments = page.locator(
    'a[href*=".pdf" i], a[href*=".docx" i], a[href*=".doc" i], a[href*=".xlsx" i], a[href*="download" i], a[href*="telecharg" i]'
  );
  const nombreLiens = await liensDocuments.count();

  for (let i = 0; i < nombreLiens; i++) {
    const lien = liensDocuments.nth(i);
    const nomVisible = nettoyerNomFichier(await lien.innerText().catch(() => '') || `document-${i + 1}`);
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        lien.click(),
      ]);
      const flux = await download.createReadStream();
      const morceaux = [];
      for await (const morceau of flux) morceaux.push(morceau);
      const buffer = Buffer.concat(morceaux);
      const nomFichier = nettoyerNomFichier(download.suggestedFilename() || nomVisible);
      documents.push({ nom_fichier: nomFichier, buffer, categorie: deviverCategorie(nomFichier) });
    } catch (e) {
      console.warn('[seao-scraper] Document non téléchargé (' + nomVisible + '):', e.message);
    }
  }

  return documents;
}

// Point d'entrée principal — lance un navigateur, se connecte, ouvre l'avis,
// extrait métadonnées + documents, ferme le navigateur (toujours, même en cas
// d'erreur, pour ne jamais laisser un processus Chromium orphelin sur Render).
async function importerAvisSeao({ url, numeroAvis }) {
  const { chromium } = require('playwright');
  const navigateur = await chromium.launch({ headless: true });
  try {
    const contexte = await navigateur.newContext({ acceptDownloads: true, locale: 'fr-CA' });
    const page = await contexte.newPage();

    await seConnecter(page);
    await ouvrirAvis(page, { url, numeroAvis });
    const metadonnees = await extraireMetadonnees(page);
    const documents = await telechargerDocuments(page);

    return { ok: true, metadonnees, documents };
  } catch (e) {
    console.error('[seao-scraper] Import échoué:', e.message);
    return { ok: false, error: e.message };
  } finally {
    await navigateur.close().catch(() => {});
  }
}

module.exports = { importerAvisSeao, deviverCategorie };
