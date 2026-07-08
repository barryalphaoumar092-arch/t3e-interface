// Synchronisation hebdomadaire des appels d'offres SEAO — utilise les données
// ouvertes officielles (Données Québec, format inspiré d'OCDS), PAS un scraping
// du site SEAO (application JS, pas de flux quotidien officiel — voir plan).
// Un fichier hebdo_AAAAMMJJ_AAAAMMJJ.json est publié chaque lundi (~6h) pour la
// semaine précédente, avec un mélange d'avis actifs/attribués/annulés — filtrer
// sur tender.status === 'active' donne les appels d'offres encore ouverts.
const CKAN_PACKAGE_URL = 'https://www.donneesquebec.ca/api/3/action/package_show?id=systeme-electronique-dappel-doffres-seao';

// Mots-clés volontairement RESTREINTS aux termes propres à la toiture.
// Testé sur un vrai fichier hebdo (26-009... voir scratchpad) : des mots
// génériques comme "réfection", "entretien", "enveloppe du bâtiment",
// "bassin" ou "déneigement" apparaissent dans des CENTAINES d'avis sans
// rapport (pavage de rue, mécanique automobile, déneigement de chemins,
// entretien ménager...) car ce sont des libellés de catégorie SEAO standards
// réutilisés pour énormément de types de contrats — 169 faux positifs sur un
// seul fichier hebdo contre seulement 24 avis (dont ~92% réellement
// pertinents) avec la liste ci-dessous. Si le filtrage s'avère trop strict à
// l'usage, élargir avec prudence plutôt que réintégrer les mots génériques.
const MOTS_CLES_TOITURE = [
  'toiture', 'toit ', 'toits ', 'membrane', 'étanchéité', 'etancheite',
  'bardeau', 'solin', 'couverture de bâtiment', 'couverture de batiment', 'parapet',
];

async function trouverDernierFichierHebdo() {
  const resp = await fetch(CKAN_PACKAGE_URL);
  if (!resp.ok) throw new Error(`API Données Québec ${resp.status}`);
  const data = await resp.json();
  const hebdo = (data.result.resources || []).filter((r) => (r.name || '').startsWith('hebdo_'));
  if (hebdo.length === 0) throw new Error('Aucun fichier hebdo_*.json trouvé dans le jeu de données SEAO.');
  hebdo.sort((a, b) => b.name.localeCompare(a.name));
  return hebdo[0];
}

function texteRelease(release) {
  const t = release.tender || {};
  const items = (t.items || []).map((i) => [
    i.description,
    i.classification && i.classification.description,
    ...((i.additionalClassifications || []).map((c) => c.description)),
  ].filter(Boolean).join(' ')).join(' ');
  return [t.title, items].filter(Boolean).join(' ').toLowerCase();
}

function motsClesMatches(texte) {
  return MOTS_CLES_TOITURE.filter((m) => texte.includes(m));
}

function extraireInfosRelease(release) {
  const t = release.tender || {};
  const parties = release.parties || [];
  const acheteur = parties.find((p) => (p.roles || []).includes('buyer')) || release.buyer || {};
  const lieu = acheteur.address
    ? [acheteur.address.locality, acheteur.address.region].filter(Boolean).join(', ')
    : '';
  const premierDoc = (t.documents && t.documents[0]) || {};
  const texte = texteRelease(release);
  const mots = motsClesMatches(texte);

  return {
    numeroSeao: t.id || release.ocid,
    titre: t.title || '(sans titre)',
    donneurOuvrage: acheteur.name || '',
    lieuTravaux: lieu,
    datePublication: (t.tenderPeriod && t.tenderPeriod.startDate) || release.date || '',
    dateFermeture: (t.tenderPeriod && t.tenderPeriod.endDate) || '',
    typeProjet: (t.additionalProcurementCategories || []).join(', ') || t.mainProcurementCategory || '',
    motsClesMatches: mots.join(', '),
    urlSeao: premierDoc.url || '',
    statutActif: t.status === 'active',
    dateFermetureValide: !!(t.tenderPeriod && t.tenderPeriod.endDate),
    donneesBrutes: release,
    aDesMotsCles: mots.length > 0,
  };
}

// Filtre + upsert dans appels_offres_seao. `db` = client turso (voir turso-client.js).
async function synchroniser(db) {
  const resource = await trouverDernierFichierHebdo();
  const resp = await fetch(resource.url);
  if (!resp.ok) throw new Error(`Téléchargement du fichier SEAO échoué (${resp.status})`);
  const data = await resp.json();
  const releases = data.releases || [];
  const maintenant = new Date();

  let matches = 0;
  let upserts = 0;
  for (const release of releases) {
    const t = release.tender;
    if (!t || t.status !== 'active') continue;

    const infos = extraireInfosRelease(release);
    if (!infos.aDesMotsCles) continue;
    if (infos.dateFermetureValide && new Date(infos.dateFermeture) < maintenant) continue;

    matches++;
    await db.execute({
      sql: `INSERT INTO appels_offres_seao
              (numero_seao, titre, donneur_ouvrage, lieu_travaux, date_publication, date_fermeture, type_projet, mots_cles_matches, url_seao, donnees_brutes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(numero_seao) DO UPDATE SET
              titre = excluded.titre,
              donneur_ouvrage = excluded.donneur_ouvrage,
              lieu_travaux = excluded.lieu_travaux,
              date_fermeture = excluded.date_fermeture,
              type_projet = excluded.type_projet,
              mots_cles_matches = excluded.mots_cles_matches,
              donnees_brutes = excluded.donnees_brutes,
              updated_at = datetime('now')`,
      args: [
        infos.numeroSeao, infos.titre, infos.donneurOuvrage, infos.lieuTravaux,
        infos.datePublication, infos.dateFermeture, infos.typeProjet,
        infos.motsClesMatches, infos.urlSeao, JSON.stringify(infos.donneesBrutes),
      ],
    });
    upserts++;
  }

  return {
    fichier: resource.name,
    totalReleases: releases.length,
    matches,
    upserts,
  };
}

module.exports = { synchroniser, trouverDernierFichierHebdo, extraireInfosRelease, MOTS_CLES_TOITURE };
