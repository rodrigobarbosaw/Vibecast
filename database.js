import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import pg from 'pg';

function postgresQueries(client) {
  function query(sql, args) {
    let index = 0;
    const statement = sql.replace(
      /\b(from|join|into|update) (users|sessions|playback|channel_views|channel_history|channel_favorites)\b/gi,
      '$1 playdahora.$2'
    );
    return client.query(statement.replace(/\?/g, () => '$' + ++index), args);
  }
  return {
    async get(sql, ...args) { return (await query(sql, args)).rows[0]; },
    async all(sql, ...args) { return (await query(sql, args)).rows; },
    async run(sql, ...args) { return { changes: (await query(sql, args)).rowCount }; }
  };
}

export async function openDatabase({ url, directory, initialize }) {
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: true },
      max: 5,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', error => console.error('Conexão PostgreSQL perdida:', error.code || error.name));
    try {
      await pool.query('SELECT 1 FROM playdahora.users LIMIT 1');
    } catch (error) {
      await pool.end();
      const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'DB_CONNECT_FAILED';
      throw Object.assign(new Error('Não foi possível conectar ao PostgreSQL do Playdahora.'), { code });
    }
    return {
      ...postgresQueries(pool),
      async transaction(action, userId) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (userId) await client.query('SELECT id FROM playdahora.users WHERE id=$1 FOR UPDATE', [userId]);
          const result = await action(postgresQueries(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    };
  }
  mkdirSync(directory, { recursive: true });
  const sqlite = new DatabaseSync(directory + '/vibecast.sqlite');
  initialize(sqlite);
  const direct = {
    get: (sql, ...args) => sqlite.prepare(sql).get(...args),
    all: (sql, ...args) => sqlite.prepare(sql).all(...args),
    run: (sql, ...args) => sqlite.prepare(sql).run(...args)
  };
  let pending = Promise.resolve();
  function enqueue(action) {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  }
  return {
    get: (...args) => enqueue(() => direct.get(...args)),
    all: (...args) => enqueue(() => direct.all(...args)),
    run: (...args) => enqueue(() => direct.run(...args)),
    transaction: action => enqueue(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await action(direct);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    })
  };
}
