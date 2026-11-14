// Lester Tienda: API en Cloudflare Workers + D1  (versión 5: montos únicos mínimos + verificación de wallet)
// - /api/state              -> igual que siempre (la tienda guarda y lee todo aquí)
// - /api/usdt/orden         -> crea una orden de depósito con un monto único (ej. 10.0137)
// - /api/usdt/revisar       -> mira la blockchain (BSC) y acredita el saldo si ya llegó el pago
// - /api/usdt/cancelar      -> cancela una orden en espera
// - /api/usdt/txid          -> verifica una transferencia por su TxID (plan B, instantáneo)
// - /api/usdt/verificar     -> reporte manual: comprueba que el TxID llegó A TU wallet antes de aceptarlo
// - cron (cada minuto)      -> revisa los pagos aunque el cliente haya cerrado la tienda
// - /api/sms/entrada      -> recibe los SMS reenviados desde tu teléfono (saldo móvil automático)
// - /api/saldo/*            -> órdenes de saldo móvil: crear, subir captura, estado
// Todo gratis: usa nodos públicos de BSC (sin clave) y la base D1 que ya tienes.

// Páginas que pueden usar este Worker desde un navegador. Cualquier otra página queda bloqueada.
// Si algún día usas un dominio propio, agrégalo aquí (ej. 'https://tutienda.com') y cambia ORIGEN_PRINCIPAL.
const ORIGENES_PERMITIDOS = ['https://lestertienda.github.io'];
const ORIGEN_PRINCIPAL = 'https://lestertienda.github.io';
const CORS = {
  'Access-Control-Allow-Origin': ORIGEN_PRINCIPAL,
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Clave, X-Admin',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
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
const MONTO_MIN = 0.5;

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
  const prLT = await preciosLT(env);

  const okUsuario = await editarKv(env, 'usuarios', (lista) => {
    if (!Array.isArray(lista)) return null;
    const u = lista.find((x) => String(x.correo || '').toLowerCase().trim() === correo);
    if (!u) return null;
    if (u.balanceCUP === undefined) u.balanceCUP = 0;
    const antes = u.balanceUSDT === undefined ? (u.balance || 0) : u.balanceUSDT;
    u.balanceUSDT = parseFloat((antes + monto / prLT.usdt).toFixed(2)); // ORO LT
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
    // Solo se suma 0.0001 a 0.0004 (ej. 2.4 -> 2.4003). Si esos 4 ya están ocupados, usa 0.0005 a 0.0009. Nunca llega a 0.0010.
    const libre = (k) => !usados.has(((Math.round(monto * 10000) + k) / 10000).toFixed(4));
    let unico = null;
    for (const grupo of [[1, 2, 3, 4], [5, 6, 7, 8, 9]]) {
      const libres = grupo.filter(libre);
      if (libres.length) {
        const k = libres[Math.floor(Math.random() * libres.length)];
        unico = ((Math.round(monto * 10000) + k) / 10000).toFixed(4);
        break;
      }
    }
    if (!unico) return json({ mensaje: 'Hay muchos pagos de ese monto ahora mismo. Prueba con otro monto o espera un minuto.' }, 503);

    let bloque = null;
    try { bloque = parseInt(await rpc('eth_blockNumber', []), 16); } catch (e) { /* se calcula luego */ }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await env.DB.prepare(
      "INSERT INTO pagos_usdt (id, correo, usuario, monto_base, monto_unico, estado, creado, bloque_ini) VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?)"
    ).bind(id, correo, usuario.nombre || correo, monto, unico, ahora, bloque).run();
    const fila = await env.DB.prepare('SELECT * FROM pagos_usdt WHERE id = ?').bind(id).first();
    return json({ orden: vistaOrden(fila, env) });
  }

  // Reporte manual: confirma en la blockchain que el TxID llegó a TU wallet, en USDT BEP20, y lo reserva (1 sola vez)
  if (ruta === '/api/usdt/verificar' && req.method === 'POST') {
    let cuerpo; try { cuerpo = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
    const txid = String(cuerpo.txid || '').trim().toLowerCase();
    const correo = String(cuerpo.correo || '').toLowerCase().trim();
    if (!/^0x[0-9a-f]{64}$/.test(txid)) return json({ resultado: 'invalido', mensaje: 'Ese ID no es válido (debe empezar con 0x y tener 66 caracteres).' }, 400);
    if (!correoValido(correo)) return json({ resultado: 'invalido', mensaje: 'Correo no válido' }, 400);

    const usada = await env.DB.prepare('SELECT id FROM pagos_usdt WHERE txid = ?').bind(txid).first();
    if (usada) return json({ resultado: 'repetido', mensaje: 'Ese ID de transferencia ya fue usado.' });
    const fs = await env.DB.prepare("SELECT v FROM kv WHERE k = 'solicitudes'").first();
    if (fs && String(fs.v).toLowerCase().includes(txid)) return json({ resultado: 'repetido', mensaje: 'Ese ID de transferencia ya fue reportado.' });

    let recibo;
    try { recibo = await rpc('eth_getTransactionReceipt', [txid]); }
    catch (e) { return json({ resultado: 'error_red', mensaje: 'No pude consultar la red ahora. Intenta de nuevo.' }, 503); }
    if (!recibo) return json({ resultado: 'pendiente', mensaje: 'La transferencia aún no aparece en la red. Espera un momento.' });
    if (recibo.status !== '0x1') return json({ resultado: 'fallida', mensaje: 'Esa transferencia falló en la red.' });

    const mia = relleno(direccionDe(env));
    let cant = null;
    for (const lg of recibo.logs || []) {
      if (String(lg.address).toLowerCase() !== CONTRATO_USDT) continue;                 // solo USDT BEP20
      if (!lg.topics || lg.topics[0] !== TOPIC_TRANSFER) continue;
      if (String(lg.topics[2]).toLowerCase() !== mia) continue;                          // solo si el destino es TU wallet
      cant = (cant || 0n) + BigInt(lg.data);
    }
    if (cant === null) return json({ resultado: 'otra_wallet', mensaje: 'Esa transferencia NO llegó a la wallet de Lester Tienda (o no es USDT BEP20).' });

    const monto = Math.floor(Number(cant / (10n ** 14n)) / 100) / 100; // a 2 decimales hacia abajo
    if (monto < MONTO_MIN) return json({ resultado: 'monto_bajo', mensaje: 'El monto recibido es menor al mínimo (' + MONTO_MIN + ' USDT).' });
    const cabeza = parseInt(await rpc('eth_blockNumber', []), 16);
    if (cabeza - parseInt(recibo.blockNumber, 16) < CONFIRMACIONES) return json({ resultado: 'pendiente', mensaje: 'Casi listo: esperando confirmaciones de la red.' });

    try {
      await env.DB.prepare("INSERT INTO pagos_usdt (id, correo, usuario, monto_base, monto_unico, estado, creado, txid, recibido) VALUES (?, ?, ?, ?, ?, 'reportado', ?, ?, ?)")
        .bind(crypto.randomUUID().replace(/-/g, '').slice(0, 16), correo, correo, monto, monto.toFixed(4), Date.now(), txid, cant.toString()).run();
    } catch (e) { return json({ resultado: 'repetido', mensaje: 'Ese ID de transferencia ya fue usado.' }); }
    return json({ resultado: 'valido', monto, txid });
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


// =====================================================================
//  G2BULK  (proveedor de recargas)  -  Free Fire, Blood Strike, Roblox, Call of Duty Mobile, Arena Breakout
//  Las claves NO van en el código. Se guardan como Secrets del Worker:
//     G2BULK_API_KEY          (tu clave g2b_...)
//     G2BULK_WEBHOOK_SECRET   (tu firma whsec_...)
//     CLAVE_ESCRITURA         (ya la usas; también protege las rutas de admin de G2)
//  Opcionales: G2_CODE_FREEFIRE, G2_CODE_BLOOD, G2_CODE_ROBLOX, G2_CODE_CODM (forzar código de juego),
//              G2_MAPA (JSON para forzar qué denominación corresponde a cada paquete), G2_MARGEN (ej. 0.15)
// =====================================================================
const G2_BASE = 'https://api.g2bulk.com';
const G2_MARGEN = 0.15; // si el proveedor sube $1, la web sube $1.15 (se puede cambiar con la variable G2_MARGEN)
const CAMPO_JUEGO = { freefire: 'paquetesDiamantes', blood: 'paquetesBlood', roblox: 'paquetesRoblox', codm: 'paquetesCodm', arenabreakout: 'paquetesArena' };
const NOMBRE_A_CLAVE = { 'Free Fire': 'freefire', 'Blood Strike': 'blood', 'Roblox': 'roblox', 'Call of Duty Mobile': 'codm', 'Arena Breakout': 'arenabreakout' };
const PATRON_JUEGO = { freefire: /free\s*fire/i, blood: /blood\s*strike/i, roblox: /roblox/i, codm: /call\s*of\s*duty|\bcodm\b/i, arenabreakout: /arena\s*breakout/i };

const PAQ_DEFECTO = {
  paquetesBlood: [
                      { id: 1, nombre: '51 BC', diamantesNum: 51, precioUsdt: 0.78, precioSaldo: 200, textoDetalle: '51', imagen: '', ik: 0 },
                      { id: 2, nombre: '105 BC', diamantesNum: 105, precioUsdt: 1.2, precioSaldo: 320, textoDetalle: '105', imagen: '', ik: 1 },
                      { id: 3, nombre: '320 BC', diamantesNum: 320, precioUsdt: 2.8, precioSaldo: 950, textoDetalle: '320', imagen: '', ik: 2 },
                      { id: 4, nombre: '540 BC', diamantesNum: 540, precioUsdt: 4.7, precioSaldo: 1800, textoDetalle: '540', imagen: '', ik: 3 },
                      { id: 5, nombre: '1100 BC', diamantesNum: 1100, precioUsdt: 9.0, precioSaldo: 3200, textoDetalle: '1100', imagen: '', ik: 4 },
                      { id: 6, nombre: '2260 BC', diamantesNum: 2260, precioUsdt: 18, precioSaldo: 6000, textoDetalle: '2260', imagen: '', ik: 5 },
                      { id: 7, nombre: '5800 BC', diamantesNum: 5800, precioUsdt: 45, precioSaldo: 15000, textoDetalle: '5800', imagen: '', ik: 6 }
                  ],
                  paquetesArena: [
                      { id: 1, nombre: '66 Bonds', diamantesNum: 66, precioUsdt: 0.91, precioSaldo: 350, textoDetalle: '66', imagen: '', ik: 0 },
                      { id: 2, nombre: '335 Bonds', diamantesNum: 335, precioUsdt: 4.52, precioSaldo: 1750, textoDetalle: '335', imagen: '', ik: 1 },
                      { id: 3, nombre: '675 Bonds', diamantesNum: 675, precioUsdt: 8.7, precioSaldo: 3350, textoDetalle: '675', imagen: '', ik: 2 },
                      { id: 4, nombre: '1690 Bonds', diamantesNum: 1690, precioUsdt: 21.7, precioSaldo: 8350, textoDetalle: '1690', imagen: '', ik: 3 },
                      { id: 5, nombre: '3400 Bonds', diamantesNum: 3400, precioUsdt: 44, precioSaldo: 16950, textoDetalle: '3400', imagen: '', ik: 4 },
                      { id: 6, nombre: '6820 Bonds', diamantesNum: 6820, precioUsdt: 87, precioSaldo: 33500, textoDetalle: '6820', imagen: '', ik: 5 }
                  ],
                  paquetesCodm: [
                      { id: 1, nombre: '115 CP', diamantesNum: 115, precioUsdt: 2, precioSaldo: 750, textoDetalle: '115', imagen: '', ik: 0 },
                      { id: 2, nombre: '253 CP', diamantesNum: 253, precioUsdt: 3, precioSaldo: 1150, textoDetalle: '253', imagen: '', ik: 1 },
                      { id: 3, nombre: '529 CP', diamantesNum: 529, precioUsdt: 5.1, precioSaldo: 1950, textoDetalle: '529', imagen: '', ik: 2 },
                      { id: 4, nombre: '794 CP', diamantesNum: 794, precioUsdt: 8.2, precioSaldo: 3150, textoDetalle: '794', imagen: '', ik: 3 },
                      { id: 5, nombre: '1053 CP', diamantesNum: 1053, precioUsdt: 10.3, precioSaldo: 3900, textoDetalle: '1053', imagen: '', ik: 4 },
                      { id: 6, nombre: '1323 CP', diamantesNum: 1323, precioUsdt: 13.3, precioSaldo: 5150, textoDetalle: '1323', imagen: '', ik: 5 }
                  ],
                  paquetesRoblox: [
                      { id: 1, nombre: '800 Robux', diamantesNum: 800, precioUsdt: 11.3, precioSaldo: 4000, textoDetalle: '800', imagen: '', ik: 0 },
                      { id: 2, nombre: '1000 Robux', diamantesNum: 1000, precioUsdt: 13.3, precioSaldo: 4800, textoDetalle: '1000', imagen: '', ik: 1 },
                      { id: 3, nombre: '1500 Robux', diamantesNum: 1500, precioUsdt: 22.1, precioSaldo: 7700, textoDetalle: '1500', imagen: '', ik: 2 },
                      { id: 4, nombre: '2000 Robux', diamantesNum: 2000, precioUsdt: 27.8, precioSaldo: 9300, textoDetalle: '2000', imagen: '', ik: 3 },
                      { id: 5, nombre: '2500 Robux', diamantesNum: 2500, precioUsdt: 33.6, precioSaldo: 11000, textoDetalle: '2500', imagen: '', ik: 4 },
                      { id: 6, nombre: '3000 Robux', diamantesNum: 3000, precioUsdt: 38.91, precioSaldo: 13300, textoDetalle: '3000', imagen: '', ik: 5 }
                  ],
                  paquetesDiamantes: [
                      { id: 1, nombre: '100+10 Diamantes', diamantesNum: 110, precioUsdt: 1.1, precioSaldo: 300, textoDetalle: '100+10', imagen: '' },
                      { id: 2, nombre: '310+51 Diamantes', diamantesNum: 361, precioUsdt: 3.5, precioSaldo: 850, textoDetalle: '310+51', imagen: '' },
                      { id: 3, nombre: '520+52 Diamantes', diamantesNum: 572, precioUsdt: 5.0, precioSaldo: 2100, textoDetalle: '520+52', imagen: '' },
                      { id: 4, nombre: '1050+105 Diamantes', diamantesNum: 1166, precioUsdt: 8.5, precioSaldo: 3300, textoDetalle: '1050+105', imagen: '' },
                      { id: 5, nombre: '2160+216 Diamantes', diamantesNum: 2398, precioUsdt: 17.4, precioSaldo: 5300, textoDetalle: '2160+216', imagen: '' },
                      { id: 6, nombre: '5580+558 Diamantes', diamantesNum: 6160, precioUsdt: 40.0, precioSaldo: 12300, textoDetalle: '5580+558', imagen: '' }
                  ]
};

// Ofertas extra de Free Fire (membresías y pase). Se emparejan con G2Bulk por el nombre (patron).
const PAQ_EXTRAS = [
  { id: 101, nombre: 'Membresía semanal', diamantesNum: 0, precioUsdt: 2.7, precioSaldo: 880, textoDetalle: 'Semanal', unidad: 'Membresía', imagen: '', extra: true, patron: 'weekly(?!.*lite)' },
  { id: 102, nombre: 'Membresía mensual', diamantesNum: 0, precioUsdt: 10, precioSaldo: 3250, textoDetalle: 'Mensual', unidad: 'Membresía', imagen: '', extra: true, patron: 'monthly(?!.*lite)' },
  { id: 103, nombre: 'Pase Booyah', diamantesNum: 0, precioUsdt: 3.8, precioSaldo: 1240, textoDetalle: 'Pase Booyah', unidad: 'Booyah Pass', imagen: '', extra: true, patron: 'booyah' }
];
function paquetesPedido(cfg, clave) {
  const extras = clave === 'freefire' ? ((cfg && Array.isArray(cfg.paquetesExtras) && cfg.paquetesExtras.length) ? cfg.paquetesExtras : PAQ_EXTRAS) : [];
  return paquetesDe(cfg, clave).concat(extras);
}

let g2TablasListas = false;
let g2CacheJuegos = { t: 0, lista: [] };
const g2CacheCat = new Map();
const g2CacheId = new Map();

async function g2Tablas(env) {
  if (g2TablasListas) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS g2_ordenes (recarga_id TEXT PRIMARY KEY, g2_order_id INTEGER, juego TEXT, estado TEXT, creado INTEGER)').run();
  g2TablasListas = true;
}

async function g2(env, ruta, opciones = {}) {
  if (!env.G2BULK_API_KEY) throw new Error('Falta el secret G2BULK_API_KEY');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(G2_BASE + ruta, {
      method: opciones.method || 'GET', signal: ctl.signal,
      headers: { 'X-API-Key': env.G2BULK_API_KEY, 'Content-Type': 'application/json', ...(opciones.headers || {}) },
      body: opciones.body ? JSON.stringify(opciones.body) : undefined,
    });
    let data = null; try { data = await r.json(); } catch (e) { /* sin cuerpo */ }
    return { status: r.status, data: data || {} };
  } finally { clearTimeout(t); }
}

async function g2Candidatos(env, clave) {
  const forzado = env['G2_CODE_' + clave.toUpperCase()];
  if (forzado) return String(forzado).split(',').map((s) => s.trim()).filter(Boolean);
  if (Date.now() - g2CacheJuegos.t > 10 * 60 * 1000 || !g2CacheJuegos.lista.length) {
    const r = await g2(env, '/v1/games');
    if (r.status === 200 && Array.isArray(r.data.games)) g2CacheJuegos = { t: Date.now(), lista: r.data.games };
  }
  const cand = g2CacheJuegos.lista.filter((j) => PATRON_JUEGO[clave].test(j.name || '') || PATRON_JUEGO[clave].test(j.code || ''));
  cand.sort((x, y) => (/latam/i.test(y.name || '') ? 1 : 0) - (/latam/i.test(x.name || '') ? 1 : 0));
  return cand.slice(0, 4).map((j) => j.code);
}
async function g2Codigo(env, clave) { return (await g2Candidatos(env, clave))[0] || null; }

async function g2Catalogo(env, code, fresco) {
  const c = g2CacheCat.get(code);
  if (!fresco && c && Date.now() - c.t < 2 * 60 * 1000) return c.lista;
  const r = await g2(env, '/v1/games/' + encodeURIComponent(code) + '/catalogue');
  if (r.status !== 200 || !Array.isArray(r.data.catalogues)) throw new Error('catálogo G2 no disponible (' + r.status + ')');
  g2CacheCat.set(code, { t: Date.now(), lista: r.data.catalogues });
  return r.data.catalogues;
}

// "100+10 Diamantes" -> 110 ; "800 Robux" -> 800
function claveNum(nombre) {
  const txt = String(nombre || '').replace(/(\d)[.,](\d{3})/g, '$1$2');
  const n = txt.match(/\d+/g);
  if (!n) return null;
  return txt.includes('+') ? n.reduce((a, b) => a + Number(b), 0) : Number(n[0]);
}
function emparejar(env, clave, pkg, catalogo) {
  try {
    const mapa = env.G2_MAPA ? JSON.parse(env.G2_MAPA) : null;
    const forzado = mapa && mapa[clave] && mapa[clave][pkg.id];
    if (forzado) return catalogo.find((c) => c.name === forzado) || null;
  } catch (e) { /* G2_MAPA mal escrito: se ignora */ }
  if (pkg.patron) { // membresías / pase: se buscan por nombre
    let re; try { re = new RegExp(pkg.patron, 'i'); } catch (e) { return null; }
    const l = catalogo.filter((c) => re.test(c.name));
    return l.length ? l.sort((a, b) => a.amount - b.amount)[0] : null;
  }
  const iguales = catalogo.filter((c) => claveNum(c.name) === Number(pkg.diamantesNum));
  if (!iguales.length) return null;
  return iguales.sort((a, b) => a.amount - b.amount)[0];
}

// Precios de ORO LT (1 ORO LT = X). Se cambian desde el panel CEO.
async function preciosLT(env) {
  const p = (await leerKv(env, 'precios_lt')) || {};
  const n = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return { usdt: n(p.usdt, 1), saldo: n(p.saldo, 325), cup: n(p.cup, 0) };
}

async function leerKv(env, k) {
  const f = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return f ? JSON.parse(f.v) : null;
}
async function guardarKv(env, k, valor) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(valor)).run();
}
function paquetesDe(cfg, clave) {
  const campo = CAMPO_JUEGO[clave];
  return (cfg && Array.isArray(cfg[campo]) && cfg[campo].length) ? cfg[campo] : JSON.parse(JSON.stringify(PAQ_DEFECTO[campo]));
}

// ---------- Validar ID de jugador (devuelve el nombre real de la cuenta) ----------
async function g2BuscarJugador(env, clave, id, server) {
  const ck = clave + ':' + id + ':' + server;
  const previo = g2CacheId.get(ck);
  if (previo && Date.now() - previo.t < 5 * 60 * 1000) return previo.r;
  const codes = await g2Candidatos(env, clave);
  if (!codes.length) return { estado: 'sin_proveedor' };
  let hayError = false;
  for (const code of codes) {
    const body = { game: code, user_id: id };
    if (server) body.server_id = server;
    let r;
    try { r = await g2(env, '/v1/games/checkPlayerId', { method: 'POST', body }); } catch (e) { hayError = true; continue; }
    if (r.status === 200 && r.data.valid === 'valid') {
      const res = { estado: 'valido', nombre: String(r.data.name || ''), code };
      g2CacheId.set(ck, { t: Date.now(), r: res });
      return res;
    }
    if (!(r.status === 200 || r.status === 400 || r.status === 404 || r.status === 422)) hayError = true;
  }
  if (hayError) return { estado: 'error' }; // 401, 429, 5xx: no se bloquea al cliente
  const res = { estado: 'invalido' };
  g2CacheId.set(ck, { t: Date.now(), r: res });
  return res;
}
async function g2Validar(env, cuerpo) {
  const clave = String(cuerpo.juego || '');
  const id = String(cuerpo.id || '').trim();
  if (!CAMPO_JUEGO[clave] || clave === 'roblox') return { estado: 'omitido' };
  if (!/^[0-9]{5,25}$/.test(id)) return { estado: 'invalido' };
  const r = await g2BuscarJugador(env, clave, id, String(cuerpo.server || ''));
  return r.estado === 'valido' ? { estado: 'valido', nombre: r.nombre } : { estado: r.estado };
}

// ---------- Cerrar una recarga de la tienda (completada o fallida con reembolso) ----------
async function g2Finalizar(env, recargaId, ok) {
  let reembolso = null;
  await editarKv(env, 'solicitudes', (s) => {
    reembolso = null;
    if (!s || !Array.isArray(s.recargas)) return null;
    const rec = s.recargas.find((r) => String(r.id) === String(recargaId));
    if (!rec || rec.estado === 'Completado' || rec.estado === 'Cancelado') return null;
    rec.estado = ok ? 'Completado' : 'Cancelado';
    rec.actualizado = Date.now();
    rec.auto = true;
    if (!ok && !rec.reembolsado) {
      rec.reembolsado = true;
      reembolso = { correo: String(rec.correo || '').toLowerCase().trim(), precio: parseFloat(rec.precio) || 0, moneda: rec.moneda };
    }
    return s;
  });
  if (reembolso && reembolso.precio > 0) {
    await editarKv(env, 'usuarios', (lista) => {
      if (!Array.isArray(lista)) return null;
      const u = lista.find((x) => String(x.correo || '').toLowerCase().trim() === reembolso.correo);
      if (!u) return null;
      if (reembolso.moneda === 'usdt') {
        const antes = u.balanceUSDT === undefined ? (u.balance || 0) : u.balanceUSDT;
        u.balanceUSDT = parseFloat((antes + reembolso.precio).toFixed(2));
        u.balance = u.balanceUSDT;
      } else {
        u.balanceCUP = Math.round((u.balanceCUP || 0) + reembolso.precio);
      }
      u.recargasCount = Math.max(0, (u.recargasCount || 0) - 1);
      return lista;
    });
  }
  await marcarCambio(env);
}

// ---------- Enviar la recarga al proveedor ----------
async function g2Pedir(env, origen, cuerpo) {
  await g2Tablas(env);
  const recargaId = String(cuerpo.id || '');
  const correo = String(cuerpo.correo || '').toLowerCase().trim();
  const sol = await leerKv(env, 'solicitudes');
  const rec = sol && Array.isArray(sol.recargas) ? sol.recargas.find((r) => String(r.id) === recargaId) : null;
  if (!rec || String(rec.correo || '').toLowerCase().trim() !== correo) return { resultado: 'no_encontrada' };
  if (rec.estado !== 'Pendiente') return { resultado: 'no_pendiente' };
  const clave = NOMBRE_A_CLAVE[rec.juego];
  if (!clave) return { resultado: 'manual', mensaje: 'Juego sin proveedor' };

  let code;
  if (clave === 'roblox') code = await g2Codigo(env, clave);
  else {
    const b = await g2BuscarJugador(env, clave, String(rec.idJugador), '');
    if (b.estado === 'invalido') return { resultado: 'manual', mensaje: 'ID de jugador no válido' };
    code = b.code || await g2Codigo(env, clave);
  }
  if (!code) return { resultado: 'manual', mensaje: 'Juego no disponible en G2Bulk' };
  const pkg = paquetesPedido(await leerKv(env, 'config'), clave).find((p) => String(p.id) === String(rec.paqueteId));
  if (!pkg) return { resultado: 'manual', mensaje: 'Paquete no encontrado' };
  const entrada = emparejar(env, clave, pkg, await g2Catalogo(env, code, true));
  if (!entrada) return { resultado: 'manual', mensaje: 'Sin equivalente en G2Bulk' };

  // Protección: nunca se compra si el costo supera lo que pagó el cliente
  const venta = rec.moneda === 'usdt' ? Number(rec.precio) : Number(pkg.precioUsdt);
  if (!(venta >= entrada.amount)) return { resultado: 'manual', mensaje: 'Costo mayor al precio de venta' };

  const reclamo = await env.DB.prepare("INSERT OR IGNORE INTO g2_ordenes (recarga_id, juego, estado, creado) VALUES (?, ?, 'creando', ?)")
    .bind(recargaId, clave + '|' + code, Date.now()).run();
  if (!reclamo.meta || reclamo.meta.changes !== 1) return { resultado: 'ya_enviada' };

  let r;
  try {
    r = await g2(env, '/v1/games/' + encodeURIComponent(code) + '/order', {
      method: 'POST', headers: { 'X-Idempotency-Key': 'lt-' + recargaId },
      body: { catalogue_name: entrada.name, player_id: String(rec.idJugador), remark: 'lt-' + recargaId, callback_url: origen + '/api/g2/webhook' },
    });
  } catch (e) { r = { status: 0, data: { message: 'sin respuesta de G2Bulk' } }; }

  if (r.status === 200 && r.data.success && r.data.order) {
    const o = r.data.order;
    await env.DB.prepare('UPDATE g2_ordenes SET g2_order_id = ?, estado = ? WHERE recarga_id = ?').bind(o.order_id, o.status, recargaId).run();
    await editarKv(env, 'solicitudes', (s) => {
      const x = s && Array.isArray(s.recargas) ? s.recargas.find((q) => String(q.id) === recargaId) : null;
      if (!x) return null; x.g2Id = o.order_id; return s;
    });
    if (o.status === 'COMPLETED') await g2Finalizar(env, recargaId, true);
    else if (o.status === 'FAILED') await g2Finalizar(env, recargaId, false);
    await marcarCambio(env);
    return { resultado: 'enviada', estado: o.status };
  }
  // No se pudo (saldo insuficiente, ID inválido...): se libera el reclamo y queda manual
  await env.DB.prepare('DELETE FROM g2_ordenes WHERE recarga_id = ? AND g2_order_id IS NULL').bind(recargaId).run();
  return { resultado: 'manual', mensaje: String(r.data.message || 'rechazada por G2Bulk') };
}

// ---------- Firma del webhook ----------
function igualesSeguro(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function firmaValida(secreto, id, ts, cuerpo, cabecera) {
  const enc = new TextEncoder();
  const msg = enc.encode(id + '.' + ts + '.' + cuerpo);
  const sin = secreto.replace(/^whsec_/, '');
  const claves = [enc.encode(secreto), enc.encode(sin)];
  try { claves.push(Uint8Array.from(atob(sin), (c) => c.charCodeAt(0))); } catch (e) { /* no es base64 */ }
  const recibidas = String(cabecera || '').split(/[\s]+/).filter(Boolean).map((x) => x.replace(/^v1,/, ''));
  for (const k of claves) {
    const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const buf = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
    let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
    const esperada = btoa(bin);
    if (recibidas.some((r) => igualesSeguro(r, esperada))) return true;
  }
  return false;
}

async function g2Webhook(req, env) {
  const cuerpo = await req.text();
  const id = req.headers.get('webhook-id') || '';
  const ts = req.headers.get('webhook-timestamp') || '';
  if (!env.G2BULK_WEBHOOK_SECRET) return json({ mensaje: 'Falta G2BULK_WEBHOOK_SECRET' }, 401);
  if (!(await firmaValida(env.G2BULK_WEBHOOK_SECRET, id, ts, cuerpo, req.headers.get('webhook-signature')))) return json({ mensaje: 'Firma no válida' }, 401);
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return json({ mensaje: 'Marca de tiempo vencida' }, 401);
  let ev; try { ev = JSON.parse(cuerpo); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
  if (ev.event === 'ping' || !ev.order_id) return json({ ok: true });
  if (!/^topup\./.test(String(ev.event || ''))) return json({ ok: true });
  await g2Tablas(env);
  const fila = await env.DB.prepare('SELECT * FROM g2_ordenes WHERE g2_order_id = ?').bind(ev.order_id).first();
  if (!fila) return json({ ok: true });
  if (ev.status === 'COMPLETED' || ev.status === 'FAILED') {
    await env.DB.prepare('UPDATE g2_ordenes SET estado = ? WHERE recarga_id = ?').bind(ev.status, fila.recarga_id).run();
    await g2Finalizar(env, fila.recarga_id, ev.status === 'COMPLETED');
  }
  return json({ ok: true });
}

// ---------- Precios: si el proveedor sube, la web sube un poco más ----------
async function g2SincronizarPrecios(env) {
  const margen = env.G2_MARGEN !== undefined && env.G2_MARGEN !== '' ? Number(env.G2_MARGEN) : G2_MARGEN;
  const costos = (await leerKv(env, 'g2_costos')) || {};
  const informe = [];
  for (const clave of Object.keys(CAMPO_JUEGO)) {
    let code, cat;
    try { code = await g2Codigo(env, clave); if (!code) { informe.push({ juego: clave, nota: 'no está en G2Bulk' }); continue; } cat = await g2Catalogo(env, code, true); }
    catch (e) { informe.push({ juego: clave, nota: 'error: ' + e.message }); continue; }
    const campo = CAMPO_JUEGO[clave];
    const nuevosCostos = {}; let cambios = [];
    const aplicar = (cfg) => {
      cambios = [];
      cfg = cfg && typeof cfg === 'object' ? cfg : {};
      const arr = paquetesDe(cfg, clave);
      for (const p of arr) {
        const e = emparejar(env, clave, p, cat);
        if (!e) continue;
        const costo = Number(e.amount), previo = (costos[clave] || {})[p.id];
        nuevosCostos[p.id] = costo;
        let nuevo = Number(p.precioUsdt);
        if (previo !== undefined && costo > previo + 0.0001) nuevo = Math.ceil((nuevo + (costo - previo) * (1 + margen)) * 100) / 100;
        if (nuevo < costo * 1.05) nuevo = Math.ceil(costo * 1.1 * 100) / 100; // nunca vender por debajo del costo
        if (nuevo > Number(p.precioUsdt) + 0.0001) {
          const ratio = nuevo / Number(p.precioUsdt);
          cambios.push({ paquete: p.nombre, antes: p.precioUsdt, despues: nuevo, costo });
          p.precioSaldo = Math.round((Number(p.precioSaldo) * ratio) / 10) * 10;
          p.precioUsdt = nuevo;
        }
      }
      cfg[campo] = arr;
      return cambios.length ? cfg : null;
    };
    const cfgActual = await leerKv(env, 'config');
    aplicar(cfgActual); // para calcular cambios y costos
    if (cambios.length) {
      const ok = await editarKv(env, 'config', (cfg) => aplicar(cfg));
      if (!ok) { informe.push({ juego: clave, nota: 'no se pudo guardar, se reintenta' }); continue; }
      await marcarCambio(env);
    }
    costos[clave] = { ...(costos[clave] || {}), ...nuevosCostos };
    informe.push({ juego: clave, code, cambios });
  }
  await guardarKv(env, 'g2_costos', costos);
  await guardarKv(env, 'g2_ultimo', { t: Date.now(), informe });
  return informe;
}

// ---------- Respaldo: si un webhook no llegó, se consulta el estado ----------
async function g2Respaldo(env) {
  await g2Tablas(env);
  const { results } = await env.DB.prepare("SELECT * FROM g2_ordenes WHERE g2_order_id IS NOT NULL AND estado IN ('PENDING','PROCESSING') AND creado < ? LIMIT 5")
    .bind(Date.now() - 3 * 60 * 1000).all();
  for (const f of results || []) {
    try {
      const partes = String(f.juego).split('|');
      const code = partes[1] || await g2Codigo(env, partes[0]);
      const r = await g2(env, '/v1/games/order/status', { method: 'POST', body: { game: code, order_id: f.g2_order_id } });
      const st = r.data && r.data.order && r.data.order.status;
      if (st === 'COMPLETED' || st === 'FAILED') {
        await env.DB.prepare('UPDATE g2_ordenes SET estado = ? WHERE recarga_id = ?').bind(st, f.recarga_id).run();
        await g2Finalizar(env, f.recarga_id, st === 'COMPLETED');
      }
    } catch (e) { /* se reintenta */ }
  }
}

function esAdmin(req, env) { return !!env.CLAVE_ESCRITURA && req.headers.get('X-Clave') === env.CLAVE_ESCRITURA; }

async function rutaG2(req, env, ruta, url) {
  const leer = async () => { try { return await req.json(); } catch (e) { return null; } };
  if (ruta === '/api/g2/webhook' && req.method === 'POST') return await g2Webhook(req, env);
  if (ruta === '/api/g2/validar' && req.method === 'POST') {
    const c = await leer(); if (!c) return json({ mensaje: 'JSON no válido' }, 400);
    try { return json(await g2Validar(env, c)); } catch (e) { return json({ estado: 'error' }); }
  }
  if (ruta === '/api/g2/pedir' && req.method === 'POST') {
    const c = await leer(); if (!c) return json({ mensaje: 'JSON no válido' }, 400);
    return json(await g2Pedir(env, url.origin, c));
  }
  // ---- Admin (header X-Clave = CLAVE_ESCRITURA) ----
  if (!esAdmin(req, env)) return json({ mensaje: 'No autorizado' }, 401);
  if (ruta === '/api/g2/estado' && req.method === 'GET') {
    const me = await g2(env, '/v1/getMe');
    const juegos = {};
    for (const k of Object.keys(CAMPO_JUEGO)) { try { juegos[k] = await g2Codigo(env, k); } catch (e) { juegos[k] = 'error'; } }
    return json({ saldo_g2: me.data.balance, cuenta: me.data.username, juegos, ultimo_sync: await leerKv(env, 'g2_ultimo') });
  }
  if (ruta === '/api/g2/mapa' && req.method === 'GET') {
    const cfg = await leerKv(env, 'config'); const salida = {};
    for (const k of Object.keys(CAMPO_JUEGO)) {
      const code = await g2Codigo(env, k);
      if (!code) { salida[k] = 'no está en G2Bulk'; continue; }
      const cat = await g2Catalogo(env, code, true);
      salida[k] = { code, paquetes: paquetesDe(cfg, k).map((p) => { const e = emparejar(env, k, p, cat); return { paquete: p.nombre, venta: p.precioUsdt, g2: e ? e.name : null, costo: e ? e.amount : null }; }), catalogo_g2: cat.map((c) => c.name + ' = ' + c.amount) };
    }
    return json(salida);
  }
  if (ruta === '/api/g2/probar' && req.method === 'GET') {
    const clave = url.searchParams.get('juego') || 'freefire';
    const id = url.searchParams.get('id') || '';
    if (!CAMPO_JUEGO[clave]) return json({ mensaje: 'juego: freefire, blood, roblox, codm o arenabreakout' }, 400);
    const codes = await g2Candidatos(env, clave);
    const resultados = [];
    for (const code of codes) { const r = await g2(env, '/v1/games/checkPlayerId', { method: 'POST', body: { game: code, user_id: id } }); resultados.push({ code, http: r.status, respuesta: r.data }); }
    return json({ juego: clave, candidatos: codes, resultados, todos_los_juegos: g2CacheJuegos.lista.map((j) => j.code + ' = ' + j.name) });
  }
  if (ruta === '/api/g2/sincronizar' && req.method === 'POST') return json({ informe: await g2SincronizarPrecios(env) });
  return json({ mensaje: 'Ruta no encontrada' }, 404);
}


// =====================================================================
//  ADMIN SEGURO
//  El correo y la contraseña del admin NO están en el código ni en la base de datos.
//  Se guardan como Secrets del Worker (Cloudflare los cifra y nadie puede verlos):
//     ADMIN_EMAIL      (correo del admin)
//     ADMIN_PASSWORD   (contraseña del admin)
//  La página solo recibe un "pase" firmado cuando el login es correcto.
// =====================================================================
const ADMIN_TTL_MS = 30 * 24 * 3600 * 1000; // el pase dura 30 días
const ADMIN_MAX_FALLOS = 5;                 // intentos fallidos por IP
const ADMIN_BLOQUEO_MS = 10 * 60 * 1000;    // bloqueo de 10 minutos

function adminCorreo(env) { return String(env.ADMIN_EMAIL || '').toLowerCase().trim(); }

async function sha256Hex(texto) {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(texto))));
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function claveIgual(a, b) { return igualesSeguro(await sha256Hex(a), await sha256Hex(b)); }

async function firmarAdmin(env, texto) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(env.ADMIN_PASSWORD) + '|' + adminCorreo(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(texto)));
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function crearTokenAdmin(env) {
  const exp = Date.now() + ADMIN_TTL_MS;
  return exp + '.' + (await firmarAdmin(env, 'admin.' + exp));
}
async function tokenAdminValido(req, env) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return false;
  const [exp, fir] = String(req.headers.get('X-Admin') || '').split('.');
  if (!exp || !fir || !(Number(exp) > Date.now())) return false;
  return igualesSeguro(fir, await firmarAdmin(env, 'admin.' + exp));
}

