function createTursoClient(url, authToken) {
  const baseUrl = url.replace('libsql://', 'https://');

  function serializeArg(val) {
    if (val === null || val === undefined) return { type: 'null' };
    if (typeof val === 'number') {
      return Number.isInteger(val)
        ? { type: 'integer', value: String(val) }
        : { type: 'float', value: val };
    }
    if (typeof val === 'bigint') return { type: 'integer', value: String(val) };
    return { type: 'text', value: String(val) };
  }

  function deserializeValue(v) {
    if (!v || v.type === 'null') return null;
    if (v.type === 'integer') return Number(v.value);
    if (v.type === 'float') return Number(v.value);
    return v.value;
  }

  function parseResult(result) {
    const cols = result.cols.map(c => c.name);
    const rows = (result.rows || []).map(row => {
      const obj = {};
      for (let i = 0; i < cols.length; i++) {
        obj[cols[i]] = deserializeValue(row[i]);
      }
      return obj;
    });
    return {
      columns: cols,
      rows,
      rowsAffected: result.affected_row_count || 0,
      lastInsertRowid: result.last_insert_rowid != null ? Number(result.last_insert_rowid) : undefined,
    };
  }

  async function execute(query, paramsArray) {
    let sql, args = [];
    if (typeof query === 'string') {
      sql = query;
      if (Array.isArray(paramsArray)) {
        args = paramsArray.map(serializeArg);
      }
    } else {
      sql = query.sql;
      args = (query.args || []).map(serializeArg);
    }

    const body = {
      requests: [
        { type: 'execute', stmt: { sql, args } },
        { type: 'close' },
      ],
    };

    const resp = await fetch(baseUrl + '/v2/pipeline', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Turso HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    const first = data.results[0];

    if (first.type === 'error') {
      throw new Error(`Turso SQL error: ${first.error.message}`);
    }

    return parseResult(first.response.result);
  }

  async function batch(statements) {
    const requests = [];
    for (const stmt of statements) {
      let sql, args = [];
      if (typeof stmt === 'string') {
        sql = stmt;
      } else {
        sql = stmt.sql;
        args = (stmt.args || []).map(serializeArg);
      }
      requests.push({ type: 'execute', stmt: { sql, args } });
    }
    requests.push({ type: 'close' });

    const resp = await fetch(baseUrl + '/v2/pipeline', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Turso HTTP ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    const results = [];
    for (const r of data.results) {
      if (r.type === 'error') throw new Error(`Turso SQL error: ${r.error.message}`);
      if (r.response && r.response.type === 'execute') {
        results.push(parseResult(r.response.result));
      }
    }
    return results;
  }

  return { execute, batch };
}

module.exports = { createTursoClient };
