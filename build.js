import { cp, copyFile, writeFile } from 'node:fs/promises';
await cp('public', 'dist', { recursive: true });
await copyFile('node_modules/hls.js/dist/hls.min.js', 'dist/hls.js');
const api = process.env.VIBECAST_API_ORIGIN || '';
if (api && new URL(api).origin !== api) throw Error('Informe apenas a origem da API.');
await writeFile('dist/config.js', 'export const apiOrigin = ' + JSON.stringify(api) + ';\n');