// El admin nunca sale con contraseña en la lista pública y siempre es rango 2
function limpiarAdmin(lista, env) {
  const c = adminCorreo(env);
  if (!c || !Array.isArray(lista)) return lista;
  for (const u of lista) {
    if (u && String(u.correo || '').toLowerCase().trim() === c) { u.pass = ''; u.rango = 2; }
  }
  return lista;
}

async function rutaAdminLogin(req, env) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return json({ ok: false, motivo: 'sin_config' }, 401);
  let c; try { c = await req.json(); } catch (e) { return json({ ok: false }, 400); }
  const correo = String(c.correo || '').toLowerCase().trim();
  const pass = String(c.pass || '').trim();

  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  const kFallo = 'adm_fail:' + ip;
  const fallo = await leerKv(env, kFallo);
  if (fallo && fallo.n >= ADMIN_MAX_FALLOS && Date.now() - fallo.t < ADMIN_BLOQUEO_MS) return json({ ok: false, bloqueado: true }, 429);

  // El aviso "Acceso CEO" de la tienda solo pide la contraseña (soloPass); el inicio de sesión normal sí exige el correo.
  const okCorreo = c.soloPass === true ? true : await claveIgual(correo, adminCorreo(env));
  const okPass = await claveIgual(pass, String(env.ADMIN_PASSWORD).trim());
  if (!(okCorreo && okPass)) {
    const n = fallo && Date.now() - fallo.t < ADMIN_BLOQUEO_MS ? fallo.n + 1 : 1;
    await guardarKv(env, kFallo, { n, t: Date.now() });
    return json({ ok: false, motivo: 'datos' }, 401);
  }
  await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(kFallo).run();

  const lista = (await leerKv(env, 'usuarios')) || [];
  const hallado = Array.isArray(lista) ? lista.find((u) => String(u.correo || '').toLowerCase().trim() === adminCorreo(env)) : null;
  const usuario = hallado ? { ...hallado, pass: '', rango: 2 } : {
    nombre: 'Admin', correo: adminCorreo(env), pass: '', balanceUSDT: 0, balanceCUP: 0, balance: 0,
    recargasCount: 0, avatar: '', descuentosDisponibles: 0, rango: 2, nombreCompleto: '', telefono: '',
  };
  return json({ ok: true, token: await crearTokenAdmin(env), usuario });
}


