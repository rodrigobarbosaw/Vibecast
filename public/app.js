import { apiOrigin } from './config.js';
import { adultContent, adultLabel, adultsLast, categories, parseM3u, parseEpg } from './catalog.js';

const $ = id => document.getElementById(id);
const store = localStorage;
const auth = $('auth-form');
const sources = $('source-form');
function initializeSources(container) {
  container.append($('source-fields').content.cloneNode(true));
  const selector = container.querySelector('select');
  const sync = () => {
    for (const fields of container.querySelectorAll('[data-mode]')) {
      fields.hidden = fields.disabled = fields.dataset.mode !== selector.value;
    }
  };
  selector.addEventListener('change', sync);
  return sync;
}
const syncSignup = initializeSources($('signup-sources'));
const syncEdit = initializeSources($('edit-sources'));
let token = store.getItem('vibecast-session') || '';
let signup = true;
let profile;
let catalog = [];
let guide = new Map();
let guideMessage = '';
let category = 'home';
let limit = 48;
let request;
let hls;
let activity = { progress: [], channels: [] };
let trending = { items: [], message: 'Carregando filmes em alta…' };
let loadingHome;
let channels = { favorites: [], recent: [] };
let channelFilter = 'all';
let channelGroup = '';
let playRequest = 0;
const pendingFavorites = new Set();
let favoriteDraft;
let adultFavorites = new Set();
let pickedFavorite;
let savingFavorites = false;

async function loadChannels() {
  const current = token;
  try {
    const result = await api('channels');
    if (token !== current) return;
    channels = result;
    render();
  } catch (error) {
    if (token === current && category === 'live') $('catalog-status').textContent = error.message;
  }
}

const channelKey = item => item.title.normalize('NFKC').trim().toLowerCase().slice(0, 256);
const playbackKey = item => item.category + ':' + (item.parentSeriesId || item.seriesId ||
  item.streamId || [item.title, item.group].join('|')).replace(/[\r\n]/g, ' ').slice(0, 500);

async function loadHome() {
  const current = token;
  if (!current || loadingHome === current) return;
  loadingHome = current;
  await Promise.allSettled([
    api('activity').then(result => {
      if (token === current) activity = result;
    }),
    api('channels').then(result => {
      if (token === current) channels = result;
    }),
    api('trending').then(result => {
      if (token === current) trending = { items: result.items,
        message: result.configured ? 'Nenhum filme em alta disponível.' : 'Os filmes em alta serão exibidos quando o TMDB estiver configurado.' };
    }).catch(error => {
      if (token === current) trending = { items: [], message: error.message };
    })
  ]);
  if (loadingHome === current) loadingHome = undefined;
  if (token === current && profile?.plan !== 'expired' && category === 'home') renderHome();
}

async function api(path, method = 'GET', data) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(apiOrigin + '/api/' + path, { method, headers,
      body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(50000) });
  } catch {
    throw Error('Não foi possível conectar ao Playdahora.');
  }
  const payload = await response.json();
  if (!response.ok) throw Object.assign(Error(payload.error), { status: response.status });
  return payload;
}

const favoriteKey = item => item.category === 'live' ? channelKey(item) : playbackKey(item).slice(0, 256);

function setToken(value) {
  token = value;
  if (value) store.setItem('vibecast-session', value);
  else store.removeItem('vibecast-session');
}

function stop() {
  hls?.destroy();
  hls = undefined;
  for (const media of [$('video'), $('audio')]) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
}

