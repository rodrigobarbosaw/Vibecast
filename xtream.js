import { downloadSource } from './source-download.js';

function error(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function connection(playlist) {
  const base = new URL('.', playlist);
  const params = new URL(playlist).searchParams;
  const username = params.get('username');
  const password = params.get('password');
  return {
    async query(action, fields = {}) {
      const url = new URL('player_api.php', base);
      url.search = new URLSearchParams({ username, password, ...(action && { action }), ...fields });
      const { text } = await downloadSource(url.href);
      try {
        return JSON.parse(text);
      } catch {
        throw error('O provedor não retornou dados válidos pela API Xtream.');
      }
    },
    stream(type, id, extension) {
      const path = [type, username, password].map(encodeURIComponent).join('/');
      return new URL(path + '/' + id + '.' + extension, base).href;
    }
  };
}

const identifier = value => /^\d{1,20}$/.test(String(value));
const safeExtension = value => /^[a-z0-9]{1,8}$/i.test(value || '') ? value : 'mp4';
const music = /\b(m[uú]sicas?|music|r[aá]dios?|[aá]udio)\b/i;
function logo(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return '';
}

export async function xtreamCatalog(playlist) {
  const provider = connection(playlist);
  const login = await provider.query();
  if (String(login?.user_info?.auth) !== '1') throw error('O provedor recusou o usuário ou a senha IPTV.', 422);
  if (login.user_info.status && login.user_info.status.toLowerCase() !== 'active') {
    throw error('A conta IPTV está inativa no provedor.', 422);
  }
  const definitions = [
    { kind: 'live', stream: 'live', items: 'get_live_streams', groups: 'get_live_categories' },
    { kind: 'movie', stream: 'movie', items: 'get_vod_streams', groups: 'get_vod_categories' },
    { kind: 'series', items: 'get_series', groups: 'get_series_categories' }
  ];
  const sections = await Promise.all(definitions.map(async definition => {
    const [entries, groups] = await Promise.all([
      provider.query(definition.items), provider.query(definition.groups).catch(() => [])
    ]);
    if (!Array.isArray(entries)) throw error('O provedor não devolveu o catálogo Xtream no formato esperado.');
    const names = new Map((Array.isArray(groups) ? groups : []).map(group => [String(group.category_id), group.category_name]));
    return entries.flatMap(entry => {
      const id = definition.kind === 'series' ? entry.series_id : entry.stream_id;
      if (!identifier(id)) return [];
      const group = names.get(String(entry.category_id)) || '';
      const title = String(entry.name || 'Sem título');
      const category = definition.kind !== 'series' && music.test(group) ? 'music' : definition.kind;
      const item = { title, category, group, adult: entry.is_adult, added: Number(entry.added || entry.last_modified) || 0,
        logo: logo(entry.stream_icon || entry.cover) };
      if (definition.kind === 'series') return [{ ...item, seriesId: String(id) }];
      const extension = definition.kind === 'live' ? 'm3u8' : safeExtension(entry.container_extension);
      return [{ ...item, streamId: String(id), id: entry.epg_channel_id || '', url: provider.stream(definition.stream, id, extension) }];
    });
  }));
  return { items: sections.flat() };
}

export async function xtreamEpisodes(playlist, id) {
  if (!identifier(id)) throw error('Série inválida.', 400);
  const provider = connection(playlist);
  const result = await provider.query('get_series_info', { series_id: id });
  const seasons = result?.episodes;
  if (!seasons || typeof seasons !== 'object') throw error('O provedor não retornou os episódios desta série.');
  return Object.entries(seasons).flatMap(([season, episodes]) => {
    if (!Array.isArray(episodes)) return [];
    return episodes.flatMap(episode => identifier(episode.id) ? [{
      title: 'T' + season + ' · E' + (episode.episode_num ?? '?') + ' · ' + (episode.title || 'Sem título'),
      category: 'series',
      parentSeriesId: id,
      episodeId: String(episode.id),
      url: provider.stream('series', episode.id, safeExtension(episode.container_extension))
    }] : []);
  });
}
