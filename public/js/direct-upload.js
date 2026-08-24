// Upload direct navigateur -> Supabase Storage, via URL signee obtenue du
// backend. Contourne la limite de 4.5 Mo par requete des fonctions
// serverless Vercel (les gros fichiers ne transitent jamais par la fonction).
(function () {
  var _sb = null;
  function getSb() {
    if (!_sb) {
      _sb = supabase.createClient(window.T3E_SUPABASE_URL, window.T3E_SUPABASE_ANON_KEY);
    }
    return _sb;
  }

  function attendre(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // dest: 'temp' (fichier ephemere, traite puis supprime par le serveur)
  //       'documents' (destination finale, bucket "documents")
  // Une tentative unique de reessai (delai court) : "fetch failed" cote
  // serveur (Node/Vercel appelant l'API Supabase) est generalement un blip
  // reseau transitoire plutot qu'une erreur de configuration — un reessai
  // evite de faire echouer tout un envoi de plusieurs fichiers pour un seul
  // blip isole, sans masquer une vraie erreur persistante (2e echec -> rejet).
  async function tenterUneFois(file, dest) {
    var resp = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, dest: dest }),
    });
    var info = await resp.json();
    if (!resp.ok) throw new Error(info.error || 'Erreur URL signee');

    var { error } = await getSb().storage.from(info.bucket).uploadToSignedUrl(info.key, info.token, file);
    if (error) throw error;

    return { bucket: info.bucket, key: info.key, name: file.name, size: file.size };
  }

  async function uploadDirect(file, dest) {
    try {
      return await tenterUneFois(file, dest);
    } catch (e) {
      await attendre(1200);
      return await tenterUneFois(file, dest);
    }
  }

  window.t3eDirectUpload = { uploadDirect: uploadDirect };
})();
