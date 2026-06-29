const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = 'gpt-4o';
const API_URL = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(systemPrompt, userContent, jsonSchema, strictMode = true) {
  if (!OPENAI_API_KEY) {
    return { error: "OPENAI_API_KEY non configurée. Ajoutez-la dans les variables d'environnement Render." };
  }

  const body = {
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };

  if (jsonSchema) {
    if (strictMode) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', schema: jsonSchema, strict: true },
      };
    } else {
      body.response_format = { type: 'json_object' };
    }
  }

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const message = data.choices && data.choices[0] && data.choices[0].message;
  if (!message) return { error: "Pas de réponse de l'API OpenAI." };

  if (jsonSchema) {
    try {
      return JSON.parse(message.content);
    } catch (e) {
      return { error: 'Réponse JSON invalide', raw: message.content };
    }
  }

  return { text: message.content };
}

const SYSTEM_T3E = `Tu es un assistant spécialisé pour Toitures Trois Étoiles Inc. (T3E), une entreprise de couverture commerciale au Québec.
Tu connais les systèmes de toiture : BUR (asphalte et gravier), Soprasmart (panneau laminé), Soprafix (fixation mécanique), Colvent, EPDM/PVC, TPO/PVC Rhinobond, Toiture Inversée, Ancestral/Patrimonial.
Tu connais les types de travaux : Réfection complète et Pleumage (réfection partielle).
Réponds toujours en français québécois professionnel.`;

const ANALYSE_DEVIS_SCHEMA = {
  type: 'object',
  properties: {
    client_nom:                   { type: 'string' },
    client_adresse:               { type: 'string' },
    client_ville:                 { type: 'string' },
    client_province:              { type: 'string' },
    client_code_postal:           { type: 'string' },
    client_contact:               { type: 'string' },
    client_telephone:             { type: 'string' },
    client_courriel:              { type: 'string' },
    projet_nom:                   { type: 'string' },
    projet_adresse:               { type: 'string' },
    systeme_toiture_recommande:   { type: 'string' },
    type_travaux_recommande:      { type: 'string' },
    superficie_pc:                { type: 'string' },
    pontage:                      { type: 'string' },
    epaisseur_isolant:            { type: 'string' },
    pente_isolant:                { type: 'string' },
    nb_drains:                    { type: 'string' },
    nb_manchons_events:           { type: 'string' },
    nb_manchons_etancheite:       { type: 'string' },
    nb_cols_cygne:                { type: 'string' },
    materiaux:                    { type: 'array', items: { type: 'string' } },
    notes:                        { type: 'string' },
    confiance:                    { type: 'string' },
  },
  required: [
    'client_nom', 'client_adresse', 'client_ville', 'client_province', 'client_code_postal',
    'client_contact', 'client_telephone', 'client_courriel',
    'projet_nom', 'projet_adresse',
    'systeme_toiture_recommande', 'type_travaux_recommande',
    'superficie_pc', 'pontage', 'epaisseur_isolant', 'pente_isolant',
    'nb_drains', 'nb_manchons_events', 'nb_manchons_etancheite', 'nb_cols_cygne',
    'materiaux', 'notes', 'confiance',
  ],
  additionalProperties: false,
};

const ANALYSE_SOUMISSION_SCHEMA = {
  type: 'object',
  properties: {
    client_nom:                   { type: 'string' },
    client_adresse:               { type: 'string' },
    client_ville:                 { type: 'string' },
    client_province:              { type: 'string' },
    client_code_postal:           { type: 'string' },
    client_contact:               { type: 'string' },
    client_telephone:             { type: 'string' },
    client_courriel:              { type: 'string' },
    projet_nom:                   { type: 'string' },
    projet_adresse:               { type: 'string' },
    systeme_toiture:              { type: 'string' },
    type_travaux:                 { type: 'string' },
    superficie_pc:                { type: 'string' },
    superficie_m2:                { type: 'string' },
    pontage:                      { type: 'string' },
    epaisseur_isolant:            { type: 'string' },
    pente_isolant:                { type: 'string' },
    type_isolant:                 { type: 'string' },
    type_pare_vapeur:             { type: 'string' },
    type_membrane_finition:       { type: 'string' },
    couleur_membrane:             { type: 'string' },
    type_panneau_support:         { type: 'string' },
    nb_drains:                    { type: 'string' },
    nb_drains_urgence:            { type: 'string' },
    nb_manchons_events:           { type: 'string' },
    nb_manchons_etancheite:       { type: 'string' },
    nb_cols_cygne:                { type: 'string' },
    type_solins:                  { type: 'string' },
    calibre_solins:               { type: 'string' },
    type_drain:                   { type: 'string' },
    bassins:                      { type: 'string' },
    garantie_t3e:                 { type: 'string' },
    garantie_manufacturier:       { type: 'string' },
    cout_remplacement_cp:         { type: 'string' },
    documents_recus:              { type: 'string' },
    date_documents:               { type: 'string' },
    sections_devis:               { type: 'string' },
    addenda:                      { type: 'string' },
    rsi_minimum:                  { type: 'string' },
    type_relevés:                 { type: 'string' },
    notes:                        { type: 'string' },
    confiance:                    { type: 'string' },
  },
  required: [
    'client_nom', 'client_adresse', 'client_ville', 'client_province', 'client_code_postal',
    'client_contact', 'client_telephone', 'client_courriel',
    'projet_nom', 'projet_adresse', 'systeme_toiture', 'type_travaux',
    'superficie_pc', 'superficie_m2', 'pontage', 'epaisseur_isolant', 'pente_isolant',
    'type_isolant', 'type_pare_vapeur', 'type_membrane_finition', 'couleur_membrane',
    'type_panneau_support', 'nb_drains', 'nb_drains_urgence',
    'nb_manchons_events', 'nb_manchons_etancheite', 'nb_cols_cygne',
    'type_solins', 'calibre_solins', 'type_drain', 'bassins',
    'garantie_t3e', 'garantie_manufacturier', 'cout_remplacement_cp',
    'documents_recus', 'date_documents', 'sections_devis', 'addenda',
    'rsi_minimum', 'type_relevés', 'notes', 'confiance',
  ],
  additionalProperties: false,
};

