/*
 * SaySounds FRAN SERVER - Cloudflare Worker (intermediario entre la web pública y GitHub)
 *
 * Guarda el token de GitHub (nunca llega al navegador) y limita las subidas por IP.
 * La conversión a MP3 y la compresión .bz2 las hace el navegador; aquí solo se valida y se sube.
 *
 * Configuración en Cloudflare (Workers -> este worker -> Settings):
 *   Variables y secretos:
 *     GITHUB_TOKEN  (Secret)  token fine-grained, solo repo fast.dl, Contents: Read and write
 *     ADMIN_KEY     (Secret)  contraseña de admin: borrar sonidos y subir sin límite
 *   Bindings:
 *     KV namespace  ->  nombre de variable  LIMITS
 *
 * Rutas:
 *   GET    /status            -> { remaining, perDay }        (cuántas subidas le quedan hoy a esta IP)
 *   POST   /upload            -> cuerpo de texto: nombre \n volumen \n mp3 base64 \n bz2 base64
 *   POST   /delete            -> cuerpo: nombre   (cabecera X-Admin-Key)
 */

const REPO = 'Amnhesia/fast.dl';
const BRANCH = 'main';
const LIST_PATH = 'saysounds/list.json';
const NAMES_PATH = 'saysounds/server_names.json';
const SOUND_DIR = 'left4dead2/sound/saysounds_web';
const ALLOWED_ORIGIN = 'https://amnhesia.github.io';

const PER_IP_PER_DAY = 2;        // subidas por IP al día
const GLOBAL_PER_DAY = 40;       // tope total al día (protege el repo si alguien cambia de IP muchas veces)
const MAX_MP3_BYTES = 520 * 1024; // ~30 s a 128 kbps

const API = 'https://api.github.com/repos/' + REPO;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/status') return cors(json(await status(request, env)));
      if (request.method === 'POST' && url.pathname === '/upload') return cors(await upload(request, env));
      if (request.method === 'POST' && url.pathname === '/delete') return cors(await remove(request, env));
      return cors(json({ error: 'Ruta no encontrada' }, 404));
    } catch (e) {
      return cors(json({ error: 'Error interno: ' + e.message }, 500));
    }
  }
};

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.headers.set('Access-Control-Max-Age', '86400');
  return res;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function today() { return new Date().toISOString().slice(0, 10); }
function clientIp(request) { return request.headers.get('CF-Connecting-IP') || 'desconocida'; }
function isAdmin(request, env) {
  const key = request.headers.get('X-Admin-Key') || '';
  return !!env.ADMIN_KEY && key.length > 0 && key === env.ADMIN_KEY;
}

async function getCount(env, key) { return parseInt((await env.LIMITS.get(key)) || '0', 10); }

async function status(request, env) {
  if (isAdmin(request, env)) return { remaining: 999, perDay: PER_IP_PER_DAY, admin: true };
  const used = await getCount(env, 'ip:' + today() + ':' + clientIp(request));
  return { remaining: Math.max(0, PER_IP_PER_DAY - used), perDay: PER_IP_PER_DAY };
}

// ------------------------------------------------------------------------------------------- GitHub
async function gh(env, path, opts = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, Object.assign({}, opts, {
    headers: Object.assign({
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'User-Agent': 'FRAN-SERVER-SaySounds-Worker',
      'Content-Type': 'application/json'
    }, opts.headers || {})
  }));
  if (!res.ok) {
    const err = new Error('GitHub ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function readJson(env, path, fallback) {
  const res = await fetch(API + '/contents/' + path + '?ref=' + BRANCH, {
    headers: { 'Accept': 'application/vnd.github.raw+json', 'Authorization': 'Bearer ' + env.GITHUB_TOKEN, 'User-Agent': 'FRAN-SERVER-SaySounds-Worker' }
  });
  if (res.status === 404) return fallback;
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return res.json();
}

// Un solo commit con varios archivos. files: [{path, b64 | text | remove}]
// (el base64 llega ya hecho desde el navegador y se reenvía tal cual: casi no gasta CPU)
async function commitFiles(env, files, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(env, '/git/ref/heads/' + BRANCH);
    const head = await gh(env, '/git/commits/' + ref.object.sha);
    const tree = [];
    for (const f of files) {
      if (f.remove) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const body = f.b64 !== undefined
        ? '{"encoding":"base64","content":"' + f.b64 + '"}'
        : JSON.stringify({ encoding: 'utf-8', content: f.text });
      const blob = await gh(env, '/git/blobs', { method: 'POST', body });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const commit = await gh(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }) });
    try {
      await gh(env, '/git/refs/heads/' + BRANCH, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
      return;
    } catch (e) {
      if (e.status !== 422 || attempt === 2) throw e;   // otra subida a la vez: reintentar
    }
  }
}