function display(next) {
  const active = next && next.plan !== 'expired';
  if (!active) {
    request?.abort();
    catalog = [];
    channels = { favorites: [], recent: [] };
    favoriteDraft = pickedFavorite = undefined;
    channelFilter = 'all';
    channelGroup = '';
    activity = { progress: [], channels: [] };
    trending = { items: [], message: 'Carregando filmes em alta…' };
    category = 'home';
    $('home').replaceChildren();
    guide.clear();
    $('cards').replaceChildren();
    if ($('player').open) $('player').close();
    if ($('episodes').open) $('episodes').close();
    if ($('sources').open) $('sources').close();
    closeLive();
  }
  profile = next;
  $('auth').hidden = Boolean(next);
  $('account-actions').hidden = !next;
  $('settings').hidden = !active;
  $('settings').title = next?.sourceName || 'Minha lista';
  $('library').hidden = !active;
  if (!active) $('file-import').hidden = true;
  $('expired').hidden = !next || active;
  $('subscribe').disabled = !next?.billing;
  $('billing-status').textContent = next && !next.billing ? 'A assinatura ainda não está disponível.' : '';
  const remaining = Math.max(1, Math.ceil(((next?.trialEnd || 0) - Date.now()) / 86400000));
  $('plan').textContent = ({ trial: remaining + (remaining === 1 ? ' dia grátis' : ' dias grátis'),
    paid: 'Assinatura ativa', expired: 'Teste encerrado' })[next?.plan] || '';
}

async function refresh() {
  if (!token) return;
  const current = token;
  try {
    const next = await api('account');
    if (token !== current) return;
    const changed = !profile || next.m3u !== profile.m3u || next.epg !== profile.epg || next.plan !== profile.plan;
    display(next);
    if (changed && next.plan !== 'expired') {
      loadCatalog();
      loadHome();
    }
  } catch (error) {
    if (token !== current) return;
    if (error.status === 401) setToken('');
    const wasExpired = profile?.plan === 'expired';
    if (!wasExpired || !token) display();
    $(wasExpired && token ? 'billing-status' : 'auth-status').textContent = error.message;
  }
}

async function download(url, signal, compressed = false) {
  const response = await fetch(url, { signal, referrerPolicy: 'no-referrer' });
  if (!response.ok) throw Error('A fonte respondeu com HTTP ' + response.status + '.');
  let buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (compressed && bytes[0] === 31 && bytes[1] === 139) {
    buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return { text: new TextDecoder().decode(buffer), url: response.url };
}

async function loadCatalog(file) {
  request?.abort();
  const current = new AbortController();
  request = current;
  const signal = AbortSignal.any([current.signal, AbortSignal.timeout(30000)]);
  catalog = [];
  guide = new Map();
  guideMessage = '';
  limit = 48;
  $('catalog-status').textContent = 'Carregando lista…';
  if (category === 'home') renderHome();
  $('file-import').hidden = true;
  $('cards').replaceChildren();
  $('more').hidden = true;
  try {
    if (file && file.size > 24 * 1024 * 1024) throw Error('O arquivo excede o limite de 24 MB.');
    const playlist = file ? { text: await file.text(), url: profile.m3u } : await api('playlist');
    if (current.signal.aborted) return;
    const parsed = Array.isArray(playlist.items) ? playlist : parseM3u(playlist.text, playlist.url);
    catalog = parsed.items.map(item => ({ ...item, adult: adultContent(item) }));
    render();
    const epg = profile.epg || parsed.epg;
    if (!epg) return;
    guideMessage = 'Carregando programação…';
    try {
      const xml = profile.epg ? await api('epg') : await download(epg, signal, true);
      if (current.signal.aborted) return;
      guide = parseEpg(xml.text);
      guideMessage = '';
    } catch {
      if (!current.signal.aborted) guideMessage = 'Não foi possível carregar o guia EPG. Confira o link e o acesso à fonte.';
    }
    if (current.signal.aborted) return;
    if (($('player').open || $('live-player-slot').contains($('player-content'))) && selected?.category === 'live') showGuide(selected);
    if (guideMessage) $('catalog-status').textContent += ' ' + guideMessage;
  } catch (error) {
    if (!current.signal.aborted) {
      $('catalog-status').textContent = error.message;
      $('file-import').hidden = false;
    }
  }
}

const symbols = { live: '▣', movie: '▶', series: '▤', music: '♫' };
const menuLabels = { home: 'Início', ...categories, live: 'Canais' };
const menuIcons = { home: '⌂', ...symbols };
const tabs = Object.entries(menuLabels).map(([id, label]) => {
  const button = document.createElement('button');
  const icon = document.createElement('span');
  icon.textContent = menuIcons[id];
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon, document.createTextNode(label));
  button.addEventListener('click', () => {
    if (id !== category) {
      closeLive();
      favoriteDraft = pickedFavorite = undefined;
      channelFilter = 'all';
      channelGroup = '';
      $('search').value = '';
    }
    category = id;
    limit = 48;
    render();
    if (id === 'home') loadHome();
    if (id !== 'home') loadChannels();
    window.scrollTo(0, 0);
  });
  $('categories').append(button);
  return [id, button];
});

