// Notifications email du module "Heures" — via l'API Resend (service tiers
// d'envoi transactionnel). Remplace une tentative initiale via SMTP Office
// 365, qui a echoue en test reel : Microsoft desactive l'authentification
// SMTP classique par defaut au niveau du TENANT depuis quelques annees
// (mesure de securite globale, erreur "SmtpClientAuthentication is disabled
// for the Tenant") — la reactiver demande un acces admin Microsoft 365 que
// l'utilisateur n'a pas. Resend fonctionne via une simple cle API HTTP,
// aucune negociation avec un administrateur necessaire.
//
// Sans configuration (RESEND_API_KEY manquante), les fonctions n'envoient
// rien et logguent simplement — le site continue de fonctionner normalement
// (meme principe que isConfigured() dans claude-client.js pour l'IA).
function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Adresse d'expedition — un domaine personnalise verifie (ex.
// notifications@toiturestroisetoiles.com) est necessaire pour envoyer a
// n'importe quel destinataire ; sans domaine verifie, Resend restreint
// l'envoi a l'adresse du compte Resend lui-meme (mode "test"). A fournir
// via RESEND_FROM une fois le domaine verifie — par defaut, l'adresse
// generique de test Resend (fonctionne seulement pour tester, pas pour les
// vrais destinataires T3E).
const FROM = process.env.RESEND_FROM || 'T3E Interface <onboarding@resend.dev>';

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
  if (!destinataires) { console.log('[heures-email] aucun destinataire configuré, notification ignorée:', sujet); return; }
  if (!isConfigured()) { console.log('[heures-email] Resend non configuré (RESEND_API_KEY manquante), notification ignorée:', sujet); return; }

  const to = destinataires.split(',').map(s => s.trim()).filter(Boolean);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject: sujet, text: texte }),
  });
  if (!resp.ok) {
    const corps = await resp.text().catch(() => '');
    throw new Error(`Resend a répondu ${resp.status}: ${corps.slice(0, 300)}`);
  }
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
  if (!destinataires) { console.log('[heures-email] aucun destinataire sélectionné, envoi final ignoré'); return; }
  await envoyer(
    destinataires,
    'T3E Interface — Suivi des heures finalisé',
    `Bonjour,\n\nLe suivi des heures est à jour (semaine ${feuille.semaine_debut} au ${feuille.semaine_fin} intégrée et confirmée).\n\nTélécharger : ${lienTelechargement}\n\n(Lien valide 5 minutes — retéléchargez depuis la plateforme si besoin.)`
  );
}

module.exports = { isConfigured, envoyerNotificationEtape, envoyerDocumentFinal, DESTINATAIRES_FINAL_POSSIBLES };