// =====================================================================
//  CHAT DE SOPORTE  (usuario <-> CEO, dentro del chat de IA LT)
//  El usuario se identifica con su correo y contraseña (como en el login de la web).
//  Las rutas de administración funcionan con el pase del admin (X-Admin) o con un usuario de rango 2.
// =====================================================================
let chatTablaLista = false;
async function chatTabla(env) {
  if (chatTablaLista) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS chat_soporte (correo TEXT PRIMARY KEY, nombre TEXT, estado TEXT, msgs TEXT, upd INTEGER, na INTEGER DEFAULT 0, nu INTEGER DEFAULT 0)').run();
  chatTablaLista = true;
}
async function chatAuth(env, c, ceo) {
  const correo = String(c.correo || '').toLowerCase().trim();
  const pass = String(c.pass || '');
  if (!correo || !pass) return null;
  const lista = await leerKv(env, 'usuarios');
  if (!Array.isArray(lista)) return null;
  const u = lista.find((x) => String(x.correo || '').toLowerCase().trim() === correo && x.pass && x.pass === pass);
  if (!u) return null;
  if (ceo && u.rango !== 2) return null;
  return { correo, nombre: String(u.nombre || correo.split('@')[0]).slice(0, 40) };
}
function chatMsgs(f) { try { return JSON.parse((f && f.msgs) || '[]'); } catch (e) { return []; } }
function chatTexto(t) { return String(t || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 600); }
async function chatGuardar(env, f) {
  await env.DB.prepare('INSERT OR REPLACE INTO chat_soporte (correo, nombre, estado, msgs, upd, na, nu) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(f.correo, f.nombre, f.estado, JSON.stringify(f.msgs.slice(-200)), f.upd, f.na, f.nu).run();
}
async function chatFila(env, correo) {
  const f = await env.DB.prepare('SELECT * FROM chat_soporte WHERE correo = ?').bind(correo).first();
  return f ? { correo: f.correo, nombre: f.nombre, estado: f.estado, msgs: chatMsgs(f), upd: f.upd || 0, na: f.na || 0, nu: f.nu || 0 } : null;
}
function chatPagina(f, n) {
  n = Number(n) || 0;
  const reset = n > f.msgs.length;
  if (reset) n = 0;
  return { n: f.msgs.length, msgs: f.msgs.slice(n), estado: f.estado, reset };
}

async function rutaChat(req, env, ruta) {
  if (req.method !== 'POST') return json({ mensaje: 'Método no permitido' }, 405);
  await chatTabla(env);
  let c; try { c = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
  const ahora = Date.now();

  // ---------- Usuario ----------
  if (ruta === '/api/chat/enviar' || ruta === '/api/chat/ver' || ruta === '/api/chat/cerrar') {
    const u = await chatAuth(env, c, false);
    if (!u) return json({ mensaje: 'No autorizado' }, 401);
    let f = await chatFila(env, u.correo);
    if (ruta === '/api/chat/enviar') {
      const texto = chatTexto(c.texto);
      if (!texto) return json({ mensaje: 'Mensaje vacío' }, 400);
      if (f && f.upd && ahora - f.upd < 600 && f.msgs.length && f.msgs[f.msgs.length - 1].de === 'u') return json({ mensaje: 'Espera un momento' }, 429);
      if (!f || f.estado === 'cerrado') f = { correo: u.correo, nombre: u.nombre, estado: 'abierto', msgs: [], upd: ahora, na: 0, nu: 0 };
      f.nombre = u.nombre; f.estado = 'abierto'; f.upd = ahora; f.na += 1;
      f.msgs.push({ de: 'u', t: texto, ts: ahora });
      await chatGuardar(env, f);
      return json({ ok: true });
    }
    if (!f) return json({ n: 0, msgs: [], estado: 'ninguno', reset: false });
    if (ruta === '/api/chat/cerrar') {
      if (f.estado === 'abierto') { f.estado = 'cerrado'; f.msgs.push({ de: 's', t: 'El usuario terminó el chat.', ts: ahora }); f.na = 0; f.upd = ahora; await chatGuardar(env, f); }
      return json({ ok: true });
    }
    const pag = chatPagina(f, c.n);
    if (f.nu > 0) { f.nu = 0; await env.DB.prepare('UPDATE chat_soporte SET nu = 0 WHERE correo = ?').bind(f.correo).run(); }
    return json(pag);
  }

  // ---------- CEO ----------
  const a = (await tokenAdminValido(req, env)) ? { correo: adminCorreo(env), nombre: 'Soporte' } : await chatAuth(env, c, true);
  if (!a) return json({ mensaje: 'No autorizado' }, 401);
  if (ruta === '/api/chat/lista') {
    const { results } = await env.DB.prepare("SELECT * FROM chat_soporte ORDER BY (estado = 'abierto') DESC, upd DESC LIMIT 60").all();
    const chats = (results || []).map((f) => {
      const m = chatMsgs(f), ult = m.length ? m[m.length - 1] : null;
      return { correo: f.correo, nombre: f.nombre, estado: f.estado, upd: f.upd, na: f.na || 0, ultimo: ult ? String(ult.t).slice(0, 80) : '' };
    });
    return json({ chats, total_na: chats.reduce((s, x) => s + (x.estado === 'abierto' ? x.na : 0), 0) });
  }
  const dest = String(c.usuario || '').toLowerCase().trim();
  const f = dest ? await chatFila(env, dest) : null;
  if (!f) return json({ mensaje: 'Chat no encontrado' }, 404);
  if (ruta === '/api/chat/admin-ver') {
    const pag = chatPagina(f, c.n);
    if (f.na > 0) await env.DB.prepare('UPDATE chat_soporte SET na = 0 WHERE correo = ?').bind(f.correo).run();
    return json({ ...pag, nombre: f.nombre });
  }
  if (ruta === '/api/chat/admin-enviar') {
    const texto = chatTexto(c.texto);
    if (!texto) return json({ mensaje: 'Mensaje vacío' }, 400);
    f.estado = 'abierto'; f.upd = ahora; f.na = 0; f.nu += 1;
    f.msgs.push({ de: 'a', t: texto, ts: ahora });
    await chatGuardar(env, f);
    return json({ ok: true });
  }
  if (ruta === '/api/chat/admin-cerrar') {
    if (f.estado === 'abierto') { f.estado = 'cerrado'; f.msgs.push({ de: 's', t: 'Soporte cerró este chat. Si necesitas más ayuda, puedes abrir uno nuevo.', ts: ahora }); f.na = 0; f.nu += 1; f.upd = ahora; await chatGuardar(env, f); }
    return json({ ok: true });
  }
  return json({ mensaje: 'Ruta no encontrada' }, 404);
}

// =====================================================================
//  SALDO MÓVIL AUTOMÁTICO  (SMS Forwarder + captura de la transferencia)
//
//  Flujo:
//   1) La web crea una orden (/api/saldo/orden): número del cliente + monto. Vale 1 hora.
//   2) El cliente transfiere y sube la captura (/api/saldo/comprobante). La orden queda "esperando".
//   3) Tu teléfono reenvía cada SMS de ETECSA a /api/sms/entrada (app "Incoming SMS to URL forwarder").
//   4) Si hay un SMS de entrada con el MISMO monto y el MISMO número del cliente, recibido dentro de la
//      ventana de 1 hora de esa orden, el Worker acredita el saldo solo. Cada SMS sirve UNA sola vez.
//   5) Si el teléfono estuvo sin internet, la app reenvía los SMS al conectarse; se usa la hora original
//      del SMS (no la de llegada), así que igual se acreditan.
//
//  Secrets del Worker:
//    SMS_KEY         (obligatorio)  clave larga que va en la URL del reenviador:  ...?k=TU_CLAVE
//    SMS_REMITENTE   (opcional)     regex del remitente; por defecto solo acepta el nombre ETECSA
//    TG_TOKEN, TG_CHAT (opcionales) Telegram: te llega cada captura y el resultado
// =====================================================================
const SALDO_VENTANA_MS = 60 * 60 * 1000;          // el SMS debe ser de la hora siguiente a crear la orden
const SALDO_TOLERANCIA_MS = 5 * 60 * 1000;        // diferencia de reloj teléfono / servidor
const SALDO_GRACIA_MS = 12 * 3600 * 1000;         // la orden sigue abierta por si un SMS se reenvía tarde
const SALDO_MIN = 1;
const SALDO_MAX = 100000;
const SALDO_IMG_MAX = 1300000;                    // caracteres base64 máx. (~950 KB)
const SALDO_RATIO_MIN = 1.7;                      // captura de pantalla completa: alto/ancho >= 1.7
const SALDO_RATIO_MAX = 3.4;

let saldoTablasListas = false;
async function saldoTablas(env) {
  if (saldoTablasListas) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sms_entrada (id TEXT PRIMARY KEY, de TEXT, texto TEXT, monto REAL, saldo REAL, tels TEXT, ts INTEGER, recibido INTEGER, estado TEXT, orden_id TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS saldo_ordenes (id TEXT PRIMARY KEY, correo TEXT, usuario TEXT, tel TEXT, monto REAL, estado TEXT, creado INTEGER, enviado INTEGER, img_hash TEXT, orig_hash TEXT, img_token TEXT, imagen TEXT, chequeo TEXT, manual INTEGER DEFAULT 0, aviso INTEGER DEFAULT 0, dep_id INTEGER, sms_id TEXT, aprobado INTEGER)'),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS ux_saldo_img_hash ON saldo_ordenes(img_hash)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ix_saldo_estado ON saldo_ordenes(estado)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ix_sms_estado ON sms_entrada(estado)'),
  ]);
  saldoTablasListas = true;
}