function listJson(list) {
  return JSON.stringify({ sounds: list }, null, 2) + '\n';
}

function prefixBytes(b64, count) {
  const bin = atob(b64.slice(0, Math.ceil(count / 3) * 4));
  return Array.from(bin, c => c.charCodeAt(0));
}

// ------------------------------------------------------------------------------------------- Rutas
async function upload(request, env) {
  const admin = isAdmin(request, env);
  const ip = clientIp(request);
  const day = today();
  const ipKey = 'ip:' + day + ':' + ip, allKey = 'all:' + day;

  if (!admin) {
    if (await getCount(env, ipKey) >= PER_IP_PER_DAY)
      return json({ error: 'Ya subiste ' + PER_IP_PER_DAY + ' sonidos hoy. Vuelve mañana.' }, 429);
    if (await getCount(env, allKey) >= GLOBAL_PER_DAY)
      return json({ error: 'Se alcanzó el máximo de sonidos de hoy en el servidor. Vuelve mañana.' }, 429);
  }

  const parts = (await request.text()).split('\n');
  if (parts.length !== 4) return json({ error: 'Formato inválido' }, 400);
  const [name, volText, mp3, bz2] = parts;

  if (!/^[a-z0-9_]{2,31}$/.test(name)) return json({ error: 'La palabra debe tener de 2 a 31 caracteres: minúsculas, números o _' }, 400);
  let volume = parseFloat(volText);
  if (!(volume >= 0.2 && volume <= 2)) volume = 1;
  volume = Math.round(volume * 10) / 10;

  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!b64.test(mp3) || !b64.test(bz2)) return json({ error: 'Archivo inválido' }, 400);
  if (mp3.length * 0.75 > MAX_MP3_BYTES) return json({ error: 'El sonido es demasiado largo (máx. ~30 s)' }, 400);
  if (bz2.length > mp3.length * 1.1 + 400) return json({ error: 'Archivo .bz2 inválido' }, 400);

  // MP3 sin etiquetas (empieza con sincronía de trama 0xFFE) y bz2 "BZh"
  const m = prefixBytes(mp3, 2), z = prefixBytes(bz2, 3);
  if (m[0] !== 0xff || (m[1] & 0xe0) !== 0xe0) return json({ error: 'El MP3 no es válido' }, 400);
  if (z[0] !== 0x42 || z[1] !== 0x5a || z[2] !== 0x68) return json({ error: 'El .bz2 no es válido' }, 400);

  const list = (await readJson(env, LIST_PATH, { sounds: [] })).sounds || [];
  if (list.some(s => s.name === name)) return json({ error: 'Ya existe un sonido con esa palabra' }, 409);
  const serverNames = (await readJson(env, NAMES_PATH, { names: [] })).names || [];
  if (serverNames.includes(name)) return json({ error: 'Esa palabra ya la usa un sonido del servidor' }, 409);

  list.push({ name, volume, added: day });
  await commitFiles(env, [
    { path: SOUND_DIR + '/' + name + '.mp3', b64: mp3 },
    { path: SOUND_DIR + '/' + name + '.mp3.bz2', b64: bz2 },
    { path: LIST_PATH, text: listJson(list) }
  ], 'SaySounds: añadir ' + name + (admin ? ' (admin)' : ''));

  if (!admin) {
    const used = await getCount(env, ipKey) + 1;
    await env.LIMITS.put(ipKey, String(used), { expirationTtl: 172800 });
    await env.LIMITS.put(allKey, String(await getCount(env, allKey) + 1), { expirationTtl: 172800 });
    return json({ ok: true, name, remaining: Math.max(0, PER_IP_PER_DAY - used) });
  }
  return json({ ok: true, name, remaining: 999 });
}

async function remove(request, env) {
  if (!isAdmin(request, env)) return json({ error: 'Clave de admin incorrecta' }, 403);
  const name = (await request.text()).trim();
  if (!/^[a-z0-9_]{2,31}$/.test(name)) return json({ error: 'Nombre inválido' }, 400);

  const list = ((await readJson(env, LIST_PATH, { sounds: [] })).sounds || []).filter(s => s.name !== name);
  await commitFiles(env, [
    { path: SOUND_DIR + '/' + name + '.mp3', remove: true },
    { path: SOUND_DIR + '/' + name + '.mp3.bz2', remove: true },
    { path: LIST_PATH, text: listJson(list) }
  ], 'SaySounds: quitar ' + name);
  return json({ ok: true });
}
