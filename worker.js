// Lester Tienda: API en Cloudflare Workers + D1  (versión 4: depósitos USDT automáticos)
// - /api/state              -> igual que siempre (la tienda guarda y lee todo aquí)
// - /api/usdt/orden         -> crea una orden de depósito con un monto único (ej. 10.0137)
// - /api/usdt/revisar       -> mira la blockchain (BSC) y acredita el saldo si ya llegó el pago
// - /api/usdt/cancelar      -> cancela una orden en espera
// - /api/usdt/txid          -> verifica una transferencia por su TxID (plan B, instantáneo)
// - cron (cada minuto)      -> revisa los pagos aunque el cliente haya cerrado la tienda
// Todo gratis: usa nodos públicos de BSC (sin clave) y la base D1 que ya tienes.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Clave',
};
const CLAVES = ['usuarios', 'solicitudes', 'config'];

// ---- Ajustes de USDT (puedes cambiar la dirección con la variable DIRECCION_USDT del Worker) ----
const DIRECCION_POR_DEFECTO = '0x5E0fb4a5D6403a3161abC02EB3bc2aAf6FfA48A2';
const CONTRATO_USDT = '0x55d398326f99059ff775485246999027b3197955'; // USDT en BSC (BEP20), 18 decimales
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NODOS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://1rpc.io/bnb',
];
const CONFIRMACIONES = 5;           // bloques que se esperan antes de acreditar (unos segundos)
const VIGENCIA_MS = 5 * 60 * 1000;   // una orden vale 5 minutos
const TROZO = 1500;                 // bloques por consulta
const MAX_TROZOS = 10;
const MONTO_MIN = 1.1;

function json(objeto, estado = 200) {
  return new Response(JSON.stringify(objeto), {
    status: estado,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function direccionDe(env) { return String(env.DIRECCION_USDT || DIRECCION_POR_DEFECTO).trim(); }
function relleno(dir) { return '0x' + '0'.repeat(24) + dir.toLowerCase().replace(/^0x/, ''); }

// ---------- Nodo BSC ----------
async function rpc(metodo, params) {
  let ultimoError = null;
  for (const url of NODOS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 7000);
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: metodo, params }),
      });
      clearTimeout(t);
      if (!r.ok) { ultimoError = new Error('HTTP ' + r.status); continue; }
      const j = await r.json();
      if (j.error) { ultimoError = new Error(j.error.message || 'error del nodo'); continue; }
      return j.result;
    } catch (e) { ultimoError = e; }
  }
  throw ultimoError || new Error('sin nodo disponible');
}
const aHex = (n) => '0x' + n.toString(16);

// 10.0137 -> unidades de 18 decimales (BigInt). Solo se usan 4 decimales.
function unidades(montoTexto) {
  const [ent, dec = ''] = String(montoTexto).split('.');
  return BigInt(ent + (dec + '0000').slice(0, 4)) * (10n ** 14n);
}

// ---------- D1: edición segura de un valor (reintenta si otro cambio llegó a la vez) ----------
async function editarKv(env, clave, fn) {
  for (let i = 0; i < 8; i++) {
    const fila = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(clave).first();
    const antes = fila ? fila.v : null;
    const nuevo = fn(antes ? JSON.parse(antes) : null);
    if (nuevo === null) return false;
    const txt = JSON.stringify(nuevo);
    const r = antes === null
      ? await env.DB.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').bind(clave, txt).run()
      : await env.DB.prepare('UPDATE kv SET v = ? WHERE k = ? AND v = ?').bind(txt, clave, antes).run();
    if (r.meta && r.meta.changes === 1) return true;
  }
  return false;
}

