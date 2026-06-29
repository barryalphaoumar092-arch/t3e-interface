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

module.exports = { analyserDevis, isConfigured };