// ---------- Utilidades ----------
function telNormal(t) {            // "+53 5555 5555" -> "55555555" (8 dígitos que empiezan con 5)
  let d = String(t || '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('53')) d = d.slice(2);
  return /^5\d{7}$/.test(d) ? d : null;
}
function aMonto(n) { return Math.round(Number(n) * 100) / 100; }
async function sha256Hex2(bytesOTexto) {
  const data = typeof bytesOTexto === 'string' ? new TextEncoder().encode(bytesOTexto) : bytesOTexto;
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function tokenAleatorio(n = 24) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
}
function fmtHavana(ms) {
  try { return new Date(ms).toLocaleString('es-CU', { timeZone: 'America/Havana', hour12: false }); } catch (e) { return new Date(ms).toISOString(); }
}

// ---------- Leer el SMS ----------
// Formato real de ETECSA:
//  "Usted ha recibido 100.0 CUP del numero 55551234.Saldo principal 100.00 CUP, linea activa hasta 2027-09-02, vence 2028-02-29"
// Si el texto no tiene EXACTAMENTE esta forma, no se usa para acreditar.
const SMS_FORMATO = /^Usted ha recibido\s+(\d{1,6}(?:\.\d{1,2})?)\s*CUP del numero\s+(?:\+?53)?(5\d{7})\s*\.?\s*Saldo principal\s+(\d{1,9}(?:\.\d{1,2})?)\s*CUP\b.*$/i;
function smsParsear(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  const m = SMS_FORMATO.exec(t);
  if (!m) return { monto: null, tels: [], saldo: null, entrada: false };
  return { monto: aMonto(m[1]), tels: [m[2]], saldo: aMonto(m[3]), entrada: true };
}

const SMS_SALIDA = /^Usted ha transferido\s+(\d{1,6}(?:\.\d{1,2})?)\s*CUP al numero\s+(?:\+?53)?(5\d{7})\s*\.?\s*Saldo principal\s+(\d{1,9}(?:\.\d{1,2})?)\s*CUP\b.*$/i;
function smsSalida(texto) {
  const m = SMS_SALIDA.exec(String(texto || '').replace(/\s+/g, ' ').trim());
  return m ? { monto: aMonto(m[1]), saldo: aMonto(m[3]) } : null;
}

// Cadena de saldo: cada SMS trae "Saldo principal". Debe ser = saldo del SMS anterior + monto recibido.
// Un SMS falsificado no sabe cuál es el saldo real, así que no encaja.
async function saldoCadenaOk(env, id, ts, monto, saldo) {
  const prev = await env.DB.prepare(
    "SELECT saldo FROM sms_entrada WHERE saldo IS NOT NULL AND estado IN ('nuevo','usado','saldo_info') AND id != ? AND ts <= ? ORDER BY ts DESC, recibido DESC LIMIT 1"
  ).bind(id, ts).first();
  let base;
  if (prev) base = prev.saldo;
  else { const b = await leerKv(env, 'sms_saldo_base'); if (!(b && typeof b.valor === 'number')) return { ok: true, esperado: aMonto(saldo), base: null }; base = b.valor; }
  return { ok: Math.abs(saldo - (base + monto)) < 0.02, esperado: aMonto(base + monto), base };
}

function remitenteValido(de, env) {
  const d = String(de || '').trim();
  let re = /etecsa/i;
  if (env.SMS_REMITENTE) { try { re = new RegExp(env.SMS_REMITENTE, 'i'); } catch (e) { return false; } }
  return re.test(d);
}

// Si un SMS llegó antes que el anterior (teléfono sin internet, reenvíos fuera de orden), se vuelve a comprobar
async function saldoRevisarPendientes(env) {
  const { results } = await env.DB.prepare("SELECT * FROM sms_entrada WHERE estado = 'saldo_no_coincide' ORDER BY ts ASC LIMIT 20").all();
  for (const s of results || []) {
    const c = await saldoCadenaOk(env, s.id, s.ts, s.monto, s.saldo);
    if (c.ok) await env.DB.prepare("UPDATE sms_entrada SET estado = 'nuevo' WHERE id = ? AND estado = 'saldo_no_coincide'").bind(s.id).run();
  }
}

// ---------- Telegram (opcional) ----------
async function tgTexto(env, texto) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: texto }),
    });
  } catch (e) { /* no es crítico */ }
}
async function tgFoto(env, dataUrl, caption) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  try {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl || '');
    if (!m) return tgTexto(env, caption);
    const bin = atob(m[2]); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append('chat_id', env.TG_CHAT);
    fd.append('caption', caption.slice(0, 1000));
    fd.append('photo', new Blob([bytes], { type: m[1] }), 'captura.jpg');
    await fetch('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
  } catch (e) { /* no es crítico */ }
}

