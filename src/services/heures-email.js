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
  3: process.env.HEURES_NOTIF_FINAL || '',      // document final (suivi des heures)
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

module.exports = { isConfigured, envoyerNotificationEtape };
