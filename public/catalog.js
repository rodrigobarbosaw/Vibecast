export const categories = { live: 'Ao vivo', movie: 'Filmes', series: 'Séries', music: 'Músicas' };

export function mediaUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return '';
}

function category(group, url) {
  const path = new URL(url).pathname;
  const name = group.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/\b(musica[s]?|music|radio[s]?|audio)\b/.test(name) || /\.(mp3|aac|m4a|flac|ogg|wav)$/i.test(path)) return 'music';
  if (/\/series\//i.test(path) || /\b(series|seriados|tv shows|temporadas)\b/.test(name)) return 'series';
  if (/\/movie\//i.test(path) || /\b(filmes?|movies?|cinema|vod)\b/.test(name) || /\.(mp4|mkv|webm|mov)$/i.test(path)) return 'movie';
  return 'live';
}

export function parseM3u(raw, base) {
  if (!/^\s*#EXTM3U\b/i.test(raw) || /^#EXT-X-(STREAM-INF|TARGETDURATION):/im.test(raw)) {
    throw Error('Informe uma lista IPTV M3U com canais ou mídias.');
  }
  const items = [];
  let metadata;
  const header = raw.trimStart().split(/\r?\n/, 1)[0];
  const epg = header.match(/(?:x-tvg-url|url-tvg)="([^"]+)"/i)?.[1].split(',')[0]?.trim();
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (value.startsWith('#EXTINF:')) {
      const attributes = Object.create(null);
      const [prefix, ...rest] = value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      for (const match of prefix.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1].toLowerCase()] = match[2];
      metadata = { title: rest.join(',').trim(), group: attributes['group-title'] || '',
        id: attributes['tvg-id'] || '', logo: attributes['tvg-logo'] ? mediaUrl(attributes['tvg-logo'], base) : '' };
    } else if (metadata && value.startsWith('#EXTGRP:')) {
      metadata.group ||= value.slice(8).trim();
    } else if (value && !value.startsWith('#')) {
      const url = mediaUrl(value, base);
      if (url) items.push({ ...metadata, title: metadata?.title || 'Sem título',
        group: metadata?.group || '', url, category: category(metadata?.group || '', url) });
      metadata = undefined;
    }
  }
  return { items, epg: epg ? mediaUrl(epg, base) : '' };
}

function xmltvDate(value) {
  const parts = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\s+([+-])(\d\d)(\d\d))?$/.exec(value);
  if (!parts) return NaN;
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = parts;
  const offset = sign ? (Number(offsetHours) * 60 + Number(offsetMinutes)) * (sign === '-' ? -1 : 1) : 0;
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) - offset * 60000;
}

export function parseEpg(raw) {
  const document = new DOMParser().parseFromString(raw, 'application/xml');
  if (document.documentElement.localName !== 'tv' || document.querySelector('parsererror')) throw Error('Guia XMLTV inválido.');
  const guide = new Map();
  const now = Date.now();
  for (const node of document.querySelectorAll('programme[channel]')) {
    const start = xmltvDate(node.getAttribute('start'));
    const end = xmltvDate(node.getAttribute('stop'));
    if (!Number.isFinite(start) || !(end > now) || start > now + 2 * 86400000) continue;
    const key = node.getAttribute('channel').toLowerCase();
    if (!guide.has(key)) guide.set(key, []);
    guide.get(key).push({ start, end, title: node.querySelector('title')?.textContent || 'Sem título' });
  }
  return guide;
}