// ---------- Tamaño real de la imagen (para saber si está recortada, sin confiar en el navegador) ----------
function dimsImagen(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) { // PNG
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1];
      if (mk === 0xff) { i++; continue; }
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null; // WebP u otro: no se verifica aquí (la web siempre envía JPEG)
}
function decodificarDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  let bin; try { bin = atob(m[2]); } catch (e) { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { tipo: m[1], bytes };
}

// ---------- Acreditar ----------
async function saldoAprobar(env, orden, sms) {
  // 1) El SMS se reserva (solo sirve una vez)
  const r1 = await env.DB.prepare("UPDATE sms_entrada SET estado = 'usado', orden_id = ? WHERE id = ? AND estado = 'nuevo'").bind(orden.id, sms.id).run();
  if (!r1.meta || r1.meta.changes !== 1) return false;
  // 2) La orden se reserva (solo se acredita una vez)
  const r2 = await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'aprobada', sms_id = ?, aprobado = ? WHERE id = ? AND estado = 'esperando'").bind(sms.id, Date.now(), orden.id).run();
  if (!r2.meta || r2.meta.changes !== 1) {
    await env.DB.prepare("UPDATE sms_entrada SET estado = 'nuevo', orden_id = NULL WHERE id = ?").bind(sms.id).run();
    return false;
  }
  const correo = String(orden.correo).toLowerCase().trim();
  const monto = aMonto(orden.monto);
  const prLT = await preciosLT(env);
  const lt = Math.round((monto / prLT.saldo) * 100) / 100; // 250 de saldo = 0.77 ORO LT
  const ok = await editarKv(env, 'usuarios', (lista) => {
    if (!Array.isArray(lista)) return null;
    const u = lista.find((x) => String(x.correo || '').toLowerCase().trim() === correo);
    if (!u) return null;
    const antesLT = u.balanceUSDT === undefined ? (u.balance || 0) : u.balanceUSDT;
    u.balanceUSDT = parseFloat((antesLT + lt).toFixed(2)); // el saldo móvil ahora acredita ORO LT
    u.balance = u.balanceUSDT;
    if (u.referidoPor) {
      const p = lista.find((x) => String(x.nombre || '').trim().toLowerCase() === String(u.referidoPor).trim().toLowerCase());
      if (p) p.descuentosDisponibles = (p.descuentosDisponibles || 0) + 1;
    }
    return lista;
  });
  if (!ok) {
    await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'error_credito' WHERE id = ?").bind(orden.id).run();
    await tgTexto(env, '⚠️ No pude acreditar ' + monto + ' CUP a ' + correo + ' (usuario no encontrado). Revisa a mano. Orden ' + orden.id);
    return false;
  }
  await editarKv(env, 'solicitudes', (s) => {
    const sol = s && typeof s === 'object' ? s : { recargas: [], depositos: [] };
    if (!Array.isArray(sol.depositos)) sol.depositos = [];
    if (!Array.isArray(sol.recargas)) sol.recargas = [];
    const d = sol.depositos.find((x) => x.saldoOrden === orden.id);
    if (d) { d.estado = 'Aprobado'; d.auto = true; delete d.comprobante; }
    else {
      let id = Date.now(); while (sol.depositos.some((x) => x.id === id)) id++;
      sol.depositos.push({ id, correo, usuario: orden.usuario || correo, monto, moneda: 'saldo', telefonoTransfirio: orden.tel, estado: 'Aprobado', auto: true, saldoOrden: orden.id });
    }
    return sol;
  });
  await marcarCambio(env);
  await tgTexto(env, '✅ Saldo acreditado automático\n' + (orden.usuario || correo) + '\n' + monto + ' CUP · desde ' + orden.tel + '\nSMS: ' + fmtHavana(sms.ts));
  return true;
}

// ---------- Buscar coincidencias (SMS <-> órdenes que esperan) ----------
async function saldoSyncPanel(env, o) {
  if (!o || o.estado !== 'esperando') return o;
  const sol = await leerKv(env, 'solicitudes');
  const d = sol && Array.isArray(sol.depositos) ? sol.depositos.find((x) => x.saldoOrden === o.id) : null;
  if (!d) return o;
  const e = String(d.estado || '');
  const nuevo = /^aprobad/i.test(e) ? 'aprobada' : (/^(rechaz|cancel)/i.test(e) ? 'rechazada' : null);
  if (!nuevo) return o;
  await env.DB.prepare("UPDATE saldo_ordenes SET estado = ?, aprobado = ? WHERE id = ? AND estado = 'esperando'").bind(nuevo, Date.now(), o.id).run();
  return (await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(o.id).first()) || o;
}

