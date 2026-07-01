# T3E Interface — Contexte pour Claude

## Le projet
Interface web interne pour **Toitures Trois Étoiles Inc.** (T3E), entreprise de couverture commerciale au Québec. Le site automatise la création de **soumissions** (devis de prix) et **bordereaux techniques** (feuilles de transmission de matériaux).

## Stack
- **Backend** : Node.js 22 / Express 5 / EJS
- **Base de données** : Turso (cloud SQLite) via client HTTP custom (`src/db/turso-client.js` → API `/v2/pipeline`)
- **Fichiers** : Supabase Storage (`src/services/storage.js`) — FT, templates Word, documents de connaissances, soumissions générées. Plus rien n'est écrit sur disque de façon permanente (le disque Vercel est éphémère et en lecture seule hors `/tmp`)
- **PDF** : PDF.js (preview navigateur), pdf-lib (overlay texte sur PDF), pdfkit (conversion Word→PDF)
- **Word** : JSZip (manipulation .docx XML), mammoth/word-extractor (extraction texte)
- **Hébergement** : Vercel (fonction serverless `api/index.js` qui exporte l'app Express). Render.com reste configuré (render.yaml/Dockerfile) mais n'est plus l'hébergement principal
- **Langue** : L'interface et les communications sont en **français**

## Accès
- **Site** : https://t3e-interface.onrender.com (mot de passe : `barry`)
- **GitHub** : github.com/barryalphaoumar092-arch/t3e-interface
- **Turso** : `libsql://t3e-barryalphaoumar092-arch.aws-us-east-1.turso.io`

## Architecture des fichiers

```
server.js                          # Express app, auth cookie, routes
src/
  db/
    init.js                        # Connexion Turso + migrations
    turso-client.js                # Client HTTP custom pour Turso /v2/pipeline
    schema.js                      # Schéma SQL (tables: categories, documents, materiaux, architectes, bordereaux, soumissions)
  routes/
    index.js                       # Page d'accueil (dashboard)
    connaissances.js               # CRUD documents, matériaux, architectes
    bordereaux.js                  # Upload template PDF → éditeur drag-and-drop → PDF final
    soumissions.js                 # Formulaire → remplissage template Word → .docx
    recherche.js                   # Page recherche
    api.js                         # API JSON (recherche fulltext)
  services/
    storage.js                     # Client Supabase Storage (upload/download/list par bucket)
    soumission-generator.js        # Remplit les templates Word .docx (XML manipulation via JSZip)
    pdf-filler.js                  # Overlay texte sur PDF template (pdf-lib)
    document-parser.js             # Parse PDF/Excel/Word (extraction texte)
    material-matcher.js            # Matching matériaux (Jaccard + scoring)
    claude-client.js               # Client API Claude (à activer avec ANTHROPIC_API_KEY)
views/
    *.ejs                          # Templates EJS (Bootstrap 5)
api/
    index.js                       # Entrypoint serverless Vercel (module.exports = server.js)
scripts/
    migrate-to-supabase.js         # Migration one-off documents/ → buckets Supabase Storage
documents/
    FT/, templates-soumission/     # Copies locales legacy (Git), non utilisées au runtime — voir buckets Supabase
```

### Buckets Supabase Storage
- `fiches-techniques` — FT PDF, organisées en dossiers virtuels `{Fabricant}/{fichier}.pdf`
- `templates-soumission` — les 18 templates Word (FR+EN)
- `documents` — documents de connaissances + `bordereau-template.docx` (fallback)
- `soumissions-generees` — fichiers .docx générés par `soumission-generator.js`
- Toutes les clés passent par `sanitizeKey()` (accents/caractères spéciaux retirés — Supabase Storage les rejette). Upload ET lecture doivent utiliser la même fonction pour retrouver le fichier.

## Modules

### Soumissions
- L'utilisateur choisit un système de toiture + type de travaux → le site sélectionne le bon template Word parmi 18
- Le template est rempli en remplaçant les placeholders dans le XML du .docx
- Templates dans `documents/templates-soumission/` : BUR, SOPRASMART, SOPRAFIX, COLVENT, EPDM/PVC, TPO/PVC, INVERSE, ANCESTRAL × (FR + EN) × (REFECTION + PLEUMAGE)
- Les remplacements gèrent : headers Word (header1-6.xml), apostrophes courbes (U+2019), espaces insécables (U+00A0), runs XML splittés

### Bordereaux
- L'utilisateur uploade un bordereau PDF vierge → stocké en base64 dans la DB
- Éditeur split-screen : gauche = dropdowns avec suggestions, droite = PDF.js canvas avec overlays draggables
- Positions stockées en % → converties en coordonnées PDF par pdf-filler.js
- Les fiches techniques sélectionnées sont appendues au PDF final

### Base de connaissances
- 508 matériaux (nom, fabricant, type, dimensions, liens FT/SDS)
- Documents catégorisés (fiches techniques, devis, plans)
- Architectes (firme, contact, téléphone, email)

## Conventions
- `db.execute(sql, params)` : le turso-client accepte DEUX formes : `execute("SQL", [args])` ET `execute({sql, args})`
- Les fichiers temporaires (upload multer avant parsing, conversion LibreOffice) utilisent `os.tmpdir()`, jamais un dossier du repo
- Le mot de passe du site est dans `process.env.MDP_APP` (défaut: `barry`)
- La session est un cookie signé HMAC sans état serveur (`server.js` : `signSession`/`verifySession`), nécessaire car les instances serverless Vercel ne partagent pas de mémoire

## Variables d'environnement
```
TURSO_DATABASE_URL=libsql://t3e-barryalphaoumar092-arch.aws-us-east-1.turso.io
TURSO_AUTH_TOKEN=eyJhbGci...
SUPABASE_URL=https://cfulcdzvtcymqwnuitmk.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
MDP_APP=barry
NODE_ENV=production
OPENAI_API_KEY=sk-...  (active l'IA soumissions + bordereaux)
```
À configurer à la fois sur Vercel et (si toujours utilisé) sur Render.

## IA — OpenAI
- Modèle : gpt-4o (via `src/services/claude-client.js` — le fichier garde ce nom pour ne pas changer les imports)
- `analyserDevis()` : JSON schema strict (tous les champs required)
- `proposerContenuBordereau()` : json_object (clés dynamiques, non-strict)
- Sans clé : les fonctions retournent `{ error: '...' }`, le site continue de fonctionner sans IA

## Points d'attention
- Express 5 gère les erreurs async nativement (pas besoin de express-async-errors)
- Le filesystem est éphémère et en lecture seule (Vercel) : ne jamais écrire de fichier permanent sur disque, utiliser Supabase Storage ou la DB
- La conversion LibreOffice (`docx-to-pdf.js`) échoue silencieusement sur Vercel (binaire `soffice` absent) — le code retombe automatiquement sur le fallback .docx + FT séparés dans le ZIP (`bordereaux.js` route `/generer/:id`)
- Les templates Word splitent le texte en multiple `<w:r>` runs — utiliser `replaceInXml()` ou `normalizeXmlText()` pour gérer
- Les apostrophes Word sont U+2019 (curly), pas U+0027 (straight) — utiliser `CURLY_APOS` constant
