// Notifications email du module "Heures" — SMTP Office 365 de T3E (aucune
// configuration email n'existait ailleurs dans le repo). Sans configuration
// (variables manquantes), les fonctions n'envoient rien et logguent
// simplement — le site continue de fonctionner normalement (meme principe
// que isConfigured() dans claude-client.js pour l'IA).
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

function isConfigured() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let _transporteur = null;
function getTransporteur() {
  if (_transporteur) return _transporteur;
  _transporteur = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _transporteur;
}

// Destinataires par etape — variables d'environnement (a fournir avant mise
// en production, voir plan) : listes separees par virgules.
const DESTINATAIRES_ETAPE = {
  1: process.env.HEURES_NOTIF_REVISION || '',   // Joel + projets : feuilles pretes a reviser
  2: process.env.HEURES_NOTIF_REVISION || '',   // Joel + projets : ajout fait dans la feuille maitre
};

// Destinataires possibles pour le document final (etape 3) — Joel/projets
// choisissent explicitement a qui l'envoyer avant chaque envoi (demande
// utilisateur), plutot qu'une liste fixe automatique. Cle = identifiant
// stable utilise par le formulaire de selection, jamais l'email brut
// directement (evite qu'un champ de formulaire trafique envoie a une
// adresse arbitraire).
const DESTINATAIRES_FINAL_POSSIBLES = {
  jeremy: { nom: 'Jeremy', email: 'jchoiniere@toiturestroisetoiles.com' },
  giancarlo: { nom: 'GianCarlo', email: 'gbellini@toiturestroisetoiles.com' },
  maxime: { nom: 'Maxime', email: 'mvachon@toiturestroisetoiles.com' },
};

const BASE_URL = (process.env.SITE_BASE_URL || 'https://t3e-interface.vercel.app').replace(/\/$/, '');

async function envoyer(destinataires, sujet, texte) {
  if (!destinataires) { console.log('[heures-email] aucun destinataire configure, notification ignoree:', sujet); return; }
  if (!isConfigured()) { console.log('[heures-email] SMTP non configure, notification ignoree:', sujet); return; }
  const transporteur = getTransporteur();
  await transporteur.sendMail({
    from: process.env.SMTP_USER,
    to: destinataires,
    subject: sujet,
    text: texte,
  });
}

// feuilles : lignes `feuilles_temps` concernees (une notification peut
// regrouper plusieurs semaines deposees en meme temps).
async function envoyerNotificationEtape(etape, feuilles) {
  const liste = feuilles.map(f => `- Semaine ${f.semaine_debut} au ${f.semaine_fin} : ${BASE_URL}/heures/${f.id}`).join('\n');
  const sujets = {
    1: 'T3E Interface — Feuilles de temps prêtes à être révisées',
    2: 'T3E Interface — Feuille Maître mise à jour, à confirmer',
    3: 'T3E Interface — Suivi des heures finalisé',
  };
  await envoyer(DESTINATAIRES_ETAPE[etape], sujets[etape] || 'T3E Interface — Heures', `Bonjour,\n\n${liste}\n\nMerci de vérifier sur la plateforme.`);
}

// Etape 3, confirmation finale : envoie le lien de telechargement du
// document final (ABCD-COPIE.xlsx) aux destinataires CHOISIS par Joel/
// projets au moment de l'envoi (voir DESTINATAIRES_FINAL_POSSIBLES) — lien
// signe plutot que piece jointe (evite les limites de taille SMTP, coherent
// avec le reste du site qui privilegie deja les liens signes Supabase pour
// les gros fichiers). cles : sous-ensemble des cles de
// DESTINATAIRES_FINAL_POSSIBLES ; les cles inconnues sont ignorees (jamais
// d'envoi a une adresse non prevue).
async function envoyerDocumentFinal(lienTelechargement, feuille, cles) {
  const destinataires = (cles || [])
    .map(cle => DESTINATAIRES_FINAL_POSSIBLES[cle])
    .filter(Boolean)
    .map(d => d.email)
    .join(', ');
  if (!destinataires) { console.log('[heures-email] aucun destinataire selectionne, envoi final ignore'); return; }
  await envoyer(
    destinataires,
    'T3E Interface — Suivi des heures finalisé',
    `Bonjour,\n\nLe suivi des heures est à jour (semaine ${feuille.semaine_debut} au ${feuille.semaine_fin} intégrée et confirmée).\n\nTélécharger : ${lienTelechargement}\n\n(Lien valide 5 minutes — retéléchargez depuis la plateforme si besoin.)`
  );
}

module.exports = { isConfigured, envoyerNotificationEtape, envoyerDocumentFinal, DESTINATAIRES_FINAL_POSSIBLES };
