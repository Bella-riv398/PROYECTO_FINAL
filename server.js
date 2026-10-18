"use strict";
/**
 * Mausoleo ENAF Oruro — servidor.
 *  - Sitio público (inicio, historia, servicios, consulta, galería, contacto).
 *  - Administrador de registros en /admin (JavaScript, estilo Mausoleo EMV).
 *  - API: /api/auth, /api/admin (requiere sesión) y /api/registros,
 *    /api/difuntos/buscar, /api/mensajes (públicas, usadas por el sitio).
 *  - Datos: base SQLite en data/mausoleo.db (ver lib/store.js).
 */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Store } = require("./lib/store");
const L = require("./lib/logic");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const SESSION_HOURS = 8;

const DB_FILE = path.join(__dirname, "data", "mausoleo.db");
let store;
try {
  store = new Store(DB_FILE, { legacyJson: path.join(__dirname, "data", "mausoleo.json") });
} catch (err) {
  console.error(`\nNo se pudo abrir la base de datos: ${err.message}\n`);
  process.exit(1);
}
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

/* ---------------------------------------------------------------------------
 * Contraseñas (scrypt) y sesiones
 * ------------------------------------------------------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

const sessions = new Map(); // token -> { userId, version, csrf, expires }

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { userId: user.id, version: user.session_version, csrf, expires: Date.now() + SESSION_HOURS * 3600 * 1000 });
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `enaf_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  return csrf;
}

function endSession(req, res) {
  const token = parseCookies(req).enaf_sid;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "enaf_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

/** Carga req.user / req.session si la cookie corresponde a una sesión válida. */
function loadSession(req, _res, next) {
  const token = parseCookies(req).enaf_sid;
  const s = token && sessions.get(token);
  if (s) {
    const user = store.find("usuarios", s.userId);
    if (s.expires > Date.now() && user && user.activo && user.session_version === s.version) {
      req.user = user; req.session = s; req.sessionToken = token;
    } else {
      sessions.delete(token);
    }
  }
  next();
}
app.use("/api", loadSession);

function csrfRequired(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const sent = String(req.headers["x-csrf-token"] || "");
  const real = req.session?.csrf || "";
  if (!real || sent.length !== real.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real))) {
    return res.status(403).json({ ok: false, errores: ["La sesión de seguridad expiró. Recarga la página e inténtalo de nuevo."] });
  }
  next();
}

function authRequired(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, errores: ["Inicia sesión para continuar."] });
  csrfRequired(req, res, next);
}

function principalRequired(req, res, next) {
  if (req.user.rol !== "principal") {
    return res.status(403).json({ ok: false, errores: ["Esta acción es solo para el administrador principal."] });
  }
  next();
}

const publicUser = (u) => ({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: !!u.activo, creado: u.creado });

/* ---------------------------------------------------------------------------
 * Autenticación
 * ------------------------------------------------------------------------- */

const attempts = new Map(); // ip -> { fails, start }
const WINDOW = 5 * 60 * 1000;

function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return 0;
  if (Date.now() - a.start >= WINDOW) { attempts.delete(ip); return 0; }
  return a.fails >= 5 ? Math.ceil((WINDOW - (Date.now() - a.start)) / 1000) : 0;
}
function failAttempt(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.start >= WINDOW) attempts.set(ip, { fails: 1, start: Date.now() });
  else a.fails += 1;
}

app.get("/api/auth/estado", (req, res) => {
  res.json({
    configurado: store.count("usuarios") > 0,
    usuario: req.user ? publicUser(req.user) : null,
    csrf: req.user ? req.session.csrf : null,
  });
});