async function saldoConciliar(env) {
  await saldoTablas(env);
  const ahora = Date.now();
  const { results: ords } = await env.DB.prepare("SELECT * FROM saldo_ordenes WHERE estado = 'esperando' ORDER BY enviado ASC LIMIT 60").all();
  let aprobadas = 0;
  for (const o of ords || []) {
    const fresco = await saldoSyncPanel(env, o);
    if (fresco.estado !== 'esperando') continue; // ya lo decidió el panel: no se acredita dos veces
    if (ahora - o.creado > SALDO_GRACIA_MS) {
      await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'sin_sms' WHERE id = ? AND estado = 'esperando'").bind(o.id).run();
      continue;
    }
    if (ahora - o.creado > SALDO_VENTANA_MS + SALDO_TOLERANCIA_MS && !o.aviso) {
      await env.DB.prepare('UPDATE saldo_ordenes SET aviso = 1 WHERE id = ?').bind(o.id).run();
      await tgTexto(env, '⏳ Pasó 1 hora y no llegó el SMS de ' + (o.usuario || o.correo) + ' (' + o.monto + ' CUP desde ' + o.tel + '). Mira la captura y decide a mano en el panel.');
    }
    if (o.manual) continue; // captura que no pasó la revisión automática: solo la aprueba una persona
    const desde = o.creado - SALDO_TOLERANCIA_MS, hasta = o.creado + SALDO_VENTANA_MS + SALDO_TOLERANCIA_MS;
    const sms = await env.DB.prepare(
      "SELECT * FROM sms_entrada WHERE estado = 'nuevo' AND tels LIKE ? AND ABS(monto - ?) < 0.005 AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1"
    ).bind('%,' + o.tel + ',%', o.monto, desde, hasta).first();
    if (sms && (await saldoAprobar(env, o, sms))) aprobadas++;
  }
  return aprobadas;
}

async function saldoLimpiar(env) {
  const ahora = Date.now();
  await env.DB.prepare('DELETE FROM sms_entrada WHERE recibido < ?').bind(ahora - 14 * 86400000).run();
  await env.DB.prepare("UPDATE saldo_ordenes SET imagen = NULL WHERE imagen IS NOT NULL AND estado IN ('aprobada','cancelada','vencida') AND creado < ?").bind(ahora - 2 * 86400000).run();
  await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'vencida', img_hash = NULL, orig_hash = NULL WHERE estado = 'creada' AND creado < ?").bind(ahora - SALDO_VENTANA_MS).run();
  await env.DB.prepare("DELETE FROM saldo_ordenes WHERE estado IN ('vencida','cancelada') AND creado < ?").bind(ahora - 7 * 86400000).run();
}

function vistaOrdenSaldo(o) {
  return { id: o.id, estado: o.estado, monto: o.monto, tel: o.tel, creado: o.creado, expira: o.creado + SALDO_VENTANA_MS, enviado: o.enviado || null, aprobado: o.aprobado || null, manual: !!o.manual, ahora: Date.now() };
}

function claveSmsValida(req, url, env) {
  if (!env.SMS_KEY) return false;
  const k = url.searchParams.get('k') || req.headers.get('X-Sms-Key') || '';
  return igualesSeguro(String(k), String(env.SMS_KEY));
}
async function firmaSmsValida(env, cuerpoTexto, cabecera) {
  if (!env.SMS_KEY || !cabecera) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SMS_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(cuerpoTexto)));
  const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
  return igualesSeguro(hex, String(cabecera).trim().toLowerCase());
}

