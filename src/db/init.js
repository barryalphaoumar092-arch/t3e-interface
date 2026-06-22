const { createClient } = require('@libsql/client');
const SCHEMA = require('./schema');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./data/t3e.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  const statements = SCHEMA.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  for (const sql of statements) {
    await db.execute(sql);
  }
  console.log('Base de donnees initialisee avec succes (Turso)');
}

function getDb() {
  return db;
}

module.exports = { getDb, initDb, db };