app.post("/api/auth/configurar", (req, res) => {
  if (store.count("usuarios")) {
    return res.status(409).json({ ok: false, errores: ["La configuración inicial ya se completó."] });
  }
  const { nombre = "", usuario = "", password = "", confirmacion = "" } = req.body || {};
  const errors = [];
  const nombreLimpio = String(nombre).trim().replace(/\s+/g, " ");
  if (!nombreLimpio) errors.push("Indica tu nombre.");
  else if (nombreLimpio.length > 100) errors.push("El nombre admite hasta 100 caracteres.");
  else if (!L.validName(nombreLimpio)) errors.push(L.NAME_ERROR);
  if (!/^[\p{L}0-9._-]{3,40}$/u.test(String(usuario).trim())) errors.push("El usuario debe tener de 3 a 40 caracteres (letras, números, punto, guion).");
  errors.push(...L.validPassword(password, confirmacion));
  if (errors.length) return res.status(400).json({ ok: false, errores: errors });
  const user = store.insert("usuarios", {
    usuario: String(usuario).trim(), nombre: nombreLimpio,
    password_hash: hashPassword(password), session_version: 1, rol: "principal", activo: true,
    creado: new Date().toISOString(),
  });
  const csrf = startSession(req, res, user);
  res.status(201).json({ ok: true, usuario: publicUser(user), csrf });
});

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip;
  const wait = throttled(ip);
  if (wait) {
    return res.status(429).json({ ok: false, errores: [`Demasiados intentos. Inténtalo de nuevo en ${Math.ceil(wait / 60)} minuto(s).`] });
  }
  const { usuario = "", password = "" } = req.body || {};
  const user = store.findUser(String(usuario).trim());
  // Se calcula el hash aunque el usuario no exista, para no revelar su existencia por el tiempo de respuesta.
  const ok = checkPassword(password, user ? user.password_hash : "scrypt$00$00") && user && user.activo;
  if (!ok) {
    failAttempt(ip);
    return res.status(401).json({ ok: false, errores: ["Usuario o contraseña incorrectos."] });
  }
  attempts.delete(ip);
  const csrf = startSession(req, res, user);
  res.json({ ok: true, usuario: publicUser(user), csrf });
});

app.post("/api/auth/logout", authRequired, (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

app.post("/api/auth/cuenta", authRequired, (req, res) => {
  const { actual = "", password = "", confirmacion = "" } = req.body || {};
  if (!checkPassword(actual, req.user.password_hash)) {
    return res.status(400).json({ ok: false, errores: ["La contraseña actual no es correcta."] });
  }
  const errors = L.validPassword(password, confirmacion);
  if (errors.length) return res.status(400).json({ ok: false, errores: errors });
  // La nueva versión de sesión cierra las demás sesiones abiertas de esta cuenta.
  const updated = store.update("usuarios", req.user.id, { password_hash: hashPassword(password), session_version: req.user.session_version + 1 });
  for (const [token, s] of sessions) if (s.userId === req.user.id && token !== req.sessionToken) sessions.delete(token);
  req.session.version = updated.session_version;
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------------
 * Administrador: utilidades de consulta
 * ------------------------------------------------------------------------- */

const ADMIN_ENTITIES = Object.keys(L.ENTITIES);
const FIELD_OF = { responsables: "responsable_id", difuntos: "difunto_id", nichos: "nicho_id" };

function entityOr404(req, res) {
  const entity = req.params.entity;
  if (!ADMIN_ENTITIES.includes(entity)) {
    res.status(404).json({ ok: false, errores: ["No encontramos esta tabla."] });
    return null;
  }
  return entity;
}

/** Contratos agrupados por responsable, difunto o nicho (una sola consulta a la base). */
function contractsBy(field) {
  const map = new Map();
  for (const c of store.all("contratos")) {
    if (!map.has(c[field])) map.set(c[field], []);
    map.get(c[field]).push(c);
  }
  return map;
}

/** Filas de una tabla con los campos calculados que muestra el administrador. */
function enriched(entity) {
  if (entity === "difuntos" || entity === "nichos") {
    const index = contractsBy(FIELD_OF[entity]);
    return store.all(entity).map((r) => {
      const best = L.bestContract(index.get(r.id));
      return { ...r, estado_contrato: best ? best.s : "Sin contrato", vence: best ? best.c.fin : null };
    });
  }
  if (entity !== "contratos") return store.all(entity).map((r) => ({ ...r }));
  return store.all("contratos").map((c) => {
    const r = store.find("responsables", c.responsable_id);
    const d = store.find("difuntos", c.difunto_id);
    const n = store.find("nichos", c.nicho_id);
    return {
      ...c,
      responsable: r ? r.nombre : "(eliminado)",
      difunto: d ? d.nombre : "(eliminado)",
      nicho: n ? n.codigo : "(eliminado)",
      sector: n ? n.sector : "",
      estado: L.contractStatus(c),
    };
  });
}

function searchText(entity, row) {
  const keys = L.ADMIN_COLUMNS[entity].map((c) => c[0]);
  const parts = keys.map((k) => (k === "precio_centavos" ? (row[k] / 100).toFixed(2) : row[k]));
  if (entity === "contratos") {
    parts.push(row.responsable_id, row.difunto_id, row.nicho_id, row.estado, `CT-${String(row.id).padStart(4, "0")}`);
  }
  return L.normalize(parts.join(" \u0001 "));
}

function queryRows(entity, q, sort, direction) {
  const kinds = Object.fromEntries(L.ADMIN_COLUMNS[entity].map((c) => [c[0], c[2]]));
  if (!(sort in kinds)) sort = "id";
  let rows = enriched(entity);
  const term = L.normalize(q);
  if (term) rows = rows.filter((r) => searchText(entity, r).includes(term));
  const dir = direction === "asc" ? 1 : -1;
  const key = sort === "cancelado" ? "estado" : sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    let c;
    if (x == null || x === "") c = y == null || y === "" ? 0 : 1;           // vacíos al final
    else if (y == null || y === "") c = -1;
    else if (typeof x === "number" && typeof y === "number") c = x - y;
    else c = String(x).localeCompare(String(y), "es", { sensitivity: "base", numeric: true });
    if ((x == null || x === "") !== (y == null || y === "")) return c;
    return c * dir || b.id - a.id;
  });
  return { rows, sort };
}

const csvCell = (value) => {
  let v = value == null ? "" : String(value);
  // Evita que las hojas de cálculo ejecuten texto como fórmula.
  if (/^[\s]*[=+\-@\t\r\n]/.test(v)) v = "'" + v;
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/* ---------------------------------------------------------------------------
 * Administrador: rutas (todas requieren sesión)
 * ------------------------------------------------------------------------- */

const admin = express.Router();
admin.use(authRequired);

admin.get("/resumen", (req, res) => {
  const counts = Object.fromEntries(ADMIN_ENTITIES.map((e) => [e, store.count(e)]));
  const contratos = store.all("contratos").map(L.contractStatus);
  res.json({
    counts,
    total: ADMIN_ENTITIES.reduce((s, e) => s + counts[e], 0),
    usuarios: store.count("usuarios"),
    contratos: {
      activos: contratos.filter((s) => s === "Vigente" || s === "Por vencer").length,
      porVencer: contratos.filter((s) => s === "Por vencer").length,
      vencidos: contratos.filter((s) => s === "Vencido").length,
    },
    nichosOcupados: new Set(store.all("contratos").filter((c) => ["Vigente", "Por vencer"].includes(L.contractStatus(c))).map((c) => c.nicho_id)).size,
  });
});

admin.get("/opciones", (_req, res) => {
  res.json({
    responsables: [...store.all("responsables")].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })),
    difuntos: [...store.all("difuntos")].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })),
    nichos: [...store.all("nichos")].sort((a, b) => a.codigo.localeCompare(b.codigo, "es", { numeric: true, sensitivity: "base" })),
  });
});

