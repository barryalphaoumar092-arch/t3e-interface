const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || 'file:./data/t3e.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

console.log('DB URL:', url ? url.substring(0, 30) + '...' : 'NON DEFINIE');
console.log('DB Token:', authToken ? authToken.substring(0, 20) + '...' : 'NON DEFINI');

const db = createClient({ url, authToken });

async function initDb() {
  try {
    const r = await db.execute('SELECT COUNT(*) as c FROM categories');
    console.log(`Base de donnees connectee (${r.rows[0].c} categories)`);
  } catch (err) {
    console.error('Erreur connexion DB:', err.message);
    console.error('URL utilisee:', url);
    const httpsUrl = url.replace('libsql://', 'https://');
    console.log('Test fetch direct vers:', httpsUrl);
    try {
      const resp = await fetch(httpsUrl + '/health', { method: 'GET' });
      console.log('Health check:', resp.status, resp.statusText);
    } catch (fetchErr) {
      console.error('Fetch echoue:', fetchErr.message);
    }
    throw err;
  }
}

function getDb() {
  return db;
}

module.exports = { getDb, initDb, db };
