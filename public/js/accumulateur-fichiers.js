// Un <input type="file" multiple> natif REMPLACE sa propre liste de fichiers
// a chaque nouvelle selection/glissement — si l'utilisateur glisse un fichier
// puis, avant de soumettre, en glisse un autre dans le meme champ, le premier
// est perdu. Ce module accumule les fichiers choisis au fil des selections
// successives (chaque 'change' s'AJOUTE a la liste au lieu de la remplacer)
// et affiche la liste cumulee avec un bouton de retrait par fichier.
(function () {
  function attacher(input, listeEl) {
    var fichiers = [];

    function rendre() {
      if (!listeEl) return;
      listeEl.innerHTML = '';
      fichiers.forEach(function (f, i) {
        var badge = document.createElement('span');
        badge.className = 'badge bg-primary bg-opacity-75 me-1 mb-1';
        badge.style.cursor = 'pointer';
        badge.title = 'Cliquer pour retirer ce fichier';
        badge.textContent = f.name + ' ×';
        badge.addEventListener('click', function () {
          fichiers.splice(i, 1);
          rendre();
        });
        listeEl.appendChild(badge);
      });
    }

    input.addEventListener('change', function () {
      Array.prototype.forEach.call(input.files, function (f) { fichiers.push(f); });
      // Vide l'input natif : la PROCHAINE selection s'ajoutera a "fichiers"
      // au lieu de remplacer (comportement natif du navigateur sinon).
      input.value = '';
      rendre();
    });

    return {
      getFiles: function () { return fichiers.slice(); },
      clear: function () { fichiers = []; rendre(); },
    };
  }

  window.t3eAccumulateur = { attacher: attacher };
})();