admin.get("/respaldo", principalRequired, (_req, res, next) => {
  // Copia consistente de la base SQLite (archivo .db) para guardar o restaurar.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enaf-"));
  const file = path.join(dir, "respaldo.db");
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    store.backupTo(file);
  } catch (err) { cleanup(); return next(err); }
  res.download(file, `mausoleo-enaf-${L.today()}.db`, (err) => { cleanup(); if (err && !res.headersSent) next(err); });
});

/* ----- Administradores del sistema ----- */

admin.get("/usuarios", principalRequired, (_req, res) => {
  res.json({ usuarios: store.all("usuarios").map(publicUser) });
});

function userValues(body, editing) {
  const errors = [];
  const nombre = String(body.nombre || "").trim().replace(/\s+/g, " ");
  const usuario = String(body.usuario || "").trim();
  if (!nombre) errors.push("Indica el nombre.");
  else if (nombre.length > 100) errors.push("El nombre admite hasta 100 caracteres.");
  else if (!L.validName(nombre)) errors.push(L.NAME_ERROR);
  if (!/^[\p{L}0-9._-]{3,40}$/u.test(usuario)) errors.push("El usuario debe tener de 3 a 40 caracteres (letras, números, punto, guion).");
  const password = body.password || "";
  if (!editing || password || body.confirmacion) errors.push(...L.validPassword(password, body.confirmacion));
  return { nombre, usuario, password, errors };
}