// ---------- Rutas ----------
async function rutaSaldo(req, env, ruta, url) {
  await saldoTablas(env);
  const ahora = Date.now();
  const leerJson = async () => { try { return await req.json(); } catch (e) { return null; } };

  // ===== Recepción de SMS (la app del teléfono llama aquí) =====
  if (ruta === '/api/sms/entrada' && req.method === 'POST') {
    const crudo = await req.text();
    const autorizado = claveSmsValida(req, url, env) || (await firmaSmsValida(env, crudo, req.headers.get('X-Signature')));
    if (!autorizado) return json({ ok: false, mensaje: 'No autorizado' }, 401);
    let c = null;
    try { c = JSON.parse(crudo); } catch (e) {
      try { c = Object.fromEntries(new URLSearchParams(crudo)); } catch (e2) { c = null; }
    }
    if (!c || typeof c !== 'object') return json({ ok: true, ignorado: 'cuerpo no válido' }); // 200: que la app no reintente algo que nunca servirá
    const de = String(c.from ?? c.sender ?? c.de ?? '').slice(0, 60);
    const texto = String(c.text ?? c.content ?? c.message ?? c.body ?? c.texto ?? '').slice(0, 1000);
    if (!texto) return json({ ok: true, ignorado: 'sin texto' });
    let ts = Number(c.sentStamp ?? c.receivedStamp ?? c.timestamp ?? c.ts ?? 0);
    if (ts > 0 && ts < 1e11) ts *= 1000;                          // si vino en segundos
    if (!(ts > 1.5e12) || ts > ahora + 10 * 60 * 1000) ts = 0;    // hora imposible: se ignora
    const sinHora = ts === 0;
    if (sinHora) ts = ahora;
    // Mismo SMS reenviado (reintentos de la app) = mismo id; así no se duplica
    const id = (await sha256Hex2(de + '|' + (sinHora ? Math.floor(ahora / 120000) : ts) + '|' + texto)).slice(0, 32);

    const p = smsParsear(texto);
    const s = p.entrada ? null : smsSalida(texto);
    const q = p.entrada ? p : (s || p);
    const remOk = remitenteValido(de, env);
    let estado = !remOk ? 'remitente_no_valido' : (p.entrada ? 'nuevo' : (s ? 'saldo_info' : 'ignorado'));
    if (estado === 'saldo_info') { // una salida solo puede BAJAR el saldo; si lo sube, no es válida
      const ult = await env.DB.prepare("SELECT saldo FROM sms_entrada WHERE saldo IS NOT NULL AND estado IN ('nuevo','usado','saldo_info') AND ts <= ? ORDER BY ts DESC, recibido DESC LIMIT 1").bind(ts).first();
      if (ult && s.saldo > ult.saldo + 0.02) estado = 'ignorado';
    }
    let cadena = null;
    if (estado === 'nuevo') {
      cadena = await saldoCadenaOk(env, id, ts, p.monto, p.saldo);
      if (!cadena.ok) estado = 'saldo_no_coincide';
    }
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO sms_entrada (id, de, texto, monto, saldo, tels, ts, recibido, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, de, texto, q.monto, q.saldo, p.tels.length ? ',' + p.tels.join(',') + ',' : '', ts, ahora, estado).run();
    const nuevoReg = ins.meta && ins.meta.changes === 1;
    if (nuevoReg && estado === 'saldo_no_coincide') {
      await tgTexto(env, '🚨 SMS con saldo que NO cuadra (posible falsificación o saldo gastado).\nRecibido: ' + p.monto + ' CUP del ' + p.tels[0] + '\nSaldo que dice: ' + p.saldo + ' · esperado: ' + cadena.esperado + '\nNo se acredita. Si es real, acéptalo: /api/sms/aceptar?k=TU_CLAVE&id=' + id);
    }
    if (nuevoReg && (p.entrada || s)) await saldoRevisarPendientes(env);
    const util = estado === 'nuevo';
    const aprobadas = nuevoReg ? await saldoConciliar(env) : 0;
    return json({ ok: true, guardado: true, util, aprobadas });
  }

  // ===== Diagnóstico: explica por qué un pago no se acredita. Abre /api/saldo/diagnostico?k=TU_CLAVE =====
  if (ruta === '/api/saldo/diagnostico' && req.method === 'GET') {
    if (!claveSmsValida(req, url, env)) return json({ mensaje: 'No autorizado' }, 401);
    const k = url.searchParams.get('k') || '';
    let aprobadasAhora = 0; try { aprobadasAhora = await saldoConciliar(env); } catch (e) {}
    const { results: sms } = await env.DB.prepare('SELECT id, de, texto, monto, saldo, tels, ts, recibido, estado, orden_id FROM sms_entrada ORDER BY recibido DESC LIMIT 8').all();
    const { results: ords } = await env.DB.prepare("SELECT id, usuario, tel, monto, estado, creado, manual FROM saldo_ordenes WHERE estado IN ('creada','esperando','sin_sms') ORDER BY creado DESC LIMIT 5").all();
    const que = { nuevo: 'Correcto. Está esperando una orden con ese monto y número.', usado: 'Ya se usó para acreditar una orden.', saldo_info: 'Transferencia saliente de tu línea: solo actualiza el saldo para verificar los siguientes SMS.',
      remitente_no_valido: 'El remitente no contiene "ETECSA". Cambia SMS_REMITENTE o revisa la app reenviadora.',
      ignorado: 'El texto no tiene el formato de ETECSA de saldo recibido, no se usa.',
      saldo_no_coincide: 'El saldo que dice no cuadra con el SMS anterior. Si es real, toca el enlace "aceptar".' };
    const smsOut = (sms || []).map((s) => ({ llego: fmtHavana(s.recibido), hora_sms: fmtHavana(s.ts), de: s.de, texto: s.texto, estado: s.estado, que_pasa: que[s.estado] || s.estado,
      ...(s.estado === 'saldo_no_coincide' ? { aceptar: url.origin + '/api/sms/aceptar?k=' + encodeURIComponent(k) + '&id=' + s.id } : {}) }));
    const ordOut = (ords || []).map((o) => {
      const par = (sms || []).filter((s) => s.tels && s.tels.indexOf(',' + o.tel + ',') >= 0 && Math.abs((s.monto || 0) - o.monto) < 0.005);
      let porque;
      if (o.estado === 'creada') porque = 'El cliente aún no pulsó "Ya realicé el pago".';
      else if (!par.length) porque = 'No hay ningún SMS de ' + o.monto + ' CUP del número ' + o.tel + '. El número o el monto del SMS no coinciden con los de la orden, o el reenviador no mandó el SMS.';
      else if (par[0].estado !== 'nuevo') porque = 'Hay un SMS que coincide pero su estado es "' + par[0].estado + '": ' + (que[par[0].estado] || '');
      else { const dif = Math.round((par[0].ts - o.creado) / 60000); porque = (dif < -5 || dif > 65) ? 'El SMS tiene una hora fuera de la ventana (' + dif + ' min respecto a la orden).' : 'Debería acreditarse en el próximo minuto.'; }
      return { id: o.id, usuario: o.usuario, tel: o.tel, monto: o.monto, estado: o.estado, creada: fmtHavana(o.creado), por_que_no: porque };
    });
    return json({ acreditadas_ahora: aprobadasAhora, ordenes_en_espera: ordOut, ultimos_sms: smsOut });
  }

  // ===== Ver los últimos SMS (para probar que todo se lee bien). Requiere la clave: /api/sms/ultimos?k=TU_CLAVE =====
  if (ruta === '/api/sms/ultimos' && req.method === 'GET') {
    if (!claveSmsValida(req, url, env)) return json({ mensaje: 'No autorizado' }, 401);
    const { results } = await env.DB.prepare('SELECT id, de, texto, monto, saldo, tels, ts, recibido, estado, orden_id FROM sms_entrada ORDER BY recibido DESC LIMIT 30').all();
    return json({ sms: (results || []).map((s) => ({ ...s, hora_sms: fmtHavana(s.ts), llego: fmtHavana(s.recibido) })) });
  }

  // ===== El dueño confirma un SMS real que no cuadró (ej. gastaste saldo). Reanuda la cadena de saldo. =====
  if (ruta === '/api/sms/aceptar') {
    if (!claveSmsValida(req, url, env)) return json({ mensaje: 'No autorizado' }, 401);
    const r = await env.DB.prepare("UPDATE sms_entrada SET estado = 'nuevo' WHERE id = ? AND estado = 'saldo_no_coincide'").bind(url.searchParams.get('id') || '').run();
    if (!r.meta || r.meta.changes !== 1) return json({ ok: false, mensaje: 'No hay un SMS pendiente con ese id' }, 404);
    const aprobadas = await saldoConciliar(env);
    return json({ ok: true, aprobadas });
  }
  // ===== Saldo principal inicial (solo se usa si todavía no hay ningún SMS guardado). Ej: /api/sms/base?k=...&valor=0 =====
  if (ruta === '/api/sms/base') {
    if (!claveSmsValida(req, url, env)) return json({ mensaje: 'No autorizado' }, 401);
    const v = Number(url.searchParams.get('valor'));
    if (!(v >= 0)) return json({ mensaje: 'valor inválido' }, 400);
    await guardarKv(env, 'sms_saldo_base', { valor: aMonto(v) });
    return json({ ok: true, base: aMonto(v) });
  }

  // ===== Crear orden =====
  if (ruta === '/api/saldo/orden' && req.method === 'POST') {
    const c = await leerJson(); if (!c) return json({ mensaje: 'JSON no válido' }, 400);
    const correo = String(c.correo || '').toLowerCase().trim();
    const tel = telNormal(c.tel);
    const monto = aMonto(c.monto);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) return json({ mensaje: 'Correo no válido' }, 400);
    if (!tel) return json({ mensaje: 'Escribe tu número de celular (8 dígitos, empieza con 5).' }, 400);
    if (!(monto >= SALDO_MIN) || monto > SALDO_MAX) return json({ mensaje: 'Escribe un monto válido.' }, 400);
    const fu = await env.DB.prepare("SELECT v FROM kv WHERE k = 'usuarios'").first();
    const lista = fu ? JSON.parse(fu.v) : [];
    const usuario = Array.isArray(lista) ? lista.find((x) => String(x.correo || '').toLowerCase().trim() === correo) : null;
    if (!usuario) return json({ mensaje: 'Tu cuenta aún no está sincronizada. Espera unos segundos e inténtalo otra vez.' }, 404);
    const reciente = await env.DB.prepare("SELECT COUNT(*) AS n FROM saldo_ordenes WHERE correo = ? AND creado > ?").bind(correo, ahora - 3600000).first();
    if (reciente && reciente.n >= 12) return json({ mensaje: 'Demasiados intentos seguidos. Espera un rato e inténtalo otra vez.' }, 429);
    const espera = await env.DB.prepare("SELECT COUNT(*) AS n FROM saldo_ordenes WHERE correo = ? AND estado = 'esperando'").bind(correo).first();
    if (espera && espera.n >= 5) return json({ mensaje: 'Tienes varios pagos en verificación. Espera a que se acrediten.' }, 429);
    // Solo una orden "sin captura" a la vez: la anterior se descarta
    await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'cancelada', img_hash = NULL, orig_hash = NULL WHERE correo = ? AND estado = 'creada'").bind(correo).run();
    const id = tokenAleatorio(16);
    await env.DB.prepare("INSERT INTO saldo_ordenes (id, correo, usuario, tel, monto, estado, creado) VALUES (?, ?, ?, ?, ?, 'creada', ?)")
      .bind(id, correo, usuario.nombre || correo, tel, monto, ahora).run();
    const fila = await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(id).first();
    return json({ orden: vistaOrdenSaldo(fila) });
  }

  // ===== El cliente confirma que ya pagó (sin captura): el SMS de ETECSA lo verifica solo =====
  if (ruta === '/api/saldo/confirmar' && req.method === 'POST') {
    const c = await leerJson(); if (!c) return json({ mensaje: 'JSON no válido' }, 400);
    const o = await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(String(c.id || '')).first();
    if (!o) return json({ resultado: 'no_existe', mensaje: 'No encontramos esa operación. Empieza de nuevo.' }, 404);
    if (o.estado !== 'creada') return json({ resultado: o.estado, orden: vistaOrdenSaldo(o) });
    if (ahora - o.creado > SALDO_VENTANA_MS) {
      await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'vencida' WHERE id = ?").bind(o.id).run();
      return json({ resultado: 'vencida', mensaje: 'Esta operación venció (1 hora). Crea una nueva.' }, 410);
    }
    const g = await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'esperando', enviado = ?, manual = 0 WHERE id = ? AND estado = 'creada'").bind(ahora, o.id).run();
    if (!g.meta || g.meta.changes !== 1) return json({ resultado: 'repetida', mensaje: 'Esta operación ya fue enviada.' }, 409);
    await editarKv(env, 'solicitudes', (s) => {
      const sol = s && typeof s === 'object' ? s : { recargas: [], depositos: [] };
      if (!Array.isArray(sol.depositos)) sol.depositos = [];
      if (!Array.isArray(sol.recargas)) sol.recargas = [];
      let id = Date.now(); while (sol.depositos.some((x) => x.id === id)) id++;
      sol.depositos.push({ id, correo: o.correo, usuario: o.usuario || o.correo, monto: o.monto, moneda: 'saldo', telefonoTransfirio: o.tel, estado: 'Pendiente', saldoOrden: o.id });
      return sol;
    });
    await marcarCambio(env);
    await tgTexto(env, '📥 Nuevo pago de saldo\n' + (o.usuario || o.correo) + '\n' + o.monto + ' CUP · desde ' + o.tel + '\nEsperando el SMS (hasta 1 h)…');
    await saldoConciliar(env);
    const fin = await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(o.id).first();
    return json({ resultado: fin.estado, orden: vistaOrdenSaldo(fin) });
  }

  // ===== Enviar la captura =====
  if (ruta === '/api/saldo/comprobante' && req.method === 'POST') {
    const c = await leerJson(); if (!c) return json({ mensaje: 'JSON no válido' }, 400);
    const o = await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(String(c.id || '')).first();
    if (!o) return json({ resultado: 'no_existe', mensaje: 'No encontramos esa operación. Empieza de nuevo.' }, 404);
    if (o.estado !== 'creada' && o.estado !== 'esperando') return json({ resultado: o.estado, orden: vistaOrdenSaldo(o) });
    const reporte = o.estado === 'esperando';
    if (!reporte && ahora - o.creado > SALDO_VENTANA_MS) {
      await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'vencida' WHERE id = ?").bind(o.id).run();
      return json({ resultado: 'vencida', mensaje: 'Esta operación venció (1 hora). Crea una nueva.' }, 410);
    }
    const img = String(c.imagen || '');
    if (img.length > SALDO_IMG_MAX) return json({ resultado: 'imagen', mensaje: 'La imagen es demasiado pesada.' }, 413);
    const dec = decodificarDataUrl(img);
    if (!dec) return json({ resultado: 'imagen', mensaje: 'Sube la captura como imagen JPG o PNG.' }, 400);
    // Recorte: se mide la imagen que realmente llegó, no lo que dice el navegador
    const d = dimsImagen(dec.bytes);
    if (d) {
      const ratio = d.h / d.w;
      if (d.w < 400 || ratio < SALDO_RATIO_MIN || ratio > SALDO_RATIO_MAX) {
        return json({ resultado: 'recortada', mensaje: 'La captura parece recortada. Sube la captura de pantalla completa, sin recortar.' }, 422);
      }
    }
    const hash = await sha256Hex2(dec.bytes);
    const hashOrig = /^[0-9a-f]{64}$/.test(String(c.hashOrig || '')) ? String(c.hashOrig) : null;
    const dup = await env.DB.prepare("SELECT id FROM saldo_ordenes WHERE (img_hash = ? OR (? IS NOT NULL AND orig_hash = ?)) AND id != ?").bind(hash, hashOrig, hashOrig, o.id).first();
    if (dup) return json({ resultado: 'repetida', mensaje: 'Esa captura ya fue usada en otra operación. Sube la captura de este pago.' }, 409);

    let chequeo = {};
    try { chequeo = c.chequeo && typeof c.chequeo === 'object' ? c.chequeo : {}; } catch (e) { chequeo = {}; }
    const chequeoTxt = JSON.stringify(chequeo).slice(0, 2500);
    const manual = chequeo.forzado ? 1 : 0;
    const token = tokenAleatorio(24);
    try {
      const g = await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'esperando', enviado = COALESCE(enviado, ?), img_hash = ?, orig_hash = ?, img_token = ?, imagen = ?, chequeo = ?, manual = ? WHERE id = ? AND estado IN ('creada','esperando')")
        .bind(ahora, hash, hashOrig, token, img, chequeoTxt, manual, o.id).run();
      if (!g.meta || g.meta.changes !== 1) return json({ resultado: 'repetida', mensaje: 'Esta operación ya fue enviada.' }, 409);
    } catch (e) { return json({ resultado: 'repetida', mensaje: 'Esa captura ya fue usada en otra operación.' }, 409); }

    // Aparece en el panel como depósito Pendiente, con la captura para que la veas
    const urlImg = url.origin + '/api/saldo/imagen?t=' + token;
    await editarKv(env, 'solicitudes', (s) => {
      const sol = s && typeof s === 'object' ? s : { recargas: [], depositos: [] };
      if (!Array.isArray(sol.depositos)) sol.depositos = [];
      if (!Array.isArray(sol.recargas)) sol.recargas = [];
      let id = Date.now(); while (sol.depositos.some((x) => x.id === id)) id++;
      const ex = sol.depositos.find((x) => x.saldoOrden === o.id);
      if (ex) { ex.comprobante = urlImg; ex.revisionManual = true; return sol; }
      sol.depositos.push({ id, correo: o.correo, usuario: o.usuario || o.correo, monto: o.monto, moneda: 'saldo', telefonoTransfirio: o.tel, estado: 'Pendiente', comprobante: urlImg, saldoOrden: o.id, ...(manual ? { revisionManual: true } : {}) });
      return sol;
    });
    await marcarCambio(env);
    const banderas = [];
    if (chequeo.ocr === 'ok') banderas.push('lectura OK'); else if (chequeo.ocr) banderas.push('lectura: ' + chequeo.ocr);
    if (chequeo.horaBarra) banderas.push('hora en la captura ' + chequeo.horaBarra);
    if (manual) banderas.push('REVISIÓN MANUAL (no pasó la lectura automática)');
    await tgFoto(env, img, (reporte ? '🆘 Problema con un pago de saldo: el usuario envía su captura\n' : '📥 Nuevo pago de saldo\n') + (o.usuario || o.correo) + '\n' + o.monto + ' CUP · desde ' + o.tel + '\n' + banderas.join(' · ') + '\nEsperando el SMS (hasta 1 h)…');
    await saldoConciliar(env);
    const fin = await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(o.id).first();
    return json({ resultado: fin.estado, orden: vistaOrdenSaldo(fin) });
  }

  // ===== Estado de una orden =====
  if (ruta === '/api/saldo/estado' && req.method === 'GET') {
    const o = await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(url.searchParams.get('id') || '').first();
    if (!o) return json({ mensaje: 'No encontrada' }, 404);
    try { await saldoSyncPanel(env, o); } catch (e) {}
    if (o.estado === 'esperando' && Date.now() - (o.enviado || 0) > 20000) { try { await saldoConciliar(env); } catch (e) {} }
    const f = await env.DB.prepare('SELECT * FROM saldo_ordenes WHERE id = ?').bind(o.id).first();
    return json({ orden: vistaOrdenSaldo(f) });
  }

  // ===== Cancelar (solo antes de enviar la captura) =====
  if (ruta === '/api/saldo/cancelar' && req.method === 'POST') {
    const c = await leerJson(); if (!c) return json({ mensaje: 'JSON no válido' }, 400);
    await env.DB.prepare("UPDATE saldo_ordenes SET estado = 'cancelada', img_hash = NULL, orig_hash = NULL WHERE id = ? AND estado = 'creada'").bind(String(c.id || '')).run();
    return json({ resultado: 'cancelada' });
  }

  // ===== La captura (la usa el panel del CEO como <img>; el token no se puede adivinar) =====
  if (ruta === '/api/saldo/imagen' && req.method === 'GET') {
    const o = await env.DB.prepare('SELECT imagen FROM saldo_ordenes WHERE img_token = ?').bind(url.searchParams.get('t') || '').first();
    const dec = o && decodificarDataUrl(o.imagen);
    if (!dec) return new Response('No disponible', { status: 404, headers: CORS });
    return new Response(dec.bytes, { headers: { ...CORS, 'Content-Type': dec.tipo, 'Cache-Control': 'private, max-age=3600' } });
  }

  return json({ mensaje: 'Ruta no encontrada' }, 404);
}



