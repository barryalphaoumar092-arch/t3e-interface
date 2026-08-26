// Estimation de prix INDICATIVE pour une soumission privee — calculee a
// partir de la superficie et des quantites deja extraites par l'IA (voir
// claude-client.js/analyserProjetSoumissionPrivee), appliquees a des TAUX DE
// MARCHE GENERIQUES (Quebec, couverture commerciale, 2026) — PAS les couts
// reels de T3E (materiaux/main-d'oeuvre/marge propres a l'entreprise).
//
// Origine : demande explicite de l'utilisateur d'avoir une estimation
// "comme si on n'avait pas le prix soumissionne", produite manuellement une
// premiere fois (projet 25-190-01) en appliquant des taux de marche a la
// superficie lue sur les plans -- le resultat (~800 000$) etait du meme
// ordre de grandeur que le prix reellement soumissionne (877 727$), sans
// avoir utilise ce dernier comme intrant.
//
// TOUJOURS une suggestion, jamais une verite : stockee a part
// (prix_estime_note), jamais ecrite dans prix_total ni dans le .docx genere
// (voir soumission-filler.js) -- la decision du prix final reste humaine.

// Taux generiques $/pi² (bas-haut), main-d'oeuvre + materiaux, arrachement +
// nouvelle composition complete -- A VALIDER/AJUSTER avec les couts reels
// T3E des que des donnees historiques fiables seront disponibles (voir
// limitation en bas de fichier).
const TAUX_PI2_PAR_SYSTEME = {
  BUR_REFECTION: [40, 50],
  BUR_PLEUMAGE: [20, 28],
  COLVENT_REFECTION: [35, 45],
  SOPRAFIX_REFECTION: [32, 42],
  SOPRASMART_REFECTION: [34, 44],
  EPDM_PVC_PLEUMAGE: [22, 30],
  TPO_PVC_RHINOBOND: [30, 40],
  INVERSE_REFECTION: [45, 58],
  ANCESTRAL: [55, 75],
};

// Allocations forfaitaires par accessoire (installation + raccordement).
const TAUX_DRAIN = 2000;
const TAUX_MANCHON_EVENT = 800;
const TAUX_MANCHON_ETANCHEITE = 600;

function val(champ) {
  return champ && typeof champ.valeur === 'string' ? champ.valeur.trim() : '';
}

function nombreDe(champ) {
  const v = val(champ);
  if (!v) return 0;
  const n = parseInt(v.replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// Convertit une valeur de superficie extraite (souvent suivie de son unite,
// ex. "2570 m2" ou "17140 pi2") en pieds carres. Suppose pi² si aucune unite
// n'est mentionnee (unite du gabarit de soumission).
function superficieEnPi2(champ) {
  const v = val(champ);
  if (!v) return null;
  const nombre = parseFloat(v.replace(/[^\d.,]/g, '').replace(',', '.'));
  if (isNaN(nombre) || nombre <= 0) return null;
  const enM2 = /m2|m²/i.test(v) && !/pi2|pi²|pc\b/i.test(v);
  return enM2 ? Math.round(nombre * 10.7639) : Math.round(nombre);
}

function formaterArgent(n) {
  return Math.round(n).toLocaleString('fr-CA') + ' $';
}

// Retourne { texte, bas, haut } ou null si aucune superficie n'est
// disponible (aucune base de calcul possible — jamais de valeur inventee,
// meme principe que le reste de l'extraction, voir claude-client.js).
function estimerPrix(champs, systeme) {
  const superficiePi2 = superficieEnPi2(champs.superficie_pc);
  if (!superficiePi2) return null;

  const taux = TAUX_PI2_PAR_SYSTEME[systeme] || TAUX_PI2_PAR_SYSTEME.BUR_REFECTION;
  const [tauxBas, tauxHaut] = taux;

  const nbDrains = nombreDe(champs.nb_drains);
  const nbManchonsEvents = nombreDe(champs.nb_manchons_events);
  const nbManchonsEtancheite = nombreDe(champs.nb_manchons_etancheite);
  const accessoires = nbDrains * TAUX_DRAIN + nbManchonsEvents * TAUX_MANCHON_EVENT + nbManchonsEtancheite * TAUX_MANCHON_ETANCHEITE;

  const bas = superficiePi2 * tauxBas + accessoires;
  const haut = superficiePi2 * tauxHaut + accessoires;

  const lignes = [`Membrane/isolant (${superficiePi2.toLocaleString('fr-CA')} pi² × ${tauxBas}-${tauxHaut} $/pi²) : ${formaterArgent(superficiePi2 * tauxBas)} à ${formaterArgent(superficiePi2 * tauxHaut)}`];
  if (nbDrains) lignes.push(`Drains (${nbDrains} × ${formaterArgent(TAUX_DRAIN)}) : ${formaterArgent(nbDrains * TAUX_DRAIN)}`);
  if (nbManchonsEvents) lignes.push(`Manchons d'évents (${nbManchonsEvents} × ${formaterArgent(TAUX_MANCHON_EVENT)}) : ${formaterArgent(nbManchonsEvents * TAUX_MANCHON_EVENT)}`);
  if (nbManchonsEtancheite) lignes.push(`Manchons d'étanchéité (${nbManchonsEtancheite} × ${formaterArgent(TAUX_MANCHON_ETANCHEITE)}) : ${formaterArgent(nbManchonsEtancheite * TAUX_MANCHON_ETANCHEITE)}`);

  const texte = `Estimation indicative : ${formaterArgent(bas)} à ${formaterArgent(haut)} (avant taxes)\n`
    + `Basée sur des taux de marché génériques (Québec, PAS les coûts réels T3E) — à valider.\n`
    + lignes.map((l) => `• ${l}`).join('\n')
    + `\nNe couvre pas les éléments spécifiques au projet (garde-corps, échelles, chaperons, travaux mécaniques) — à ajouter séparément.`;

  return { texte, bas: Math.round(bas), haut: Math.round(haut), superficiePi2 };
}

// LIMITATION CONNUE : ces taux sont des repères de marché generiques, pas
// les couts reels de T3E. Des qu'un historique fiable de soumissions
// (prix_total + superficie_pc reellement remplis) existera dans la base,
// remplacer TAUX_PI2_PAR_SYSTEME par un calcul base sur cet historique
// (median $/pi² par systeme) serait plus fiable — voir la discussion
// "Phase C" du plan de projet original.
module.exports = { estimerPrix };
