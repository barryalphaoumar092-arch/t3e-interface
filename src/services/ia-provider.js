// Couche d'abstraction du fournisseur d'IA — le module as-built (et à terme
// les autres modules) ne dépend d'aucun modèle précis. Le fournisseur actif
// est choisi par IA_FOURNISSEUR ('openai' par défaut, 'anthropic' si
// ANTHROPIC_API_KEY est la seule clé disponible). Ajouter un fournisseur =
// ajouter une entrée dans FOURNISSEURS avec la même signature.
//
// Contrat unique : analyserJSON({ system, user, schema, maxTokens })
//   → { ok: true, data } | { ok: false, erreur }
// `schema` est un JSON Schema ; en mode strict OpenAI tous les champs doivent
// être `required` et `additionalProperties:false` (contrainte de la plateforme).

const FOURNISSEURS = {
  openai: {
    estConfigure: () => !!(process.env.OPENAI_API_KEY || '').trim(),
    async analyserJSON({ system, user, schema, maxTokens = 4096 }) {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${(process.env.OPENAI_API_KEY || '').trim()}`,
        },
        body: JSON.stringify({
          model: process.env.IA_MODELE_OPENAI || 'gpt-4o',
          temperature: 0.1,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: schema
            ? { type: 'json_schema', json_schema: { name: 'response', schema, strict: true } }
            : { type: 'json_object' },
        }),
      });
      if (!resp.ok) {
        const corps = await resp.text().catch(() => '');
        throw new Error(`OpenAI ${resp.status}: ${corps.slice(0, 300)}`);
      }
      const json = await resp.json();
      const contenu = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!contenu) throw new Error('Réponse OpenAI vide');
      return JSON.parse(contenu);
    },
  },

  anthropic: {
    estConfigure: () => !!(process.env.ANTHROPIC_API_KEY || '').trim(),
    async analyserJSON({ system, user, schema, maxTokens = 4096 }) {
      // L'API Anthropic n'a pas de response_format JSON Schema : on force la
      // sortie JSON via un outil unique dont l'input_schema EST notre schéma
      // (tool use = sortie structurée garantie).
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.IA_MODELE_ANTHROPIC || 'claude-sonnet-5',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [{
            name: 'repondre',
            description: 'Retourne la réponse structurée.',
            input_schema: schema || { type: 'object', additionalProperties: true },
          }],
          tool_choice: { type: 'tool', name: 'repondre' },
        }),
      });
      if (!resp.ok) {
        const corps = await resp.text().catch(() => '');
        throw new Error(`Anthropic ${resp.status}: ${corps.slice(0, 300)}`);
      }
      const json = await resp.json();
      const bloc = (json.content || []).find((c) => c.type === 'tool_use');
      if (!bloc) throw new Error('Réponse Anthropic sans tool_use');
      return bloc.input;
    },
  },
};

function fournisseurActif() {
  const demande = (process.env.IA_FOURNISSEUR || '').trim().toLowerCase();
  if (demande && FOURNISSEURS[demande]) return demande;
  if (FOURNISSEURS.openai.estConfigure()) return 'openai';
  if (FOURNISSEURS.anthropic.estConfigure()) return 'anthropic';
  return null;
}

function iaConfiguree() {
  const actif = fournisseurActif();
  return !!(actif && FOURNISSEURS[actif].estConfigure());
}

// Point d'entrée unique. Ne lève jamais : { ok, data | erreur }.
async function analyserJSON(options) {
  const actif = fournisseurActif();
  if (!actif || !FOURNISSEURS[actif].estConfigure()) {
    return { ok: false, erreur: "Aucun fournisseur d'IA configuré (OPENAI_API_KEY ou ANTHROPIC_API_KEY)." };
  }
  try {
    const data = await FOURNISSEURS[actif].analyserJSON(options);
    return { ok: true, data, fournisseur: actif };
  } catch (e) {
    return { ok: false, erreur: e.message, fournisseur: actif };
  }
}

module.exports = { analyserJSON, iaConfiguree, fournisseurActif };