admin.post("/usuarios", principalRequired, (req, res) => {
  const v = userValues(req.body || {}, false);
  if (store.findUser(v.usuario)) v.errors.push("Ya existe un usuario con ese nombre de acceso.");
  if (v.errors.length) return res.status(400).json({ ok: false, errores: v.errors });
  const user = store.insert("usuarios", {
    usuario: v.usuario, nombre: v.nombre, password_hash: hashPassword(v.password),
    session_version: 1, rol: "secundario", activo: true, creado: new Date().toISOString(),
  });
  res.status(201).json({ ok: true, usuario: publicUser(user) });
});

admin.get("/usuarios/:id", principalRequired, (req, res) => {
  const u = store.find("usuarios", req.params.id);
  if (!u) return res.status(404).json({ ok: false, errores: ["No encontramos esta cuenta."] });
  res.json({ usuario: publicUser(u) });
});

admin.put("/usuarios/:id", principalRequired, (req, res) => {
  const u = store.find("usuarios", req.params.id);
  if (!u) return res.status(404).json({ ok: false, errores: ["No encontramos esta cuenta."] });
  const v = userValues(req.body || {}, true);
  const other = store.findUser(v.usuario);
  if (other && other.id !== u.id) v.errors.push("Ya existe un usuario con ese nombre de acceso.");
  if (v.errors.length) return res.status(400).json({ ok: false, errores: v.errors });
  // Modificar los datos cierra sus sesiones anteriores (nueva versión de sesión).
  const changes = { nombre: v.nombre, usuario: v.usuario, session_version: u.session_version + 1 };
  if (v.password) changes.password_hash = hashPassword(v.password);
  const updated = store.update("usuarios", u.id, changes);
  if (u.id === req.user.id) req.session.version = updated.session_version;
  res.json({ ok: true, usuario: publicUser(updated) });
});

admin.post("/usuarios/:id/estado", principalRequired, (req, res) => {
  const u = store.find("usuarios", req.params.id);
  if (!u) return res.status(404).json({ ok: false, errores: ["No encontramos esta cuenta."] });
  if (u.rol === "principal") return res.status(400).json({ ok: false, errores: ["La cuenta principal no se puede desactivar."] });
  const updated = store.update("usuarios", u.id, { activo: !u.activo, session_version: u.session_version + 1 });
  res.json({ ok: true, usuario: publicUser(updated) });
});

/* ----- Tablas de datos ----- */

admin.get("/:entity", (req, res) => {
  const entity = entityOr404(req, res); if (!entity) return;
  const q = String(req.query.q || "").trim().slice(0, 150);
  const direction = req.query.direccion === "asc" ? "asc" : "desc";
  const { rows: all, sort } = queryRows(entity, q, String(req.query.orden || "id"), direction);
  const count = all.length;
  const pages = Math.max(1, Math.ceil(count / 25));
  const page = Math.min(Math.max(1, parseInt(req.query.pagina, 10) || 1), pages);
  const counts = Object.fromEntries(ADMIN_ENTITIES.map((e) => [e, store.count(e)]));
  let references = {};
  if (FIELD_OF[entity]) {
    for (const c of store.all("contratos")) references[c[FIELD_OF[entity]]] = (references[c[FIELD_OF[entity]]] || 0) + 1;
  }
  res.json({
    entity, rows: all.slice((page - 1) * 25, page * 25), count, page, pages, sort, direction, q, counts, references,
    columns: L.ADMIN_COLUMNS[entity],
  });
});

admin.get("/:entity/exportar.csv", (req, res) => {
  const entity = entityOr404(req, res); if (!entity) return;
  const { rows } = queryRows(entity, String(req.query.q || "").trim().slice(0, 150), "id", "desc");
  let columns = [...L.ADMIN_COLUMNS[entity]];
  if (entity === "contratos") columns.push(["responsable_id", "ID responsable", "number"], ["difunto_id", "ID difunto", "number"], ["nicho_id", "ID nicho", "number"]);
  const lines = [columns.map((c) => csvCell(c[1])).join(";")];
  for (const row of rows) {
    lines.push(columns.map(([key, , kind]) => {
      let v = row[key];
      if (kind === "money") v = (v / 100).toFixed(2);
      else if (kind === "status") v = row.estado;
      return csvCell(v);
    }).join(";"));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${entity}-${L.today()}.csv"`);
  res.send("\ufeff" + lines.join("\r\n") + "\r\n");
});

admin.get("/:entity/:id", (req, res) => {
  const entity = entityOr404(req, res); if (!entity) return;
  const row = enriched(entity).find((r) => r.id === Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, errores: ["No encontramos este registro."] });
  let related = [];
  if (FIELD_OF[entity]) {
    related = enriched("contratos").filter((c) => c[FIELD_OF[entity]] === row.id).sort((a, b) => (a.inicio < b.inicio ? 1 : -1));
  }
  res.json({ entity, row, related, columns: L.ADMIN_COLUMNS[entity] });
});

