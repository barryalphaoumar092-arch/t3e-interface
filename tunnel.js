const localtunnel = require('localtunnel');

(async () => {
  try {
    const tunnel = await localtunnel({ port: 3000 });
    console.log('\n  ================================');
    console.log('  LIEN PUBLIC T3E:');
    console.log('  ' + tunnel.url);
    console.log('  ================================');
    console.log('  Mot de passe: barry');
    console.log('  (Gardez cette fenetre ouverte)\n');

    tunnel.on('close', () => {
      console.log('Tunnel ferme.');
      process.exit();
    });

    tunnel.on('error', (err) => {
      console.error('Erreur tunnel:', err);
    });
  } catch (err) {
    console.error('Erreur:', err.message);
  }
})();