function render() {
  for (const [id, button] of tabs) button.setAttribute('aria-pressed', id === category);
  const home = category === 'home';
  $('library-heading').textContent = menuLabels[category];
  $('home').hidden = !home;
  $('credits').hidden = !home;
  $('category-view').hidden = home;
  $('cards').hidden = home;
  $('channel-sidebar').hidden = home;
  $('sidebar-title').textContent = 'Menu de ' + menuLabels[category].toLowerCase();
  $('catalog-layout').classList.toggle('with-sidebar', !home);
  const inline = category === 'live' || category === 'music';
  $('catalog-layout').classList.toggle('with-player', inline);
  $('live-screen').hidden = !inline;
  $('live-heading').textContent = category === 'live' ? 'Player ao vivo' : 'Player';
  const showEditor = category === 'live' && channelFilter === 'favorites';
  $('favorite-editor').hidden = !showEditor;
  const editing = showEditor && Boolean(favoriteDraft);
  $('edit-favorites').hidden = editing;
  $('confirm-favorites').hidden = $('cancel-favorites').hidden = !editing;
  $('search').disabled = editing;
  $('favorite-instructions').textContent = editing
    ? (pickedFavorite ? 'Use ↑ ou ↓ para mover. Pressione o botão central para soltar.'
      : 'Selecione um canal com o botão central do controle. Use OK na tela para salvar.') : '';
  if (home) {
    $('more').hidden = true;
    $('catalog-status').textContent = '';
    renderHome();
    return;
  }
  renderChannelFilters();
  const search = $('search').value.trim().toLowerCase();
  let source = catalog;
  if (['favorites', 'recent'].includes(channelFilter)) {
    const indexed = new Map(catalog.filter(item => item.category === category).map(item => [favoriteKey(item), item]));
    source = (editing ? favoriteDraft : channels[channelFilter]).map(key => indexed.get(key)).filter(Boolean);
  } else if (channelFilter === 'group') {
    source = catalog.filter(item => item.category === category && (item.group || '') === channelGroup);
  }
  const items = adultsLast(source.filter(item => item.category === category &&
    (item.title.toLowerCase().includes(search) || item.group.toLowerCase().includes(search))));
  $('catalog-status').textContent = items.length ? items.length + (items.length === 1 ? ' item' : ' itens') : 'Nenhum item nesta categoria.';
  $('edit-favorites').disabled = !items.length;
  $('cards').replaceChildren(...(editing ? items.map(editableChannel) : items.slice(0, limit).map(item => channelCard(item))));
  $('more').hidden = editing || items.length <= limit;
}

function renderChannelFilters() {
  const nav = $('channel-filters');
  const fragment = document.createDocumentFragment();
  const option = (title, filter, group = '') => {
    const button = document.createElement('button');
    button.textContent = title;
    button.setAttribute('aria-pressed', channelFilter === filter && (filter !== 'group' || group === channelGroup));
    button.onclick = () => {
      favoriteDraft = pickedFavorite = undefined;
      channelFilter = filter;
      channelGroup = group;
      $('search').value = '';
      limit = 48;
      render();
      [...nav.querySelectorAll('button')].find(entry => entry.getAttribute('aria-pressed') === 'true')?.focus();
    };
    fragment.append(button);
  };
  option('Favoritos', 'favorites');
  option('Assistidos recentemente', 'recent');
  option(({ live: 'Todos os canais', movie: 'Todos os filmes', series: 'Todas as séries', music: 'Todas as músicas' })[category], 'all');
  const groups = new Map();
  for (const item of catalog) {
    if (item.category !== category) continue;
    const group = item.group || '';
    groups.set(group, (groups.get(group) ?? true) && item.adult);
  }
  const sorted = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  for (const group of adultsLast(sorted, name => adultLabel(name) || groups.get(name))) {
    option(group || 'Sem categoria', 'group', group);
  }
  nav.replaceChildren(fragment);
}

