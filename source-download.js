import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createGunzip } from 'node:zlib';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.168.0.0',16],
  ['198.18.0.0',15], ['224.0.0.0',3]]) blocked.addSubnet(ip, bits);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::',23], ['2002::',16], ['3fff::',20]]) blocked.addSubnet(ip, bits, 'ipv6');

const limit = 24 * 1024 * 1024;
const error = (message, status = 502) => Object.assign(new Error(message), { status });

export async function downloadSource(value, redirects = 0, signal = AbortSignal.timeout(20000)) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443', '8080', '8443', '25461'].includes(url.port))) {
    throw error('Use um link público HTTP ou HTTPS com uma porta compatível.', 400);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  const usable = addresses.filter(({ address, family }) => family === 4
    ? !blocked.check(address) : globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6'));
  if (!usable.length) throw error('O link precisa apontar para um endereço público.', 400);

  const request = url.protocol === 'https:' ? httpsGet : httpGet;
  const response = await new Promise((resolve, reject) => {
    request(url, {
      signal, agent: false, headers: { 'Accept-Encoding': 'gzip' },
      lookup: (_, options, callback) => options.all
        ? callback(null, usable) : callback(null, usable[0].address, usable[0].family)
    }, resolve).on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (!response.headers.location || redirects >= 4) throw error('Redirecionamento inválido na fonte.');
    return downloadSource(new URL(response.headers.location, url).href, redirects + 1, signal);
  }
  if (response.statusCode !== 200) {
    response.destroy();
    if (response.statusCode === 403) {
      throw Object.assign(error('O provedor recusou o acesso ao link (HTTP 403). Confira se o link está ativo ou importe o arquivo baixado do provedor.'), { upstreamStatus: 403 });
    }
    throw error('A fonte respondeu com HTTP ' + response.statusCode + '. Confira o link com o provedor.');
  }
  const gzip = response.headers['content-encoding'] === 'gzip' || url.pathname.endsWith('.gz');
  const input = gzip ? response.pipe(createGunzip()) : response;
  if (gzip) response.on('error', err => input.destroy(err));
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      bytes += chunk.length;
      if (bytes > limit) throw error('O arquivo excede o limite de 24 MB.');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    return { url: url.href, text: data.toString('utf8') };
  } finally {
    response.destroy();
  }
}