async function analyserDevisSoumission(texteDevis) {
  const systemPrompt = `Tu es un expert en toitures commerciales au Québec, spécialisé dans l'analyse de devis pour Toitures Trois Étoiles Inc. (T3E).
Tu dois extraire TOUTES les informations du devis pour remplir une soumission T3E. Sois EXHAUSTIF et PRÉCIS.

RÈGLES CRITIQUES :
1. Extrais les informations EXACTES du devis — ne les invente pas.
2. Pour les quantités (drains, manchons, etc.) : si le devis dit "voir plans" ou ne donne pas de nombre explicite, retourne "les" (qui signifie "tous les").
3. Pour les choix techniques avec slash (ex: "polyisocyanurate / polystyrène"), CHOISIS la bonne option selon le contexte du devis.
4. Pour le système de toiture, retourne EXACTEMENT une de ces valeurs : BUR, SOPRASMART, SOPRAFIX, COLVENT, EPDM_PVC, TPO_PVC_RHINOBOND, INVERSE, ANCESTRAL
5. Pour type_travaux : REFECTION ou PLEUMAGE
6. Pour le pontage : bois, acier, béton, ou siporex
7. Pour la garantie T3E : "5 ans", "10 ans", "15 ans" ou "20 ans"
8. Pour la garantie manufacturier : "10 ans", "15 ans", "20 ans" ou "25 ans"
9. Pour la superficie : donne-la en pieds carrés dans superficie_pc ET en m² dans superficie_m2
10. Pour l'épaisseur d'isolant : convertis le RSI en pouces si nécessaire (RSI 5.46 ≈ 3½")
11. Pour les bassins : liste tous les bassins concernés (ex: "G-4 à G-12, F-1 et E-3")
12. Pour les documents reçus : note le type (plans, sections devis, addenda) avec dates
13. Pour confiance : "haute", "moyenne", ou "basse"
14. Si une info n'est pas trouvée, retourne une chaîne vide "".

CONNAISSANCES T3E :
- Systèmes Soprema : SOPRASMART = panneau laminé adhésif, SOPRAFIX = fixation mécanique
- Pare-vapeur typique : SOPRALENE 180 SP 3,5
- Membrane finition : SOPRA STAR FLAM FR GR (granulée blanche)
- Panneau support : SECUROCK / DENSDECK PRIME (gypse haute performance)
- Drains : Ultra MEK cuivre 32 oz avec crépine Duo-Procast (Murphco)
- Manchons d'évents : aluminium prémoulé
- Manchons d'étanchéité : Chem-Curbs (Soprema) ou équivalent
- Solins : acier prépeint Weather XL (Vicwest)
- Isolant : polyisocyanurate (le plus courant dans les systèmes SBS)`;

  const userContent = `Analyse ce devis de toiture et extrais TOUTES les informations pour remplir la soumission T3E.

TEXTE DU DEVIS (premiers ${texteDevis.length} caractères) :
${texteDevis}

Extrais chaque champ avec précision. Pour les choix multiples séparés par "/" dans le devis, choisis la bonne option selon le contexte technique.`;

  return callOpenAI(systemPrompt, userContent, ANALYSE_SOUMISSION_SCHEMA, true);
}

async function analyserDevis(texteDevis, infosUtilisateur) {
  const userContent = `Analyse ce devis de toiture et extrais toutes les informations pertinentes.

INFORMATIONS FOURNIES PAR L'UTILISATEUR :
${infosUtilisateur || 'Aucune'}

TEXTE DU DEVIS :
${texteDevis || 'Aucun devis fourni'}

Extrais : client, adresse, superficie, matériaux, quantités, système de toiture recommandé.
Pour systeme_toiture_recommande, utilise EXACTEMENT une de ces valeurs : BUR, SOPRASMART, SOPRAFIX, COLVENT, EPDM_PVC, TPO_PVC_RHINOBOND, INVERSE, ANCESTRAL
Pour type_travaux_recommande : REFECTION ou PLEUMAGE
Pour confiance : "haute", "moyenne", ou "basse"
Si une info n'est pas trouvée, retourne une chaîne vide "".`;

  return callOpenAI(SYSTEM_T3E, userContent, ANALYSE_DEVIS_SCHEMA, true);
}

function isConfigured() {
  return !!OPENAI_API_KEY;
}

module.exports = { analyserDevis, analyserDevisSoumission, isConfigured };