// =====================================================================
//  VERIFICACIÓN DE CORREO  (código de 6 dígitos enviado por Gmail con Google Apps Script)
//   1) /api/email/codigo   -> genera el código, lo guarda (solo su huella) y lo manda por correo
//   2) /api/email/verificar -> comprueba el código; si es bueno, el correo queda "verificado" 60 min
//   3) PUT /api/state       -> solo acepta usuarios NUEVOS si su correo está verificado (se usa una sola vez)
//  Variables del Worker necesarias: APPS_SCRIPT_URL y APPS_SCRIPT_CLAVE
// =====================================================================
const EMAIL_VIGENCIA_MS = 10 * 60 * 1000;      // el código vale 10 minutos
const EMAIL_ESPERA_MS = 60 * 1000;             // mínimo 60 s entre envíos al mismo correo
const EMAIL_MAX_ENVIOS_HORA = 5;               // por correo
const EMAIL_MAX_IP_HORA = 15;                  // por IP
const EMAIL_MAX_INTENTOS = 5;                  // intentos de escribir el código
const EMAIL_VERIFICADO_MS = 60 * 60 * 1000;    // después de verificar, hay 60 min para terminar el registro

let emailTablaLista = false;
async function emailTabla(env) {
  if (emailTablaLista) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS email_codigos (correo TEXT PRIMARY KEY, hash TEXT, exp INTEGER, intentos INTEGER DEFAULT 0, enviado INTEGER, envios INTEGER DEFAULT 0, ventana INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS email_verificados (correo TEXT PRIMARY KEY, ts INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS email_ip (ip TEXT, ts INTEGER)'),
  ]);
  emailTablaLista = true;
}
async function emailLimpiar(env) {
  await emailTabla(env);
  const ahora = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_codigos WHERE exp < ?').bind(ahora - 3600000),
    env.DB.prepare('DELETE FROM email_verificados WHERE ts < ?').bind(ahora - 2 * 3600000),
    env.DB.prepare('DELETE FROM email_ip WHERE ts < ?').bind(ahora - 2 * 3600000),
  ]);
}
const emailNorm = (c) => String(c || '').toLowerCase().trim();
const emailValido = (c) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c) && c.length <= 120;
async function emailHuella(env, correo, codigo) {
  return await sha256Hex(correo + '|' + codigo + '|' + String(env.ADMIN_PASSWORD || env.APPS_SCRIPT_CLAVE || 'lt'));
}
async function emailEnviar(env, correo, codigo) {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_CLAVE) return { ok: false, motivo: 'no_configurado' };
  try {
    const r = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ clave: env.APPS_SCRIPT_CLAVE, to: correo, codigo }),
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (e) { return { ok: false, motivo: 'respuesta_no_valida' }; }
    return { ok: !!j.ok, motivo: j.error || '' };
  } catch (e) { return { ok: false, motivo: 'sin_conexion' }; }
}

async function rutaEmail(req, env, ruta) {
  if (req.method !== 'POST') return json({ mensaje: 'Método no permitido' }, 405);
  await emailTabla(env);
  let c; try { c = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
  const correo = emailNorm(c.correo);
  if (!emailValido(correo)) return json({ mensaje: 'Escribe un correo válido.' }, 400);
  const ahora = Date.now();

  if (ruta === '/api/email/codigo') {
    const usuarios = await leerKv(env, 'usuarios');
    if (Array.isArray(usuarios) && usuarios.some((u) => emailNorm(u && u.correo) === correo)) return json({ mensaje: 'Ya existe una cuenta con ese correo.' }, 409);

    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const nIp = await env.DB.prepare('SELECT COUNT(*) AS n FROM email_ip WHERE ip = ? AND ts > ?').bind(ip, ahora - 3600000).first();
    if (nIp && nIp.n >= EMAIL_MAX_IP_HORA) return json({ mensaje: 'Demasiados intentos desde tu conexión. Espera un rato.' }, 429);

    const fila = await env.DB.prepare('SELECT * FROM email_codigos WHERE correo = ?').bind(correo).first();
    let envios = 0, ventana = ahora;
    if (fila) {
      if (ahora - fila.enviado < EMAIL_ESPERA_MS) {
        const falta = Math.ceil((EMAIL_ESPERA_MS - (ahora - fila.enviado)) / 1000);
        return json({ mensaje: 'Espera ' + falta + ' s para pedir otro código.', espera: falta }, 429);
      }
      if (ahora - fila.ventana < 3600000) { envios = fila.envios; ventana = fila.ventana; }
      if (envios >= EMAIL_MAX_ENVIOS_HORA) return json({ mensaje: 'Ya pediste muchos códigos. Intenta de nuevo en una hora.' }, 429);
    }

    const codigo = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const huella = await emailHuella(env, correo, codigo);
    await env.DB.prepare('INSERT OR REPLACE INTO email_codigos (correo, hash, exp, intentos, enviado, envios, ventana) VALUES (?, ?, ?, 0, ?, ?, ?)')
      .bind(correo, huella, ahora + EMAIL_VIGENCIA_MS, ahora, envios + 1, ventana).run();
    await env.DB.prepare('INSERT INTO email_ip (ip, ts) VALUES (?, ?)').bind(ip, ahora).run();

    const r = await emailEnviar(env, correo, codigo);
    if (!r.ok) {
      await env.DB.prepare('DELETE FROM email_codigos WHERE correo = ?').bind(correo).run();
      if (r.motivo === 'no_configurado') return json({ mensaje: 'El envío de códigos aún no está configurado. Avisa a soporte.' }, 503);
      return json({ mensaje: 'No pudimos enviar el código ahora. Intenta en unos minutos.' }, 502);
    }
    return json({ ok: true, espera: EMAIL_ESPERA_MS / 1000 });
  }

  if (ruta === '/api/email/verificar') {
    const codigo = String(c.codigo || '').replace(/\D/g, '');
    const fila = await env.DB.prepare('SELECT * FROM email_codigos WHERE correo = ?').bind(correo).first();
    if (!fila || fila.exp < ahora) return json({ mensaje: 'El código venció. Pide uno nuevo.' }, 410);
    if (fila.intentos >= EMAIL_MAX_INTENTOS) return json({ mensaje: 'Demasiados intentos. Pide un código nuevo.' }, 429);
    if (codigo.length !== 6 || (await emailHuella(env, correo, codigo)) !== fila.hash) {
      await env.DB.prepare('UPDATE email_codigos SET intentos = intentos + 1 WHERE correo = ?').bind(correo).run();
      const quedan = Math.max(0, EMAIL_MAX_INTENTOS - fila.intentos - 1);
      return json({ mensaje: quedan ? 'Código incorrecto. Te quedan ' + quedan + ' intentos.' : 'Código incorrecto. Pide un código nuevo.' }, 400);
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM email_codigos WHERE correo = ?').bind(correo),
      env.DB.prepare('INSERT OR REPLACE INTO email_verificados (correo, ts) VALUES (?, ?)').bind(correo, ahora),
    ]);
    return json({ ok: true });
  }
  return json({ mensaje: 'Ruta no encontrada' }, 404);
}

// Deja pasar solo a los usuarios nuevos con correo verificado (cada verificación se gasta una vez)
async function emailFiltrarNuevos(env, usuariosNuevos, previo) {
  if (!Array.isArray(previo) || previo.length === 0) return usuariosNuevos; // base vacía: no se bloquea nada
  await emailTabla(env);
  const existentes = new Set(previo.map((u) => emailNorm(u && u.correo)));
  const vistos = new Set();
  const salida = [];
  for (const u of usuariosNuevos) {
    const k = emailNorm(u && u.correo);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    if (existentes.has(k)) { salida.push(u); continue; }
    const r = await env.DB.prepare('DELETE FROM email_verificados WHERE correo = ? AND ts > ?').bind(k, Date.now() - EMAIL_VERIFICADO_MS).run();
    if (r.meta && r.meta.changes === 1) salida.push(u);   // correo verificado: entra
    // si no: se descarta (cuenta sin verificar)
  }
  return salida;
}

export default {
  async fetch(req, env) {
    // Si la petición viene de una página web (trae Origin) que NO es tu tienda, se corta aquí.
    // Las llamadas de servidor (webhook de G2Bulk, reenviador de SMS, Telegram) no traen Origin y siguen funcionando.
    const origenPeticion = req.headers.get('Origin');
    if (origenPeticion && !ORIGENES_PERMITIDOS.includes(origenPeticion)) {
      return new Response(JSON.stringify({ mensaje: 'Origen no permitido' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const ruta = url.pathname;

    if (ruta === '/api/precios') {
      if (req.method === 'GET') return json({ precios: await preciosLT(env) });
      if (req.method === 'PUT') {
        if (!(await tokenAdminValido(req, env))) return json({ mensaje: 'No autorizado' }, 401);
        let c; try { c = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
        const act = await preciosLT(env); const n = (v, d) => (Number(v) > 0 ? Number(v) : d);
        await guardarKv(env, 'precios_lt', { usdt: n(c.usdt, act.usdt), saldo: n(c.saldo, act.saldo), cup: n(c.cup, act.cup) });
        return json({ ok: true, precios: await preciosLT(env) });
      }
    }

    if (ruta === '/api/admin/login' && req.method === 'POST') {
      try { return await rutaAdminLogin(req, env); }
      catch (e) { return json({ ok: false }, 500); }
    }

    if (ruta.startsWith('/api/chat/')) {
      try { return await rutaChat(req, env, ruta); }
      catch (e) { return json({ mensaje: 'Error interno: ' + (e && e.message ? e.message : e) }, 500); }
    }

    if (ruta.startsWith('/api/g2/')) {
      try { return await rutaG2(req, env, ruta, url); }
      catch (e) { return json({ mensaje: 'Error interno: ' + (e && e.message ? e.message : e) }, 500); }
    }

    if (ruta.startsWith('/api/saldo/') || ruta.startsWith('/api/sms/')) {
      try { return await rutaSaldo(req, env, ruta, url); }
      catch (e) { return json({ mensaje: 'Error interno: ' + (e && e.message ? e.message : e) }, 500); }
    }

    if (ruta.startsWith('/api/email/')) {
      try { return await rutaEmail(req, env, ruta); }
      catch (e) { return json({ mensaje: 'Error interno: ' + (e && e.message ? e.message : e) }, 500); }
    }

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
      limpiarAdmin(record.usuarios, env);
      return json({ record });
    }

    if (req.method === 'PUT') {
      if (env.CLAVE_ESCRITURA && req.headers.get('X-Clave') !== env.CLAVE_ESCRITURA) return json({ mensaje: 'No autorizado' }, 401);
      let cuerpo;
      try { cuerpo = await req.json(); } catch (e) { return json({ mensaje: 'JSON no válido' }, 400); }
      if (Array.isArray(cuerpo.usuarios)) {
        // Sin el pase de admin nadie puede subirse de rango; con él, sí.
        if (!(await tokenAdminValido(req, env))) {
          const previo = (await leerKv(env, 'usuarios')) || [];
          const rangos = new Map((Array.isArray(previo) ? previo : []).map((u) => [String(u.correo || '').toLowerCase().trim(), u.rango]));
          for (const u of cuerpo.usuarios) {
            const k = String((u && u.correo) || '').toLowerCase().trim();
            if (rangos.has(k) && rangos.get(k) !== undefined) u.rango = rangos.get(k); else delete u.rango;
          }
        }
        // Usuarios nuevos: solo entran si verificaron su correo con el código (el admin queda exento)
        if (!(await tokenAdminValido(req, env))) {
          const previoEmail = (await leerKv(env, 'usuarios')) || [];
          cuerpo.usuarios = await emailFiltrarNuevos(env, cuerpo.usuarios, previoEmail);
        }
        limpiarAdmin(cuerpo.usuarios, env); // borra cualquier contraseña de admin que hubiera quedado guardada
      }
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
      try { await g2Respaldo(env); } catch (e) {}
      try { await saldoConciliar(env); } catch (e) {}
      try { if (new Date(event.scheduledTime).getUTCMinutes() % 10 === 0) await saldoLimpiar(env); } catch (e) {}
      try { if (new Date(event.scheduledTime).getUTCMinutes() % 30 === 0) await g2SincronizarPrecios(env); } catch (e) {}
    })());
  },
};
