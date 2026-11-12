import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { downloadSource } from './source-download.js';
import { xtreamCatalog, xtreamEpisodes } from './xtream.js';

const hashPassword = promisify(scrypt);
const port = Number(process.env.PORT || 3000);
const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:' + port).origin;
const allowed = new Set([origin, 'capacitor://localhost', 'https://localhost']);
const secret = process.env.STRIPE_SECRET_KEY;
const price = process.env.STRIPE_PRICE_ID;
const day = 86400000;
const directory = process.env.DATA_DIR || 'data';
mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(directory + '/vibecast.sqlite');
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT, password TEXT,
    m3u TEXT, epg TEXT, trial_end INTEGER, customer TEXT, checkout TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, expires INTEGER);
  CREATE TABLE IF NOT EXISTS playback (
    user_id TEXT, media_key TEXT, position REAL, duration REAL, updated INTEGER, episode TEXT,
    PRIMARY KEY (user_id, media_key)
  );
  CREATE TABLE IF NOT EXISTS channel_views (channel TEXT PRIMARY KEY, views INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS channel_history (
    user_id TEXT, channel TEXT, watched INTEGER, PRIMARY KEY(user_id, channel)
  );
  CREATE TABLE IF NOT EXISTS channel_favorites (
    user_id TEXT, channel TEXT, PRIMARY KEY(user_id, channel)
  );
`);
const columns = db.prepare('PRAGMA table_info(users)').all();
if (!db.prepare('PRAGMA table_info(playback)').all().some(column => column.name === 'episode')) {
  db.exec('ALTER TABLE playback ADD COLUMN episode TEXT');
}
if (!columns.some(column => column.name === 'source_name')) {
  db.exec("ALTER TABLE users ADD COLUMN source_name TEXT NOT NULL DEFAULT ''");
}
if (!columns.some(column => column.name === 'source_mode')) {
  db.exec("ALTER TABLE users ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'm3u'");
}
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const random = () => randomBytes(32).toString('hex');
const checkoutLocks = new Set();
let trends;

async function trendingMovies() {
  const token = process.env.TMDB_READ_TOKEN;
  if (!token) return { items: [], configured: false };
  if (trends?.expires > Date.now()) return trends.value;
  const response = await fetch('https://api.themoviedb.org/3/trending/movie/day?language=pt-BR', {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000)
  }).catch(() => null);
  if (!response?.ok) throw fail(502, 'Os filmes em alta estão temporariamente indisponíveis.');
  const { results } = await response.json();
  const value = { configured: true, items: results.slice(0, 10).map(movie => ({
    title: movie.title, link: 'https://www.themoviedb.org/movie/' + movie.id,
    logo: /^\/[a-zA-Z0-9]+\.jpg$/.test(movie.poster_path || '')
      ? 'https://image.tmdb.org/t/p/w342' + movie.poster_path : ''
  })) };
  trends = { value, expires: Date.now() + 900000 };
  return value;
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16384) throw fail(413, 'Dados muito grandes.');
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw Error();
    return data;
  } catch {
    throw fail(400, 'Dados inválidos.');
  }
}

function source(value, optional = false) {
  if (optional && !value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) throw Error();
    return url.href;
  } catch {
    throw fail(400, 'Informe um link HTTP ou HTTPS válido.');
  }
}

function sourceSettings(data) {
  const name = typeof data.sourceName === 'string' ? data.sourceName.trim() : '';
  if (name.length > 100) throw fail(400, 'Use até 100 caracteres no nome da lista.');
  const mode = data.sourceMode ?? 'm3u';
  if (mode === 'm3u') return { name, mode, m3u: source(data.m3u), epg: source(data.epg, true) };
  if (mode !== 'xtream') throw fail(400, 'Escolha uma forma de conexão válida.');
  const username = typeof data.providerUser === 'string' ? data.providerUser.trim() : '';
  const password = typeof data.providerPassword === 'string' ? data.providerPassword : '';
  if (!username || !password.trim() || username.length > 256 || password.length > 256) {
    throw fail(400, 'Confira o usuário e a senha do provedor.');
  }
  const server = new URL(source(data.providerServer));
  if (server.search || server.hash) throw fail(400, 'Informe o endereço do servidor sem parâmetros.');
  const prefix = server.pathname.replace(/\/(get|player_api|xmltv)\.php\/?$/i, '').replace(/\/+$/, '');
  const endpoint = (file, options) => {
    const url = new URL(server);
    url.pathname = prefix + '/' + file;
    url.search = new URLSearchParams({ username, password, ...options }).toString();
    return source(url.href);
  };
  return { name, mode, m3u: endpoint('get.php', { type: 'm3u_plus', output: 'm3u8' }),
    epg: source(data.epg, true) || endpoint('xmltv.php') };
}

function publicSources(user) {
  return { m3u: user.m3u, epg: user.epg, sourceName: user.source_name, sourceMode: user.source_mode };
}

async function stripe(path, fields, key) {
  const headers = { Authorization: 'Bearer ' + secret };
  if (key) headers['Idempotency-Key'] = key;
  const result = await fetch('https://api.stripe.com/v1/' + path, {
    headers, method: fields ? 'POST' : 'GET',
    body: fields ? new URLSearchParams(fields) : undefined,
    signal: AbortSignal.timeout(12000)
  });
  if (!result.ok) throw fail(502, 'O Stripe está indisponível ou precisa de configuração.');
  return result.json();
}

async function account(user) {
  let plan = user.trial_end > Date.now() ? 'trial' : 'expired';
  if (plan === 'expired' && secret && price && user.customer) {
    const params = new URLSearchParams({ customer: user.customer, status: 'active' });
    const subscriptions = await stripe('subscriptions?' + params);
    if (subscriptions.data.some(item => item.items.data.some(line => line.price.id === price))) plan = 'paid';
  }
  return { email: user.email, trialEnd: user.trial_end, plan, billing: Boolean(secret && price),
    ...(plan !== 'expired' && publicSources(user)) };
}

async function checkout(user) {
  if (!secret || !price) throw fail(503, 'Configure o Stripe para ativar assinaturas.');
  if (checkoutLocks.has(user.id)) throw fail(409, 'Já existe uma solicitação em andamento.');
  checkoutLocks.add(user.id);
  try {
    if ((await account(user)).plan !== 'expired') throw fail(409, 'Sua conta já tem acesso.');
    let customer = user.customer;
    if (!customer) {
      customer = (await stripe('customers', { email: user.email }, 'customer-' + user.id)).id;
      db.prepare('UPDATE users SET customer=? WHERE id=?').run(customer, user.id);
    }
    let previous;
    if (user.checkout) {
      previous = await stripe('checkout/sessions/' + encodeURIComponent(user.checkout));
      if (previous.status === 'open') return { url: previous.url };
      if (previous.status === 'complete' && previous.payment_status === 'unpaid') {
        throw fail(409, 'Seu pagamento está sendo processado.');
      }
    }
    const session = await stripe('checkout/sessions', {
      customer, mode: 'subscription', 'line_items[0][price]': price,
      'line_items[0][quantity]': '1', success_url: origin + '/?checkout=success',
      cancel_url: origin + '/?checkout=cancel'
    }, 'checkout-' + user.id + '-' + (previous?.id || 'first'));
    db.prepare('UPDATE users SET checkout=? WHERE id=?').run(session.id, user.id);
    return { url: session.url };
  } finally {
    checkoutLocks.delete(user.id);
  }
}

const attempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
}, 60000).unref();

async function api(req, path) {
  const route = req.method + ' ' + path;
  if (route === 'POST /api/register' || route === 'POST /api/login') {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let entry = attempts.get(ip);
    if (!entry || entry.until <= now) {
      entry = { count: 0, until: now + 60000 };
      attempts.set(ip, entry);
    }
    if (++entry.count > 20) throw fail(429, 'Muitas tentativas. Aguarde um minuto.');
    const data = await body(req);
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    const password = typeof data.password === 'string' ? data.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        password.length < 8 || password.length > 128) throw fail(400, 'Confira o e-mail e a senha de 8 a 128 caracteres.');
    let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (route.endsWith('/register')) {
      if (user) throw fail(409, 'Este e-mail já tem uma conta.');
      const { name, mode, m3u, epg } = sourceSettings(data);
      const salt = random();
      const passwordHash = (await hashPassword(password, salt, 64)).toString('hex');
      const result = db.prepare('INSERT OR IGNORE INTO users (id,email,salt,password,m3u,epg,trial_end,source_name,source_mode) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(random(), email, salt, passwordHash, m3u, epg, Date.now() + 14 * day, name, mode);
      if (!result.changes) throw fail(409, 'Este e-mail já tem uma conta.');
      user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    } else {
      const actual = await hashPassword(password, user?.salt || 'unknown-account', 64);
      if (!user || !timingSafeEqual(actual, Buffer.from(user.password, 'hex'))) throw fail(401, 'E-mail ou senha incorretos.');
    }
    const profile = await account(user);
    const token = random();
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash(token), user.id, Date.now() + 30 * day);
    return { token, profile };
  }
  const token = tokenHash(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const user = db.prepare('SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE token=? AND expires>?')
    .get(token, Date.now());
  if (!user) throw fail(401, 'Entre na sua conta.');
  const seriesId = req.method === 'GET' && /^\/api\/series\/(\d{1,20})$/.exec(path)?.[1];
  if (seriesId) {
    const profile = await account(user);
    if (profile.plan === 'expired') throw fail(402, 'Uma assinatura ativa é necessária.');
    if (profile.sourceMode !== 'xtream') throw fail(404, 'Série indisponível.');
    try {
      return { items: await xtreamEpisodes(profile.m3u, seriesId) };
    } catch (error) {
      if (error.status) throw error;
      throw fail(502, 'Não foi possível carregar os episódios.');
    }
  }
  switch (route) {
    case 'GET /api/account': return account(user);
    case 'GET /api/channels': return {
      favorites: db.prepare('SELECT channel FROM channel_favorites WHERE user_id=? ORDER BY rowid DESC').all(user.id).map(row => row.channel),
      recent: db.prepare('SELECT channel FROM channel_history WHERE user_id=? ORDER BY watched DESC LIMIT 100').all(user.id).map(row => row.channel)
    };
    case 'PUT /api/channels/favorite': {
      const data = await body(req);
      if (typeof data.channel !== 'string' || !data.channel.trim() || data.channel.length > 256 ||
          typeof data.favorite !== 'boolean') throw fail(400, 'Canal inválido.');
      const sql = data.favorite ? 'INSERT OR IGNORE INTO channel_favorites VALUES (?,?)'
        : 'DELETE FROM channel_favorites WHERE user_id=? AND channel=?';
      db.prepare(sql).run(user.id, data.channel);
      return {};
    }
    case 'PUT /api/channels/favorites/order': {
      const { order } = await body(req);
      if (!Array.isArray(order) || !order.length || order.some(key => typeof key !== 'string' || !key || key.length > 256) ||
          new Set(order).size !== order.length) throw fail(400, 'Ordem inválida.');
      const keys = new Set(order);
      const remove = db.prepare('DELETE FROM channel_favorites WHERE rowid=?');
      const insert = db.prepare('INSERT INTO channel_favorites (rowid,user_id,channel) VALUES (?,?,?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        const rows = db.prepare('SELECT rowid, channel FROM channel_favorites WHERE user_id=? ORDER BY rowid DESC').all(user.id);
        const positions = rows.filter(row => keys.has(row.channel));
        if (positions.length !== order.length) throw fail(409, 'A lista de favoritos mudou. Atualize e tente novamente.');
        for (const row of positions) remove.run(row.rowid);
        positions.forEach((row, index) => insert.run(row.rowid, user.id, order[index]));
        let index = 0;
        const favorites = rows.map(row => keys.has(row.channel) ? order[index++] : row.channel);
        db.exec('COMMIT');
        return { favorites };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    case 'GET /api/trending': return trendingMovies();
    case 'GET /api/activity': return {
      progress: db.prepare('SELECT media_key AS key, position, duration, episode FROM playback WHERE user_id=? ORDER BY updated DESC LIMIT 200').all(user.id),
      channels: db.prepare('SELECT channel FROM channel_views ORDER BY views DESC, channel').all().map(row => row.channel)
    };
    case 'POST /api/activity': {
      const profile = await account(user);
      if (profile.plan === 'expired') throw fail(402, 'Uma assinatura ativa é necessária.');
      const data = await body(req);
      const history = typeof data.history === 'string' && data.history.length <= 256 &&
        /^(movie|series|music):.+$/u.test(data.history) ? data.history : null;
      if (data.channel && typeof data.channel === 'string' && data.channel.length <= 256) {
        db.prepare('INSERT INTO channel_views VALUES (?,1) ON CONFLICT(channel) DO UPDATE SET views=views+1').run(data.channel);
        db.prepare('INSERT INTO channel_history VALUES (?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET watched=excluded.watched')
          .run(user.id, data.channel, Date.now());
      } else if (!history) {
        const { key, position, duration, episode } = data;
        if (typeof key !== 'string' || !/^(movie|series):.{1,500}$/u.test(key) || !Number.isFinite(position) ||
            !Number.isFinite(duration) || position < 0 || duration <= 0 || position > duration + 1) {
          throw fail(400, 'Progresso inválido.');
        }
        const episodeId = typeof episode === 'string' && /^\d{1,20}$/.test(episode) ? episode : null;
        db.prepare('INSERT INTO playback VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,media_key) DO UPDATE SET position=excluded.position,duration=excluded.duration,updated=excluded.updated,episode=excluded.episode')
          .run(user.id, key, position, duration, Date.now(), episodeId);
      }
      if (history) db.prepare('INSERT INTO channel_history VALUES (?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET watched=excluded.watched')
        .run(user.id, history, Date.now());
      return {};
    }
    case 'GET /api/playlist':
    case 'GET /api/epg': {
      const profile = await account(user);
      if (profile.plan === 'expired') throw fail(402, 'Uma assinatura ativa é necessária.');
      const url = path === '/api/playlist' ? profile.m3u : profile.epg;
      if (!url) throw fail(404, 'Link não cadastrado.');
      try {
        if (path === '/api/playlist' && profile.sourceMode === 'xtream') return await xtreamCatalog(url);
        const result = await downloadSource(url);
        if (!result.text.trim()) {
          throw fail(502, path === '/api/playlist'
            ? 'O provedor respondeu com HTTP 200, mas enviou uma lista vazia. Confira o endereço com o provedor ou importe um arquivo M3U.'
            : 'O provedor enviou um guia EPG vazio.');
        }
        return result;
      } catch (error) {
        if (error.status) throw error;
        if (error.code === 'EPROTO' || error.code?.startsWith('ERR_TLS_')) {
          throw fail(502, 'A conexão HTTPS com o provedor falhou. Confira se o endereço, o protocolo e a porta são exatamente os informados pelo provedor.');
        }
        throw fail(502, 'O servidor não conseguiu baixar o arquivo. Confira se o link está ativo.');
      }
    }
    case 'POST /api/logout':
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      return {};
    case 'PUT /api/sources': {
      const profile = await account(user);
      if (profile.plan === 'expired') throw fail(402, 'Uma assinatura ativa é necessária.');
      const data = await body(req);
      const { name, mode, m3u, epg } = sourceSettings(data);
      db.prepare('UPDATE users SET m3u=?, epg=?, source_name=?, source_mode=? WHERE id=?').run(m3u, epg, name, mode, user.id);
      return { ...profile, ...publicSources({ m3u, epg, source_name: name, source_mode: mode }) };
    }
    case 'POST /api/checkout': return checkout(user);
    default: throw fail(404, 'Rota inexistente.');
  }
}

const assets = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/style.css', ['public/style.css', 'text/css']],
  ['/app.js', ['public/app.js', 'text/javascript']],
  ['/catalog.js', ['public/catalog.js', 'text/javascript']],
  ['/config.js', ['public/config.js', 'text/javascript']],
  ['/hls.js', ['node_modules/hls.js/dist/hls.min.js', 'text/javascript']]
]);

createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const path = new URL(req.url, origin).pathname;
    if (path.startsWith('/api/')) {
      if (req.headers.origin) {
        if (!allowed.has(req.headers.origin)) throw fail(403, 'Origem não permitida.');
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' }).end();
        return;
      }
      const data = await api(req, path);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      return;
    }
    const asset = assets.get(path);
    if (!asset || req.method !== 'GET') throw fail(404, 'Página inexistente.');
    const content = await readFile(asset[0]).catch(() => { throw fail(404, 'Arquivo indisponível.'); });
    res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }).end(content);
  } catch (error) {
    res.writeHead(error.status || 500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error.status ? error.message : 'Serviço temporariamente indisponível.' }));
  }
}).listen(port, process.env.HOST || '127.0.0.1', () => console.log('VibeCast em ' + origin));