async function marcarCambio(env) {
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES ('ver', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(String(Date.now())).run();
}

// ---------- Acreditar ----------
async function acreditar(env, orden, txid, recibidoUnidades) {
  // Compuerta: solo una vez por orden y una vez por TxID
  try {
    const g = await env.DB.prepare(
      "UPDATE pagos_usdt SET estado = 'acreditado', txid = ?, recibido = ?, acreditado = ? WHERE id = ? AND estado = 'pendiente'"
    ).bind(txid, recibidoUnidades.toString(), Date.now(), orden.id).run();
    if (!g.meta || g.meta.changes !== 1) return false;
  } catch (e) { return false; } // TxID repetido

  const monto = Math.round(Number(recibidoUnidades / (10n ** 12n)) / 10000) / 100; // a 2 decimales
  const correo = orden.correo.toLowerCase().trim();

  const okUsuario = await editarKv(env, 'usuarios', (lista) => {
    if (!Array.isArray(lista)) return null;
    const u = lista.find((x) => String(x.correo || '').toLowerCase().trim() === correo);
    if (!u) return null;
    if (u.balanceCUP === undefined) u.balanceCUP = 0;
    const antes = u.balanceUSDT === undefined ? (u.balance || 0) : u.balanceUSDT;
    u.balanceUSDT = parseFloat((antes + monto).toFixed(2));
    u.balance = u.balanceUSDT;
    if (u.referidoPor) {
      const p = lista.find((x) => String(x.nombre || '').trim().toLowerCase() === String(u.referidoPor).trim().toLowerCase());
      if (p) p.descuentosDisponibles = (p.descuentosDisponibles || 0) + 1;
    }
    return lista;
  });
  if (!okUsuario) {
    await env.DB.prepare("UPDATE pagos_usdt SET estado = 'error_credito' WHERE id = ?").bind(orden.id).run();
    return false;
  }

  await editarKv(env, 'solicitudes', (s) => {
    const sol = s && typeof s === 'object' ? s : { recargas: [], depositos: [] };
    if (!Array.isArray(sol.depositos)) sol.depositos = [];
    if (!Array.isArray(sol.recargas)) sol.recargas = [];
    let id = Date.now();
    while (sol.depositos.some((d) => d.id === id)) id++;
    sol.depositos.push({
      id, correo, usuario: orden.usuario || correo, monto, moneda: 'usdt',
      telefonoTransfirio: 'TxID: ' + txid, estado: 'Aprobado', auto: true,
    });
    return sol;
  });
  await marcarCambio(env);
  return true;
}

// ---------- Buscar pagos en la blockchain ----------
async function escanear(env, persistir) {
  const ahora = Date.now();
  const { results: pend } = await env.DB.prepare(
    "SELECT * FROM pagos_usdt WHERE estado = 'pendiente' AND creado > ?"
  ).bind(ahora - VIGENCIA_MS).all();

  const cursorFila = await env.DB.prepare("SELECT v FROM kv WHERE k = 'usdt_cursor'").first();
  let cursor = cursorFila ? parseInt(cursorFila.v, 10) : 0;

  const cabeza = parseInt(await rpc('eth_blockNumber', []), 16);
  const hasta = cabeza - CONFIRMACIONES;

  if (!pend.length) {
    if (persistir) await guardarCursor(env, hasta + 1);
    return 0;
  }

  const conocidos = pend.map((o) => o.bloque_ini).filter((b) => b);
  const minIni = conocidos.length ? Math.min(...conocidos) - 1 : hasta - 3000;
  let desde = Math.max(cursor || 0, minIni);
  if (desde < hasta - TROZO * MAX_TROZOS) desde = hasta - TROZO * MAX_TROZOS;

  const porMonto = new Map(pend.map((o) => [unidades(o.monto_unico).toString(), o]));
  let acreditadas = 0;
  let avance = desde;
  const miDireccion = relleno(direccionDe(env));

  for (let i = 0; i < MAX_TROZOS && desde <= hasta; i++) {
    const fin = Math.min(desde + TROZO - 1, hasta);
    let logs;
    try {
      logs = await rpc('eth_getLogs', [{
        address: CONTRATO_USDT, fromBlock: aHex(desde), toBlock: aHex(fin),
        topics: [TOPIC_TRANSFER, null, miDireccion],
      }]);
    } catch (e) { break; }
    for (const lg of logs || []) {
      if (lg.removed) continue;
      let cant;
      try { cant = BigInt(lg.data); } catch (e) { continue; }
      const orden = porMonto.get(cant.toString());
      if (!orden) continue;
      if (await acreditar(env, orden, lg.transactionHash.toLowerCase(), cant)) acreditadas++;
    }
    avance = fin + 1;
    desde = fin + 1;
  }
  if (persistir && avance > (cursor || 0)) await guardarCursor(env, avance);
  return acreditadas;
}

async function guardarCursor(env, n) {
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES ('usdt_cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(String(n)).run();
}

async function limpiar(env) {
  const ahora = Date.now();
  await env.DB.prepare("UPDATE pagos_usdt SET estado = 'expirada' WHERE estado = 'pendiente' AND creado <= ?")
    .bind(ahora - VIGENCIA_MS).run();
  await env.DB.prepare("DELETE FROM pagos_usdt WHERE estado IN ('expirada', 'cancelada') AND creado <= ?")
    .bind(ahora - 7 * 86400000).run();
}

function vistaOrden(o, env) {
  return {
    id: o.id, estado: o.estado, monto: o.monto_unico, base: o.monto_base,
    direccion: direccionDe(env), red: 'BEP20', expira: o.creado + VIGENCIA_MS, txid: o.txid || null,
  };
}

let ultimoEscaneo = 0; // evita golpear el nodo demasiado seguido (memoria del Worker)

// ---------- Rutas de USDT ----------
async function rutaUsdt(req, env, ruta, url) {
  const correoValido = (c) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c || '');

  if (ruta === '/api/usdt/orden' && req.method === 'POST') {
    let cuerpo; try { cuerpo = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
    const correo = String(cuerpo.correo || '').toLowerCase().trim();
    const monto = Math.round(parseFloat(cuerpo.monto) * 100) / 100;
    if (!correoValido(correo)) return json({ mensaje: 'Correo no válido' }, 400);
    if (!(monto >= MONTO_MIN) || monto > 1000000) return json({ mensaje: 'El monto mínimo es ' + MONTO_MIN + ' USDT' }, 400);

    const fu = await env.DB.prepare("SELECT v FROM kv WHERE k = 'usuarios'").first();
    const lista = fu ? JSON.parse(fu.v) : [];
    const usuario = Array.isArray(lista) ? lista.find((x) => String(x.correo || '').toLowerCase().trim() === correo) : null;
    if (!usuario) return json({ mensaje: 'Tu cuenta aún no está sincronizada. Espera unos segundos e inténtalo otra vez.' }, 404);

    const ahora = Date.now();
    const { results: abiertas } = await env.DB.prepare(
      "SELECT * FROM pagos_usdt WHERE estado = 'pendiente' AND creado > ?"
    ).bind(ahora - VIGENCIA_MS).all();

    // Si ya tiene una orden abierta por el mismo monto, se reutiliza
    const igual = abiertas.find((o) => o.correo === correo && Math.abs(o.monto_base - monto) < 0.001);
    if (igual) return json({ orden: vistaOrden(igual, env) });
    // Las demás órdenes abiertas de este usuario se cancelan: solo puede tener una activa
    const mias = abiertas.filter((o) => o.correo === correo);
    if (mias.length) {
      await env.DB.prepare("UPDATE pagos_usdt SET estado = 'cancelada' WHERE estado = 'pendiente' AND correo = ?").bind(correo).run();
      for (const o of mias) { const i = abiertas.indexOf(o); if (i >= 0) abiertas.splice(i, 1); }
    }

    const usados = new Set(abiertas.map((o) => o.monto_unico));
    let unico = null;
    for (let i = 0; i < 60 && !unico; i++) {
      const k = 1 + Math.floor(Math.random() * 999); // +0.0001 a +0.0999
      const cand = (Math.round(monto * 10000) + k) / 10000;
      const txt = cand.toFixed(4);
      if (!usados.has(txt)) unico = txt;
    }
    if (!unico) return json({ mensaje: 'Intenta de nuevo en unos segundos.' }, 503);

    let bloque = null;
    try { bloque = parseInt(await rpc('eth_blockNumber', []), 16); } catch (e) { /* se calcula luego */ }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.DB.prepare(
      "INSERT INTO pagos_usdt (id, correo, usuario, monto_base, monto_unico, estado, creado, bloque_ini) VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?)"
    ).bind(id, correo, usuario.nombre || correo, monto, unico, ahora, bloque).run();
    const fila = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(id).first();
    return json({ orden: vistaOrden(fila, env) });
  }

  if (ruta === '/api/usdt/cancelar' && req.method === 'POST') {
    let cuerpo; try { cuerpo = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
    const id = String(cuerpo.id || '');
    const fila = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(id).first();
    if (!fila) return json({ mensaje: 'Orden no encontrada' }, 404);
    if (fila.estado === 'acreditado') return json({ resultado: 'acreditado', mensaje: 'Ese pago ya fue acreditado.' });
    if (fila.estado !== 'pendiente' || fila.creado + VIGENCIA_MS < Date.now()) return json({ resultado: 'expirada', mensaje: 'La orden ya venció.' });
    await env.DB.prepare("UPDATE pagos_usdt SET estado = 'cancelada' WHERE id = ? AND estado = 'pendiente'").bind(id).run();
    return json({ resultado: 'cancelada' });
  }

  if (ruta === '/api/usdt/revisar' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    let fila = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(id).first();
    if (!fila) return json({ mensaje: 'Orden no encontrada' }, 404);
    if (fila.estado === 'pendiente' && fila.creado + VIGENCIA_MS < Date.now()) {
      await limpiar(env);
      fila = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(id).first();
    }
    if (fila.estado === 'pendiente' && Date.now() - ultimoEscaneo > 3000) {
      ultimoEscaneo = Date.now();
      try { await escanear(env, false); } catch (e) { /* el nodo falló: se reintenta en la próxima */ }
      fila = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(id).first();
    }
    return json({ orden: vistaOrden(fila, env) });
  }

  if (ruta === '/api/usdt/txid' && req.method === 'POST') {
    let cuerpo; try { cuerpo = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
    const txid = String(cuerpo.txid || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txid)) return json({ mensaje: 'Ese TxID no es válido (debe empezar con 0x y tener 66 caracteres).' }, 400);
    const orden = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(String(cuerpo.id || '')).first();
    if (!orden) return json({ mensaje: 'Orden no encontrada' }, 404);
    if (orden.estado === 'acreditado') return json({ resultado: 'acreditado', orden: vistaOrden(orden, env) });
    if (orden.estado !== 'pendiente' || orden.creado + VIGENCIA_MS < Date.now()) return json({ resultado: 'expirada', mensaje: 'Esa orden ya venció (5 minutos).' });

    const usada = await env.DB.prepare('SELECT id FROM pagos_usdt WHERE txid = ?').bind(txid).first();
    if (usada) return json({ resultado: 'repetido', mensaje: 'Ese TxID ya fue usado.' });

    let recibo;
    try { recibo = await rpc('eth_getTransactionReceipt', [txid]); }
    catch (e) { return json({ resultado: 'error_red', mensaje: 'No pude consultar la red ahora. Intenta de nuevo.' }, 503); }
    if (!recibo) return json({ resultado: 'pendiente', mensaje: 'La transferencia aún no aparece en la red. Espera un momento.' });
    if (recibo.status !== '0x1') return json({ resultado: 'fallida', mensaje: 'Esa transferencia falló en la red.' });

    const miDireccion = relleno(direccionDe(env));
    const esperado = unidades(orden.monto_unico);
    let encontrado = null;
    for (const lg of recibo.logs || []) {
      if (String(lg.address).toLowerCase() !== CONTRATO_USDT) continue;
      if (!lg.topics || lg.topics[0] !== TOPIC_TRANSFER || String(lg.topics[2]).toLowerCase() !== miDireccion) continue;
      const cant = BigInt(lg.data);
      if (cant === esperado) { encontrado = cant; break; }
    }
    if (encontrado === null) {
      return json({ resultado: 'no_coincide', mensaje: 'La transferencia no coincide con el monto exacto de esta orden.' });
    }
    const cabeza = parseInt(await rpc('eth_blockNumber', []), 16);
    if (cabeza - parseInt(recibo.blockNumber, 16) < CONFIRMACIONES) {
      return json({ resultado: 'pendiente', mensaje: 'Casi listo: esperando confirmaciones.' });
    }
    const ok = await acreditar(env, orden, txid, encontrado);
    const fila = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(orden.id).first();
    return json({ resultado: ok ? 'acreditado' : 'pendiente', orden: vistaOrden(fila, env) });
  }

  return json({ mensaje: 'Ruta no encontrada' }, 404);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const ruta = url.pathname;

    if (ruta.startsWith('/api/usdt/')) {
      try { return await rutaUsdt(req, env, ruta, url); }
      catch (e) { return json({ mensaje: 'Error interno: ' + (e && e.message ? e.message : e) }, 500); }
    }

    if (ruta === '/api/version' && req.method === 'GET') {
      const fila = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ver'").first();
      return json({ ver: fila ? fila.v : '0' });
    }

    if (ruta !== '/api/state') return json({ mensaje: 'Ruta no encontrada' }, 404);

    if (req.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT k, v FROM kv WHERE k IN (?, ?, ?)').bind(...CLAVES).all();
      const record = { usuarios: [], solicitudes: { recargas: [], depositos: [] }, config: {} };
      for (const fila of results) record[fila.k] = JSON.parse(fila.v);
      return json({ record });
    }

    if (req.method === 'PUT') {
      if (env.CLAVE_ESCRITURA && req.headers.get('X-Clave') !== env.CLAVE_ESCRITURA) return json({ mensaje: 'No autorizado' }, 401);
      let cuerpo;
      try { cuerpo = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
      const sentencias = CLAVES
        .filter((k) => cuerpo[k] !== undefined)
        .map((k) => env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(cuerpo[k])));
      sentencias.push(env.DB.prepare("INSERT INTO kv (k, v) VALUES ('ver', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(Date.now())));
      if (sentencias.length) await env.DB.batch(sentencias);
      return json({ ok: true });
    }

    return json({ mensaje: 'Método no permitido' }, 405);
  },

  // Cada minuto: revisa pagos nuevos aunque nadie tenga la tienda abierta
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await escanear(env, true); } catch (e) { /* se reintenta al minuto siguiente */ }
      try { await limpiar(env); } catch (e) {}
    })());
  },
};
