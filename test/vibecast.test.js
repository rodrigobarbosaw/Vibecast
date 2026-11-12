import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { parseM3u } from '../public/catalog.js';

test('importa os quatro tipos, URLs relativas e EPG do cabeçalho', () => {
  const result = parseM3u(`#EXTM3U x-tvg-url="guide.xml"
#EXTINF:-1 tvg-id="ch",Canal, HD
/live/a.m3u8
#EXTINF:-1 group-title="Filmes",Filme
/movie/b
#EXTINF:-1,Série
/series/c
#EXTINF:-1 group-title="Rádio",Estação
/radio/d
#EXTINF:-1,Inválido
javascript:alert(1)`, 'https://provider.example/list.m3u');
  assert.deepEqual(result.items.map(item => item.category), ['live', 'movie', 'series', 'music']);
  assert.equal(result.items[0].title, 'Canal, HD');
  assert.equal(result.items[0].id, 'ch');
  assert.equal(result.items[0].url, 'https://provider.example/live/a.m3u8');
  assert.equal(result.epg, 'https://provider.example/guide.xml');
  assert.throws(() => parseM3u('#EXTM3U\n#EXT-X-TARGETDURATION:10', result.epg));
});

test('cadastro, teste de 14 dias, expiração e sessão', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vibecast-'));
  const base = 'http://localhost:31383';
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, DATA_DIR: directory, PORT: '31383', HOST: '127.0.0.1',
      APP_ORIGIN: base, STRIPE_SECRET_KEY: '', STRIPE_PRICE_ID: '', TMDB_READ_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const exited = once(server, 'exit');
  try {
    await Promise.race([once(server.stdout, 'data'), exited.then(() => { throw Error('Servidor encerrou.'); })]);
    let token = '';
    const request = async (path, method = 'GET', data) => {
      const res = await fetch(base + '/api/' + path, {
        method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined
      });
      return [res.status, await res.json()];
    };
    const [page, registration] = await Promise.all([
      fetch(base),
      request('register', 'POST', { email: 'teste@example.com', password: 'teste12345',
        m3u: 'https://provider.example/list.m3u', epg: 'https://provider.example/guide.xml' })
    ]);
    assert.equal(page.status, 200);
    const [status, data] = registration;
    assert.equal(status, 200);
    assert.equal(data.profile.plan, 'trial');
    assert.ok(Math.abs(data.profile.trialEnd - Date.now() - 14 * 86400000) < 5000);
    assert.equal(data.profile.epg, 'https://provider.example/guide.xml');
    token = data.token;
    assert.deepEqual((await request('trending'))[1], { items: [], configured: false });
    assert.equal((await request('activity', 'POST', { channel: 'canal teste' }))[0], 200);
    const progress = { key: 'series:234', position: 120, duration: 600, episode: '987' };
    assert.equal((await request('activity', 'POST', progress))[0], 200);
    assert.deepEqual((await request('activity'))[1], { progress: [progress], channels: ['canal teste'] });
    assert.deepEqual((await request('channels'))[1], { favorites: [], recent: ['canal teste'] });
    assert.equal((await request('channels/favorite', 'PUT', { channel: 'canal teste', favorite: true }))[0], 200);
    assert.deepEqual((await request('channels'))[1].favorites, ['canal teste']);
    assert.equal((await request('channels/favorite', 'PUT', { channel: 'canal teste', favorite: false }))[0], 200);
    assert.deepEqual((await request('channels'))[1].favorites, []);
    assert.equal((await request('channels/favorite', 'PUT', { channel: 'series:234', favorite: true }))[0], 200);
    assert.equal((await request('activity', 'POST', { history: 'series:234' }))[0], 200);
    assert.deepEqual((await request('channels'))[1], { favorites: ['series:234'], recent: ['series:234', 'canal teste'] });
    await request('channels/favorite', 'PUT', { channel: 'canal a', favorite: true });
    await request('channels/favorite', 'PUT', { channel: 'canal b', favorite: true });
    const [orderStatus, order] = await request('channels/favorites/order', 'PUT', { order: ['canal a', 'canal b'] });
    assert.equal(orderStatus, 200);
    assert.deepEqual(order.favorites, ['canal a', 'canal b', 'series:234']);
    assert.deepEqual((await request('channels'))[1].favorites, order.favorites);
    assert.equal((await request('sources', 'PUT', { m3u: 'http://127.0.0.1/local.m3u' }))[0], 200);
    assert.equal((await request('playlist'))[0], 400);
    const [xtreamStatus, xtream] = await request('sources', 'PUT', {
      sourceMode: 'xtream', sourceName: 'Minha TV', providerServer: 'http://provider.example:8080/painel/',
      providerUser: 'usuário &', providerPassword: 'p+#&'
    });
    assert.equal(xtreamStatus, 200);
    assert.equal(xtream.sourceName, 'Minha TV');
    assert.equal(xtream.sourceMode, 'xtream');
    const playlist = new URL(xtream.m3u);
    assert.equal(playlist.pathname, '/painel/get.php');
    assert.equal(playlist.searchParams.get('password'), 'p+#&');
    assert.equal(playlist.searchParams.get('username'), 'usuário &');
    assert.equal(playlist.searchParams.get('output'), 'm3u8');
    assert.equal(new URL(xtream.epg).pathname, '/painel/xmltv.php');
    assert.equal((await request('account'))[1].m3u, xtream.m3u);
    assert.equal((await request('sources', 'PUT', { m3u: 'https://provider.example/new.m3u' }))[0], 200);
    const db = new DatabaseSync(join(directory, 'vibecast.sqlite'));
    db.exec('UPDATE users SET trial_end=0');
    db.close();
    const [, account] = await request('account');
    assert.equal(account.plan, 'expired');
    assert.equal(account.m3u, undefined);
    assert.equal((await request('sources', 'PUT', { m3u: 'https://provider.example/new.m3u' }))[0], 402);
    assert.equal((await request('checkout', 'POST'))[0], 503);
    assert.equal((await request('logout', 'POST'))[0], 200);
    assert.equal((await request('account'))[0], 401);
    assert.equal((await request('login', 'POST', { email: 'teste@example.com', password: 'teste12345' }))[0], 200);
  } finally {
    server.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
