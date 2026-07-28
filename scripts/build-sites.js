const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const client = path.join(dist, 'client');
const server = path.join(dist, 'server');
const metadata = path.join(dist, '.openai');

fs.rmSync(dist, {recursive: true, force: true});
fs.mkdirSync(client, {recursive: true});
fs.mkdirSync(server, {recursive: true});
fs.mkdirSync(metadata, {recursive: true});
fs.cpSync(path.join(root, 'public'), client, {recursive: true});
fs.copyFileSync(path.join(root, '.openai', 'hosting.json'), path.join(metadata, 'hosting.json'));

fs.writeFileSync(path.join(server, 'index.js'), `const INDEX_PATH = '/index.html';

export default {
  async fetch(request, env) {
    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
      return new Response('Static asset binding is unavailable.', {status: 503});
    }
    const url = new URL(request.url);
    if (url.pathname === '/' || !url.pathname.includes('.')) {
      url.pathname = INDEX_PATH;
      return env.ASSETS.fetch(new Request(url, request));
    }
    return env.ASSETS.fetch(request);
  }
};
`, 'utf8');

console.log('Sites bundle created in dist/');
