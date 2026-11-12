import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { handleApi } from '../../server.js';

export const config = { path: '/api/*' };

export default async function handler(request, context) {
  if (!process.env.PLAYDAHORA_DATABASE_URL) {
    return Response.json({ error: 'O banco do Playdahora ainda precisa ser configurado.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const path = new URL(request.url).pathname;
  const body = request.body ? Readable.fromWeb(request.body) : [];
  const response = await handleApi({
    method: request.method,
    headers: Object.fromEntries(request.headers),
    socket: { remoteAddress: context.ip },
    [Symbol.asyncIterator]: async function* () { yield* body; }
  }, path);
  if (response.status !== 200) return response;

  let payload = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  if (payload.length > 4_000_000 && /(?:^|,\s*)gzip(?:\s*,|$)/i.test(request.headers.get('accept-encoding') || '')) {
    payload = gzipSync(payload);
    headers.set('Content-Encoding', 'gzip');
    headers.append('Vary', 'Accept-Encoding');
  }
  if (payload.length > 19_000_000) {
    return Response.json({ error: 'O catálogo excede o tamanho máximo de resposta do Playdahora.' },
      { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  const content = payload.length > 4_000_000
    ? Readable.toWeb(Readable.from([payload]))
    : payload;
  return new Response(content, { headers });
}
