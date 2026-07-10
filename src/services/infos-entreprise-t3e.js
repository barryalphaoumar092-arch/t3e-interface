// Coordonnees et identifiants OFFICIELS FIXES de Toitures Trois Etoiles Inc.,
// fournis directement par l'utilisateur (2026-07) -- a utiliser TELS QUELS
// dans tout formulaire de soumission SEAO, sans jamais dependre de
// l'extraction IA a partir des documents de la base de connaissances.
// L'extraction IA (voir claude-client.js/seao-autofill.js) reste fragile pour
// ces valeurs precises : elles peuvent etre absentes des documents, ou
// confondues avec celles de l'entite juridique differente "Service
// d'entretien Toitures Trois Etoiles Inc." -- ces constantes ecrasent
// systematiquement le resultat de l'IA (voir obtenirInfosEntreprise()).
const INFOS_ENTREPRISE_T3E = {
  NEQ: '1142111666',
  RBQ: '1321-1933-78',
  CCQ: '60-294103',
  CNESST_NUMERO: '80484505',
  TPS_TVH: '105305494',
  TVQ: '1000611499',
  NEA: '105305494PG0001',
  NOM_ENTREPRISE: 'Toitures Trois Étoiles Inc.',
  ADRESSE_ENTREPRISE: '7550 Rue Saint-Patrick, Montréal, QC H8N 1V1',
  TELEPHONE_ENTREPRISE: '514-365-6600',
  TELECOPIEUR_ENTREPRISE: '514-365-8252',
  SITE_WEB: 'https://www.toiturestroisetoiles.com/',
  COURRIEL_ENTREPRISE: 'info@toiturestroisetoiles.com',
  // PAS de SIGNATAIRE_AUTORISE fixe ici : contrairement au reste de ces
  // coordonnees, le signataire n'est jamais une personne unique pour
  // l'entreprise -- c'est le representant selectionne pour CE dossier
  // (voir representants.js/champsRepresentant()) qui signe. Un signataire
  // fixe ici ecraserait a tort le representant choisi par l'utilisateur.
};

function champsEntrepriseFixes() {
  return { ...INFOS_ENTREPRISE_T3E };
}

module.exports = { INFOS_ENTREPRISE_T3E, champsEntrepriseFixes };