function channelCard(item, options) {
  const wrapper = document.createElement('div');
  wrapper.className = 'channel-card';
  const favorite = document.createElement('button');
  favorite.className = 'channel-favorite';
  const key = favoriteKey(item);
  const saved = channels.favorites.includes(key);
  favorite.textContent = saved ? '★' : '☆';
  favorite.setAttribute('aria-pressed', saved);
  favorite.setAttribute('aria-label', (saved ? 'Remover dos favoritos: ' : 'Adicionar aos favoritos: ') + item.title);
  favorite.disabled = pendingFavorites.has(key);
  favorite.onclick = async () => {
    if (pendingFavorites.has(key)) return;
    const current = token;
    pendingFavorites.add(key);
    favorite.disabled = true;
    try {
      await api('channels/favorite', 'PUT', { channel: key, favorite: !saved });
      if (token !== current) return;
      channels.favorites = saved ? channels.favorites.filter(value => value !== key) : [key, ...channels.favorites];
      pendingFavorites.delete(key);
      render();
    } catch (error) {
      if (token === current) $('catalog-status').textContent = error.message;
    } finally {
      pendingFavorites.delete(key);
      favorite.disabled = false;
    }
  };
  wrapper.append(card(item, options), favorite);
  return wrapper;
}

function editableChannel(item) {
  const key = favoriteKey(item);
  const button = card(item, { edit: true });
  button.dataset.favoriteKey = key;
  button.setAttribute('aria-pressed', pickedFavorite === key);
  button.onclick = () => {
    if (savingFavorites) return;
    if (!pickedFavorite) {
      pickedFavorite = key;
      renderFavoriteDraft(key);
      return;
    }
    const moving = pickedFavorite;
    if (moving !== key) placeFavorite(moving, favoriteDraft.indexOf(key));
    pickedFavorite = undefined;
    renderFavoriteDraft(moving);
  };
  return button;
}

function placeFavorite(key, index) {
  const from = favoriteDraft.indexOf(key);
  if (from < 0 || index < 0 || index >= favoriteDraft.length) return;
  if (adultFavorites.has(key) !== adultFavorites.has(favoriteDraft[index])) return;
  favoriteDraft.splice(from, 1);
  favoriteDraft.splice(index, 0, key);
}

function renderFavoriteDraft(key) {
  const list = $('cards');
  const scroll = list.scrollTop;
  render();
  list.scrollTop = scroll;
  const button = [...list.querySelectorAll('[data-favorite-key]')].find(item => item.dataset.favoriteKey === key);
  button?.focus();
}

$('edit-favorites').onclick = () => {
  const live = new Map(catalog.filter(item => item.category === 'live').map(item => [favoriteKey(item), item.adult]));
  adultFavorites = new Set([...live].filter(([, adult]) => adult).map(([key]) => key));
  favoriteDraft = adultsLast(channels.favorites.filter(key => live.has(key)), key => adultFavorites.has(key));
  pickedFavorite = undefined;
  $('search').value = '';
  renderFavoriteDraft(favoriteDraft[0]);
};

