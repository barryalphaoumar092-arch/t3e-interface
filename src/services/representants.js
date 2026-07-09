// Profils des personnes chez T3E qui remplissent les formulaires de
// soumission SEAO — l'utilisateur choisit lequel gère le dossier avant de
// lancer le remplissage IA, et ses coordonnées remplacent automatiquement
// les champs REPRESENTANT_* sur chaque page du formulaire concerne.
// Liste fixe (3 personnes) : pas de table DB pour l'instant, à convertir en
// CRUD si le nombre de profils devait grandir.
const REPRESENTANTS = [
  {
    id: 1,
    nom: 'Hebovija',
    prenom: 'Erkand',
    poste: 'Estimateur',
    courriel: 'ehebovija@toiturestroisetoiles.com',
    telephone: '514-365-6600',
  },
  {
    id: 2,
    nom: 'Choinière',
    prenom: 'Jeremy',
    poste: 'Directeur',
    courriel: 'jchoiniere@toiturestroisetoiles.com',
    telephone: '514-799-6795',
  },
  {
    id: 3,
    nom: 'Bedoui',
    prenom: 'Fakhreddine',
    poste: 'Estimateur / Chargé de projet',
    courriel: 'fbedoui@toiturestroisetoiles.com',
    telephone: '514-365-6600 x 234',
  },
];

function listerRepresentants() {
  return REPRESENTANTS;
}

function obtenirRepresentant(id) {
  const idNum = parseInt(id, 10);
  return REPRESENTANTS.find((r) => r.id === idNum) || null;
}

// Construit les champs REPRESENTANT_* (memes cles que le schema d'extraction
// IA dans claude-client.js) a partir d'un profil — utilise pour ecraser ce
// que l'IA aurait pu deviner, une selection humaine explicite etant toujours
// plus fiable pour CE dossier precis.
function champsRepresentant(profil) {
  if (!profil) return {};
  return {
    REPRESENTANT_NOM: `${profil.prenom} ${profil.nom}`,
    REPRESENTANT_TITRE: profil.poste,
    REPRESENTANT_COURRIEL: profil.courriel,
    REPRESENTANT_TELEPHONE: profil.telephone,
    REPRESENTANT_CELLULAIRE: profil.telephone,
  };
}

module.exports = { listerRepresentants, obtenirRepresentant, champsRepresentant };