function saveRecord(req, res, recordId) {
  const entity = entityOr404(req, res); if (!entity) return;
  if (entity === "mensajes") return res.status(405).json({ ok: false, errores: ["Los mensajes solo se pueden consultar o eliminar."] });
  if (recordId && !store.find(entity, recordId)) return res.status(404).json({ ok: false, errores: ["No encontramos este registro."] });
  const { values, errors } = L.validate(entity, req.body, store, recordId);
  if (!errors.length) {
    // Unicidad (documento / código), equivalente a las restricciones UNIQUE de la base.
    for (const row of store.all(entity)) {
      if (row.id === recordId) continue;
      if (entity === "nichos" && row.codigo.toUpperCase() === values.codigo) errors.push("Ya existe un registro con ese documento o código. Revisa los datos.");
      if ((entity === "responsables" || entity === "difuntos") && values.documento && row.documento === values.documento) errors.push("Ya existe un registro con ese documento o código. Revisa los datos.");
      if (errors.length) break;
    }
  }
  if (errors.length) return res.status(400).json({ ok: false, errores: errors });
  let row;
  try {
    row = recordId
      ? store.update(entity, recordId, values)
      : store.insert(entity, entity === "contratos" ? { ...values, cancelado: false, creado: new Date().toISOString() } : values);
  } catch (err) {
    // La base también protege la integridad (únicos y claves foráneas) por si dos personas guardan a la vez.
    if (/UNIQUE/i.test(err.message)) return res.status(400).json({ ok: false, errores: ["Ya existe un registro con ese documento o código. Revisa los datos."] });
    if (/FOREIGN KEY/i.test(err.message)) return res.status(400).json({ ok: false, errores: ["El responsable, difunto o nicho seleccionado ya no existe."] });
    throw err;
  }
  res.status(recordId ? 200 : 201).json({ ok: true, id: row.id });
}

admin.post("/:entity", (req, res) => saveRecord(req, res, null));
admin.put("/:entity/:id", (req, res) => saveRecord(req, res, Number(req.params.id)));

admin.post("/contratos/:id/cancelar", (req, res) => {
  const c = store.update("contratos", req.params.id, { cancelado: true });
  if (!c) return res.status(404).json({ ok: false, errores: ["No encontramos este contrato."] });
  res.json({ ok: true });
});

admin.delete("/:entity/:id", (req, res) => {
  const entity = entityOr404(req, res); if (!entity) return;
  const row = store.find(entity, req.params.id);
  if (!row) return res.status(404).json({ ok: false, errores: ["No encontramos este registro."] });
  if (entity === "contratos") {
    if (req.user.rol !== "principal") return res.status(403).json({ ok: false, errores: ["Solo el principal puede eliminar definitivamente un contrato cancelado."] });
    if (!row.cancelado) return res.status(400).json({ ok: false, errores: ["Primero cancela el contrato. Solo se pueden eliminar contratos cancelados."] });
  } else if (FIELD_OF[entity] && store.all("contratos").some((c) => c[FIELD_OF[entity]] === row.id)) {
    return res.status(409).json({ ok: false, errores: ["Este registro tiene contratos asociados y debe conservarse en el historial."] });
  }
  try {
    store.remove(entity, row.id);
  } catch (err) {
    if (/FOREIGN KEY/i.test(err.message)) return res.status(409).json({ ok: false, errores: ["Este registro tiene contratos asociados y debe conservarse en el historial."] });
    throw err;
  }
  res.json({ ok: true });
});

app.use("/api/admin", admin);

/* ---------------------------------------------------------------------------
 * API pública (la usan consulta, registros y contacto del sitio)
 * ------------------------------------------------------------------------- */

/** Texto del estado para el público: "Por vencer" se muestra como "Renovación próxima". */
const publicStatus = (best) => (best ? (best.s === "Por vencer" ? "Renovación próxima" : best.s) : "Sin contrato");

