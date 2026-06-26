const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude(systemPrompt, userContent, jsonSchema) {
  if (!ANTHROPIC_API_KEY) {
    return { error: 'ANTHROPIC_API_KEY non configurée. Ajoutez-la dans les variables d\'environnement Render.' };
  }

  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };

  if (jsonSchema) {
    body.output_config = {
      format: {
        type: 'json_schema',
        schema: jsonSchema,
      },
    };
  }

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${text}`);
  }

  const data = await resp.json();

  if (data.stop_reason === 'refusal') {
    return { error: 'Claude a refusé la requête.' };
  }

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) return { error: 'Pas de réponse textuelle.' };

  if (jsonSchema) {
    try {
      return JSON.parse(textBlock.text);
    } catch (e) {
      return { error: 'Réponse JSON invalide', raw: textBlock.text };
    }
  }

  return { text: textBlock.text };
}

const SYSTEM_T3E = `Tu es un assistant spécialisé pour Toitures Trois Étoiles Inc. (T3E), une entreprise de couverture commerciale au Québec.
Tu connais les systèmes de toiture : BUR (asphalte et gravier), Soprasmart (panneau laminé), Soprafix (fixation mécanique), Colvent, EPDM/PVC, TPO/PVC Rhinobond, Toiture Inversée, Ancestral/Patrimonial.
Tu connais les types de travaux : Réfection complète et Pleumage (réfection partielle).
Réponds toujours en français québécois professionnel.`;

const ANALYSE_DEVIS_SCHEMA = {
  type: 'object',
  properties: {
    client_nom: { type: 'string' },
    client_adresse: { type: 'string' },
    client_ville: { type: 'string' },
    client_province: { type: 'string' },
    client_code_postal: { type: 'string' },
    client_contact: { type: 'string' },
    client_telephone: { type: 'string' },
    client_courriel: { type: 'string' },
    projet_nom: { type: 'string' },
    projet_adresse: { type: 'string' },
    systeme_toiture_recommande: { type: 'string' },
    type_travaux_recommande: { type: 'string' },
    superficie_pc: { type: 'string' },
    pontage: { type: 'string' },
    epaisseur_isolant: { type: 'string' },
    pente_isolant: { type: 'string' },
    nb_drains: { type: 'string' },
    nb_manchons_events: { type: 'string' },
    nb_manchons_etancheite: { type: 'string' },
    nb_cols_cygne: { type: 'string' },
    materiaux: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    confiance: { type: 'string' },
  },
  required: ['client_nom', 'systeme_toiture_recommande', 'type_travaux_recommande', 'confiance'],
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
Si une info n'est pas trouvée, laisse une chaîne vide.`;

  return callClaude(SYSTEM_T3E, userContent, ANALYSE_DEVIS_SCHEMA);
}

const BORDEREAU_SUGGESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'object',
      additionalProperties: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

async function proposerContenuBordereau(texteTemplate, texteDevis, materiauxDB) {
  const userContent = `Voici un bordereau technique de transmission de matériaux pour un projet de toiture.

CHAMPS DU TEMPLATE :
${texteTemplate || 'Aucun template'}

DEVIS DU PROJET :
${texteDevis || 'Aucun devis'}

MATÉRIAUX DISPONIBLES EN BASE :
${(materiauxDB || []).slice(0, 50).map(m => `- ${m.nom} (${m.fabricant})`).join('\n')}

Pour chaque champ du bordereau, propose 2-3 valeurs pertinentes basées sur le devis et les matériaux.
Retourne un objet "suggestions" où chaque clé est le nom du champ et la valeur est un tableau de suggestions.`;

  return callClaude(SYSTEM_T3E, userContent, BORDEREAU_SUGGESTIONS_SCHEMA);
}

function isConfigured() {
  return !!ANTHROPIC_API_KEY;
}

module.exports = { analyserDevis, proposerContenuBordereau, isConfigured, callClaude };