$('cards').addEventListener('keydown', event => {
  if (!favoriteDraft || savingFavorites || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const button = event.target.closest('[data-favorite-key]');
  if (!button) return;
  event.preventDefault();
  const key = button.dataset.favoriteKey;
  const direction = event.key === 'ArrowUp' ? -1 : 1;
  const index = favoriteDraft.indexOf(key) + direction;
  if (index < 0 || index >= favoriteDraft.length ||
      (pickedFavorite && adultFavorites.has(pickedFavorite) !== adultFavorites.has(favoriteDraft[index]))) {
    $('confirm-favorites').focus();
  } else if (pickedFavorite) {
    placeFavorite(pickedFavorite, index);
    renderFavoriteDraft(pickedFavorite);
  } else {
    [...$('cards').querySelectorAll('[data-favorite-key]')][index]?.focus();
  }
});

$('cancel-favorites').onclick = () => {
  if (savingFavorites) return;
  favoriteDraft = pickedFavorite = undefined;
  render();
  $('edit-favorites').focus();
};
$('catalog-layout').addEventListener('keydown', event => {
  if (favoriteDraft && event.key === 'Escape') {
    event.preventDefault();
    $('cancel-favorites').click();
  }
});
$('confirm-favorites').addEventListener('keydown', event => {
  if (!favoriteDraft || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  renderFavoriteDraft(pickedFavorite || (event.key === 'ArrowDown' ? favoriteDraft[0] : favoriteDraft.at(-1)));
});
$('confirm-favorites').onclick = async () => {
  if (savingFavorites || !favoriteDraft) return;
  savingFavorites = true;
  const current = token;
  const draft = favoriteDraft;
  $('confirm-favorites').disabled = $('cancel-favorites').disabled = true;
  try {
    const result = await api('channels/favorites/order', 'PUT', { order: draft });
    if (token !== current) return;
    channels.favorites = result.favorites;
    if (favoriteDraft === draft) {
      favoriteDraft = pickedFavorite = undefined;
      render();
      $('edit-favorites').focus();
    }
  } catch (error) {
    if (token === current && favoriteDraft === draft) $('favorite-instructions').textContent = error.message;
  } finally {
    savingFavorites = false;
    $('confirm-favorites').disabled = $('cancel-favorites').disabled = false;
  }
};

function card(item, options = {}) {
    const button = document.createElement(item.link ? 'a' : 'button');
    if (item.link) {
      button.href = item.link;
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
    }
    button.className = 'card';
    const art = document.createElement('span');
    art.className = 'art';
    const symbol = document.createElement('span');
    symbol.style.gridArea = '1/1';
    symbol.textContent = symbols[item.category] || '▶';
    symbol.setAttribute('aria-hidden', 'true');
    art.append(symbol);
    if (item.logo) {
      const logo = new Image();
      logo.loading = 'lazy';
      logo.alt = '';
      logo.referrerPolicy = 'no-referrer';
      logo.addEventListener('error', () => logo.remove(), { once: true });
      logo.src = item.logo;
      art.append(logo);
    }
    if (options.rank) {
      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = options.rank;
      art.append(rank);
    }
    if (item.link || item.category === 'movie' || item.category === 'series') button.classList.add('poster-card');
    const details = document.createElement('span');
    details.className = 'card-text';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const group = document.createElement('small');
    group.textContent = options.subtitle || item.group || categories[item.category] || 'TMDB';
    details.append(title, group);
    button.append(art, details);
    if (!item.link && !options.edit) button.addEventListener('click', () => item.seriesId ? showEpisodes(item, options.resume) : play(item));
    return button;
}

function shelf(title, items, message, options = () => ({})) {
  const section = document.createElement('section');
  section.className = 'shelf';
  const heading = document.createElement('h2');
  heading.textContent = title;
  section.append(heading);
  if (items.length) {
    const row = document.createElement('div');
    row.className = 'shelf-row';
    row.append(...items.map((item, index) => item.link ? card(item, options(item, index)) : channelCard(item, options(item, index))));
    section.append(row);
  } else {
    const empty = document.createElement('p');
    empty.textContent = message;
    section.append(empty);
  }
  return section;
}

function renderHome() {
  const live = new Map();
  const playable = new Map();
  const recent = { movie: [], series: [], live: [] };
  for (const item of catalog) {
    if (item.category === 'live') live.set(channelKey(item), item);
    if (item.category === 'movie' || item.category === 'series') playable.set(playbackKey(item), item);
    if (item.added > 0 && recent[item.category]) recent[item.category].push(item);
  }
  const resume = { movie: [], series: [] };
  for (const saved of activity.progress) {
    const item = playable.get(saved.key);
    if (item && saved.position > 0 && saved.duration - saved.position > 5) {
      resume[item.category].push({ ...item, saved });
    }
  }
  const channels = adultsLast(activity.channels.map(name => live.get(name)).filter(Boolean).slice(0, 10)
    .map((item, index) => ({ ...item, rank: index + 1 })));
  const resumeOptions = item => ({ resume: item.saved,
    subtitle: 'Retomar em ' + new Date(item.saved.position * 1000).toISOString().slice(11, 19) });
  const latest = type => adultsLast(recent[type].sort((a, b) => b.added - a.added)).slice(0, 12);
  const noDates = 'A lista ainda não forneceu datas de adição.';
  $('home').replaceChildren(
    shelf('10 filmes em alta no TMDB', adultsLast(trending.items), trending.message),
    shelf('Top 10 canais mais assistidos do Playdahora', channels, 'Os canais da sua lista aparecem aqui conforme são assistidos.', item => ({ rank: item.rank })),
    shelf('Continue assistindo a filmes', adultsLast(resume.movie).slice(0, 12), 'Seus filmes em andamento aparecem aqui.', resumeOptions),
    shelf('Continue assistindo a séries', adultsLast(resume.series).slice(0, 12), 'Suas séries em andamento aparecem aqui.', resumeOptions),
    shelf('Filmes adicionados recentemente', latest('movie'), noDates),
    shelf('Séries adicionadas recentemente', latest('series'), noDates),
    shelf('Canais adicionados recentemente', latest('live'), noDates)
  );
}

const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
let selected;

function clearPlayback() {
  const media = selected?.category === 'music' ? $('audio') : $('video');
  media.onpause?.();
  for (const property of ['onpause', 'ontimeupdate', 'onloadedmetadata', 'onplaying', 'onended', 'onerror']) {
    media[property] = null;
  }
  selected = undefined;
  stop();
}

function closeLive() {
  playRequest++;
  closeEpisodes();
  if (!$('live-player-slot').contains($('player-content'))) return;
  clearPlayback();
  $('player').append($('player-content'));
  $('live-placeholder').hidden = false;
}

function closeEpisodes() {
  const dialog = $('episodes');
  if (dialog.open) dialog.close();
}

$('close-episodes').onclick = closeEpisodes;

function updateLiveControls() {
  const video = selected?.category === 'music' ? $('audio') : $('video');
  $('live-toggle').textContent = video.paused ? 'Reproduzir' : 'Pausar';
  $('live-mute').textContent = video.muted ? 'Ativar som' : 'Silenciar';
  $('live-mute').setAttribute('aria-pressed', video.muted);
  $('live-volume').value = video.volume;
  $('live-skip').disabled = !video.seekable.length ||
    video.seekable.end(video.seekable.length - 1) - video.currentTime < 1;
  $('live-fullscreen').hidden = video === $('audio');
}

const liveVideo = $('video');
const inlineMedia = () => selected?.category === 'music' ? $('audio') : liveVideo;
for (const media of [liveVideo, $('audio')]) {
  for (const event of ['play', 'pause', 'progress', 'timeupdate', 'volumechange', 'loadedmetadata']) {
    media.addEventListener(event, updateLiveControls);
  }
}
$('live-toggle').onclick = () => {
  const media = inlineMedia();
  if (media.paused) media.play().catch(() => {});
  else media.pause();
};
$('live-skip').onclick = () => {
  const media = inlineMedia();
  if (!media.seekable.length) return;
  const end = media.seekable.end(media.seekable.length - 1);
  media.currentTime = Math.min(end, media.currentTime + 30);
};
$('live-mute').onclick = () => {
  const media = inlineMedia();
  media.muted = !media.muted;
};
$('live-volume').oninput = event => {
  const media = inlineMedia();
  media.volume = Number(event.target.value);
  media.muted = media.volume === 0;
};
$('live-fullscreen').onclick = () => {
  if (liveVideo.requestFullscreen) {
    liveVideo.requestFullscreen().catch(() => liveVideo.webkitEnterFullscreen?.());
  } else liveVideo.webkitEnterFullscreen?.();
};

async function showEpisodes(item, resume) {
  const dialog = $('episodes');
  const attempt = ++playRequest;
  $('episodes-title').textContent = item.title;
  $('episodes-status').textContent = 'Carregando episódios…';
  $('episode-list').replaceChildren();
  dialog.showModal();
  const current = token;
  try {
    const { items } = await api('series/' + item.seriesId);
    if (token !== current || attempt !== playRequest || !dialog.open) return;
    const pending = resume && items.find(episode => episode.episodeId === resume.episode);
    if (pending) {
      closeEpisodes();
      play(pending);
      return;
    }
    $('episodes-status').textContent = items.length ? '' : 'Nenhum episódio disponível.';
    const list = document.createDocumentFragment();
    for (const episode of items) {
      const button = document.createElement('button');
      button.textContent = episode.title;
      button.onclick = () => { closeEpisodes(); play(episode); };
      list.append(button);
    }
    $('episode-list').append(list);
  } catch (error) {
    if (token === current && attempt === playRequest && dialog.open) $('episodes-status').textContent = error.message;
  }
}

function showGuide(item) {
  const now = Date.now();
  const programmes = (guide.get(String(item.id || '').toLowerCase()) || []).filter(show => show.end > now)
    .sort((a, b) => a.start - b.start).slice(0, 5);
  const elements = programmes.map(show => {
    const row = document.createElement('p');
    row.textContent = (show.start <= now ? 'Agora' : time.format(show.start)) + ' · ' + show.title;
    return row;
  });
  if (!elements.length) {
    const row = document.createElement('p');
    row.textContent = guideMessage || 'Programação indisponível para este canal.';
    elements.push(row);
  }
  const heading = document.createElement('h3');
  heading.textContent = 'Programação do canal';
  $('guide').replaceChildren(heading, ...elements);
}

async function play(item) {
  const current = token;
  const attempt = ++playRequest;
  try {
    const next = await api('account');
    if (token !== current || attempt !== playRequest || $('player').open) return;
    display(next);
    if (next.plan === 'expired') return;
  } catch (error) {
    $('catalog-status').textContent = error.message;
    return;
  }
  clearPlayback();
  selected = item;
  const inline = (category === 'live' || category === 'music') && item.category === category;
  const player = $('player');
  (inline ? $('live-player-slot') : player).append($('player-content'));
  $('live-placeholder').hidden = inline;
  $('close-player').hidden = inline;
  $('live-controls').hidden = !inline;
  const music = item.category === 'music';
  const media = $(music ? 'audio' : 'video');
  $('video').hidden = music;
  $('audio').hidden = !music;
  $('player-title').textContent = item.title;
  $('play-status').textContent = '';
  $('guide').replaceChildren();
  if (item.category === 'live') showGuide(item);
  if (!inline) player.showModal();
  updateLiveControls();
  const unsupported = () => {
    $('play-status').textContent = 'Não foi possível reproduzir esta mídia. Confira o link, o formato e as permissões do provedor.';
  };
  media.onerror = unsupported;
  const key = playbackKey(item);
  const saved = activity.progress.find(entry => entry.key === key && (!item.episodeId || entry.episode === item.episodeId));
  let lastSaved = saved?.position || 0;
  const save = () => {
    if (selected !== item || token !== current || !['movie', 'series'].includes(item.category) ||
        !Number.isFinite(media.duration) || media.duration <= 0 || media.currentTime <= 0) return;
    const progress = { key, position: media.currentTime, duration: media.duration, episode: item.episodeId };
    lastSaved = progress.position;
    activity.progress = [progress, ...activity.progress.filter(entry => entry.key !== key)];
    api('activity', 'POST', progress).catch(() => {});
  };
  media.onloadedmetadata = () => {
    if (saved && saved.duration - saved.position > 5 && saved.position < media.duration) media.currentTime = saved.position;
  };
  media.ontimeupdate = () => { if (Math.abs(media.currentTime - lastSaved) >= 10) save(); };
  media.onpause = save;
  media.onended = save;
  media.onplaying = () => {
    media.onplaying = null;
    const historyKey = favoriteKey(item);
    if (historyKey) {
      const event = item.category === 'live' ? { channel: historyKey } : { history: historyKey };
      api('activity', 'POST', event).then(() => {
        if (token !== current) return;
        channels.recent = [historyKey, ...channels.recent.filter(value => value !== historyKey)].slice(0, 100);
        if (category !== 'home' && channelFilter === 'recent') render();
      }).catch(() => {});
    }
  };
  const streaming = /\.m3u8$/i.test(new URL(item.url).pathname);
  const start = () => media.play().catch(() => {});
  if (streaming && !media.canPlayType('application/vnd.apple.mpegurl') && window.Hls?.isSupported()) {
    hls = new window.Hls();
    hls.on(window.Hls.Events.ERROR, (_, error) => { if (error.fatal) unsupported(); });
    hls.on(window.Hls.Events.MANIFEST_PARSED, start);
    hls.loadSource(item.url);
    hls.attachMedia(media);
  } else {
    media.src = item.url;
    start();
  }
}

$('auth-toggle').onclick = () => {
  signup = !signup;
  $('auth-title').textContent = signup ? 'Comece seus 14 dias grátis' : 'Entre na sua conta';
  $('auth-submit').textContent = signup ? 'Criar conta' : 'Entrar';
  $('auth-toggle').textContent = signup ? 'Já tenho conta' : 'Quero criar conta';
  $('signup-sources').hidden = $('signup-sources').disabled = !signup;
  auth.elements.password.autocomplete = signup ? 'new-password' : 'current-password';
  $('auth-status').textContent = '';
};

function submit(form, status, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button.primary');
    button.disabled = true;
    $(status).textContent = 'Aguarde…';
    try {
      await action(Object.fromEntries(new FormData(form)));
      $(status).textContent = '';
    } catch (error) {
      $(status).textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

submit(auth, 'auth-status', async data => {
  const result = await api(signup ? 'register' : 'login', 'POST', data);
  setToken(result.token);
  auth.reset();
  syncSignup();
  display(result.profile);
  if (profile.plan !== 'expired') {
    loadCatalog();
    loadHome();
  }
});
submit(sources, 'source-status', async data => {
  const next = await api('sources', 'PUT', data);
  display(next);
  $('sources').close();
  loadCatalog();
});

$('settings').onclick = () => {
  sources.reset();
  const fields = sources.elements;
  fields.sourceName.value = profile.sourceName || '';
  fields.sourceMode.value = profile.sourceMode || 'm3u';
  fields.epg.value = profile.epg;
  if (fields.sourceMode.value === 'xtream') {
    const playlist = new URL(profile.m3u);
    const generatedGuide = new URL('xmltv.php', playlist);
    fields.providerUser.value = playlist.searchParams.get('username') || '';
    fields.providerPassword.value = playlist.searchParams.get('password') || '';
    generatedGuide.search = new URLSearchParams({
      username: fields.providerUser.value, password: fields.providerPassword.value
    }).toString();
    if (profile.epg === generatedGuide.href) fields.epg.value = '';
    fields.providerServer.value = new URL('.', playlist).href;
  } else {
    fields.m3u.value = profile.m3u;
  }
  syncEdit();
  $('source-status').textContent = '';
  $('sources').showModal();
};
$('logout').onclick = async () => {
  try {
    await api('logout', 'POST');
  } catch {}
  setToken('');
  display();
};
$('subscribe').onclick = async () => {
  const button = $('subscribe');
  button.disabled = true;
  try {
    if (window.Capacitor?.isNativePlatform()) {
      $('billing-status').textContent = 'Abra ' + apiOrigin + ' no navegador e entre na mesma conta para assinar.';
    } else {
      const checkout = await api('checkout', 'POST');
      location.assign(checkout.url);
    }
  } catch (error) {
    $('billing-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('recheck').onclick = refresh;
$('reload').onclick = () => loadCatalog();
$('choose-file').onclick = () => $('playlist-file').click();
$('playlist-file').onchange = event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) loadCatalog(file);
};
$('search').oninput = () => { limit = 48; render(); };
$('more').onclick = () => { limit += 48; render(); };
$('player').addEventListener('close', () => {
  clearPlayback();
  if (category === 'home' && profile?.plan !== 'expired') {
    renderHome();
    loadHome();
  }
});
for (const button of document.querySelectorAll('[data-close]')) {
  button.onclick = () => $(button.dataset.close).close();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(refresh, 60000);
refresh();
