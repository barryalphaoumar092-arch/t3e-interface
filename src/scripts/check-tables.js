const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(path.join(__dirname, '..', '..', 'data', 't3e.db'));
  const db = new SQL.Database(buf);
  const r = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (r.length > 0) {
    for (const row of r[0].values) {
      console.log('\n--- ' + row[0] + ' ---');
      console.log(row[1]);
      const count = db.exec('SELECT COUNT(*) FROM ' + row[0]);
      console.log('Lignes: ' + count[0].values[0][0]);
    }
  }
  db.close();
})();