app.get("/api/registros", (_req, res) => {
  const contratos = contractsBy("difunto_id");
  const nichos = new Map(store.all("nichos").map((n) => [n.id, n]));
  const resultados = store.all("difuntos").map((d) => {
    const best = L.bestContract(contratos.get(d.id));
    const nicho = best && nichos.get(best.c.nicho_id);
    return {
      id_difunto: d.id,
      nombre: d.nombre,
      pabellon: nicho ? nicho.sector : null,
      nicho: nicho ? nicho.codigo : null,
      estado: best ? publicStatus(best) : null,
      fecha_fin: best ? best.c.fin : null,
    };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" }));
  res.json({ exito: true, cantidad: resultados.length, resultados });
});

app.get("/api/difuntos/buscar", (req, res) => {
  const nombre = L.normalize(String(req.query.nombre || "").trim());
  const nac = String(req.query.fecha_nacimiento || "");
  const fal = String(req.query.fecha_fallecimiento || "");
  const contratos = contractsBy("difunto_id");
  const nichos = new Map(store.all("nichos").map((n) => [n.id, n]));
  const resultados = store.all("difuntos")
    .filter((d) => (!nombre || L.normalize(d.nombre).includes(nombre))
      && (!nac || d.nacimiento === nac) && (!fal || d.fallecimiento === fal))
    .map((d) => {
      const best = L.bestContract(contratos.get(d.id));
      const nicho = best && nichos.get(best.c.nicho_id);
      return {
        id_difunto: d.id,
        nombre: d.nombre,
        fecha_nacimiento: d.nacimiento,
        fecha_fallecimiento: d.fallecimiento,
        observaciones: d.notas || "",
        codigo_nicho: nicho ? nicho.codigo : null,
        bloque: nicho ? nicho.sector : null,
        fila: nicho ? nicho.fila || null : null,
        nivel: nicho ? nicho.nivel || null : null,
        estado_contrato: publicStatus(best),
        fecha_vencimiento: best ? best.c.fin : null,
      };
    });
  res.json({ exito: true, cantidad: resultados.length, resultados });
});

const contactLog = new Map();
app.post("/api/mensajes", (req, res) => {
  const now = Date.now();
  const recent = (contactLog.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ exito: false, mensaje: "Has enviado varios mensajes seguidos. Inténtalo más tarde." });
  const { nombre, contacto, asunto, mensaje } = req.body || {};
  const fields = [nombre, contacto, asunto, mensaje];
  if (fields.some((f) => typeof f !== "string" || !f.trim())) {
    return res.status(400).json({ exito: false, mensaje: "Completa todos los campos correctamente." });
  }
  if (nombre.trim().length > 100 || contacto.trim().length > 150 || asunto.trim().length > 100 || mensaje.trim().length > 2000) {
    return res.status(400).json({ exito: false, mensaje: "Uno de los campos supera el límite permitido." });
  }
  if (!L.validName(nombre.trim().replace(/\s+/g, " "))) {
    return res.status(400).json({ exito: false, mensaje: L.NAME_ERROR });
  }
  recent.push(now); contactLog.set(req.ip, recent);
  const row = store.insert("mensajes", {
    nombre: nombre.trim().replace(/\s+/g, " "), contacto: contacto.trim(), asunto: asunto.trim(), mensaje: mensaje.trim(),
    creado: new Date().toISOString(),
  });
  res.status(201).json({ exito: true, mensaje: "Mensaje recibido correctamente.", id_mensaje: row.id });
});

app.use("/api", (_req, res) => res.status(404).json({ ok: false, errores: ["Ruta no encontrada."] }));

/* ---------------------------------------------------------------------------
 * Archivos estáticos
 * ------------------------------------------------------------------------- */

for (const dir of ["inicio", "historia", "consulta", "galeria", "contacto", "servicios", "assets", "admin"]) {
  app.use(`/${dir}`, express.static(path.join(__dirname, dir)));
}
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
    return res.status(400).json({ ok: false, errores: ["La solicitud no es válida."] });
  }
  console.error(err);
  res.status(500).json({ ok: false, errores: ["No se pudo completar la operación. Vuelve a intentar."] });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Mausoleo ENAF Oruro en http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
    console.log(`Administrador:       http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/admin/`);
    console.log(`Base de datos SQLite: ${DB_FILE}`);
  });
}

module.exports = { app, store };
