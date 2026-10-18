"use strict";
/* Administrador de registros · Mausoleo ENAF Oruro
   Interfaz en JavaScript puro (sin librerías). Habla con /api/auth y /api/admin. */

const $app = document.getElementById("app");
const session = { checked: false, configured: true, user: null, csrf: null };
let flash = null;
let currentView = 0; // evita que una vista lenta pise a otra más reciente

/* ------------------------------ Utilidades -------------------------------- */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join("") : v == null || v === false ? "" : esc(v));
const html = (strings, ...vals) => new Raw(strings.reduce((o, s, i) => o + s + (i < vals.length ? val(vals[i]) : ""), ""));

const ICONS = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  flower: '<path d="M12 2v20M6 8h12"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  arrow: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M16 7l3 3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
};
const icon = (name) => raw(`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`);

const ENTITIES = {
  responsables: { title: "Responsables", singular: "responsable", icon: "users", description: "Propietarios y personas responsables de los contratos." },
  difuntos: { title: "Difuntos", singular: "difunto", icon: "flower", description: "La memoria de quienes descansan aquí." },
  nichos: { title: "Nichos", singular: "nicho", icon: "grid", description: "Ubicaciones y disponibilidad del mausoleo." },
  contratos: { title: "Contratos", singular: "contrato", icon: "file", description: "Plazos, responsables y valores en un solo lugar." },
  mensajes: { title: "Mensajes", singular: "mensaje", icon: "mail", description: "Consultas recibidas desde el formulario de contacto del sitio." },
};
const TABLES = Object.keys(ENTITIES);
const DETAIL_ROUTE = { responsable: "responsables", difunto: "difuntos", nicho: "nichos" };
const DETAIL_ID = { responsable: "responsable_id", difunto: "difunto_id", nicho: "nicho_id" };

const FORMS = {
  responsables: [
    { k: "nombre", l: "Nombre completo", req: 1, max: 200, wide: 1, only: "letters", hint: "Solo letras (sin números)." },
    { k: "documento", l: "Documento (CI)", max: 15, only: "digits", hint: "Solo números, sin letras ni guiones." },
    { k: "telefono", l: "Teléfono", max: 50, type: "tel" },
    { k: "email", l: "Correo electrónico", max: 200, type: "email", wide: 1 },
    { k: "direccion", l: "Dirección", max: 500, area: 1, wide: 1 },
    { k: "notas", l: "Observaciones", max: 4000, area: 1, wide: 1 },
  ],
  difuntos: [
    { k: "nombre", l: "Nombre completo", req: 1, max: 200, wide: 1, only: "letters", hint: "Solo letras (sin números)." },
    { k: "documento", l: "Documento (CI)", max: 15, wide: 1, only: "digits", hint: "Solo números, sin letras ni guiones." },
    { k: "nacimiento", l: "Fecha de nacimiento", type: "date" },
    { k: "fallecimiento", l: "Fecha de fallecimiento", type: "date", req: 1, maxToday: 1 },
    { k: "notas", l: "Observaciones", max: 4000, area: 1, wide: 1 },
  ],
  nichos: [
    { k: "codigo", l: "Código", req: 1, max: 50, hint: "Debe ser único. Se guarda en mayúsculas." },
    { k: "sector", l: "Sector / bloque", req: 1, max: 100 },
    { k: "fila", l: "Fila", max: 50 },
    { k: "nivel", l: "Nivel", max: 50 },
    { k: "notas", l: "Observaciones", max: 4000, area: 1, wide: 1 },
  ],
};

const pad2 = (n) => String(n).padStart(2, "0");
const pad4 = (n) => String(n).padStart(4, "0");
const ctCode = (id) => `CT-${pad4(id)}`;
const todayBO = () => { const d = new Date(Date.now() - 4 * 3600e3); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const fecha = (iso) => { if (!iso) return ""; const p = String(iso).slice(0, 10).split("-"); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; };
const fechaHora = (iso) => { try { return new Date(iso).toLocaleString("es-BO", { timeZone: "America/La_Paz", dateStyle: "short", timeStyle: "short" }); } catch { return iso; } };
const money = (cents, cur) => `${cur === "USD" ? "US$" : "Bs"} ${(cents / 100).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function addMonthsISO(iso, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ""); if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const idx = mo - 1 + months, year = y + Math.floor(idx / 12), month = (idx % 12) + 1;
  if (year > 9999) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(Math.min(d, last))}`;
}

function badge(status) {
  const cls = { "Vigente": "vigente", "Por vencer": "por-vencer", "Vencido": "vencido", "Programado": "programado", "Cancelado": "cancelado", "Sin contrato": "sin-contrato" }[status] || "";
  return html`<span class="badge ${cls}">${status}</span>`;
}

function toast(type, text) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`; el.textContent = text; box.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function errorsBox(list) {
  if (!list || !list.length) return "";
  return html`<div class="alert error" role="alert">${list.length === 1 ? list[0] : raw(`<ul>${list.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`)}</div>`;
}

/* ------------------------------ API y rutas ------------------------------- */

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (method !== "GET" && session.csrf) opts.headers["X-CSRF-Token"] = session.csrf;
  let res;
  try { res = await fetch(url, opts); } catch { throw { errores: ["No se pudo conectar con el servidor. Verifica que esté iniciado."] }; }
  let data = {};
  try { data = await res.json(); } catch { /* respuesta vacía */ }
  if (res.status === 401 && session.user) {
    session.user = null; session.csrf = null; clearDraft();
    flash = { type: "error", text: "Tu sesión terminó. Inicia sesión de nuevo." };
    location.hash = "#/login";
    throw { errores: data.errores || [], silent: true };
  }
  if (!res.ok) throw { errores: data.errores || ["No se pudo completar la operación."], status: res.status };
  return data;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: Object.fromEntries(new URLSearchParams(qs)) };
}
const qs = (obj) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) if (v !== "" && v != null) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ""; };
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

async function loadSession() {
  const s = await (await fetch("/api/auth/estado", { credentials: "same-origin" })).json();
  session.checked = true; session.configured = s.configurado; session.user = s.usuario; session.csrf = s.csrf;
}

async function route() {
  const token = ++currentView;
  document.body.classList.remove("menu-open");
  try {
    if (!session.checked) await loadSession();
    const { parts, query } = parseHash();
    const head = parts[0] || "";
    if (!session.configured) return head === "configurar" ? viewSetup() : go("#/configurar");
    if (!session.user) return head === "login" ? viewLogin() : go("#/login");
    if (head === "login" || head === "configurar") return go("#/");

    let page;
    if (head === "") page = await viewDashboard();
    else if (head === "t" && TABLES.includes(parts[1])) {
      if (parts[2] === "nuevo") page = await viewForm(parts[1], null, query);
      else if (parts[3] === "editar") page = await viewForm(parts[1], Number(parts[2]), query);
      else if (!parts[2]) page = await viewTable(parts[1], query);
    } else if (head === "ficha" && TABLES.includes(parts[1]) && parts[2]) page = await viewDetail(parts[1], Number(parts[2]));
    else if (head === "usuarios") {
      if (session.user.rol !== "principal") return go("#/cuenta");
      if (parts[1] === "nuevo") page = await viewUserForm(null);
      else if (parts[2] === "editar") page = await viewUserForm(Number(parts[1]));
      else page = await viewUsers();
    } else if (head === "cuenta") page = viewAccount();
    if (token !== currentView) return;
    if (!page) page = { active: "", title: "No encontrado", body: html`<div class="panel empty"><h3>No encontramos esta página</h3><p><a href="#/">Volver al inicio</a></p></div>` };
    render(page);
  } catch (err) {
    if (token !== currentView || err.silent) return;
    render({ active: "", title: "Error", body: html`<div class="panel empty"><h3>No se pudo cargar</h3>${errorsBox(err.errores || ["Ocurrió un error inesperado."])}<p><a href="#/">Volver al inicio</a></p></div>` });
  }
}

/* ------------------------------ Estructura -------------------------------- */

function render(page) {
  document.title = `${page.title} · Administración ENAF`;
  const link = (hash, name, label, active) => html`<a href="${hash}" ${page.active === active ? raw('aria-current="page"') : ""}>${icon(name)} ${label}</a>`;
  const isMain = session.user.rol === "principal";
  const nav = html`
    <div class="shell">
      <div class="topbar no-print"><button type="button" data-action="menu" aria-label="Abrir menú" aria-expanded="false">☰</button><strong>ENAF ORURO</strong></div>
      <aside class="sidebar" id="sidebar">
        <div class="brand"><img src="../assets/img/admin/logo.png" alt="Logotipo ENAF"><strong>MAUSOLEO ENAF</strong><span>Oruro · Administración</span></div>
        <nav class="nav" aria-label="Principal">
          ${link("#/", "database", "Administrar datos", "admin")}
          <div class="nav-label">Tablas</div>
          ${TABLES.map((t) => link(`#/t/${t}`, ENTITIES[t].icon, ENTITIES[t].title, t))}
          <div class="nav-label">Sistema</div>
          ${isMain ? link("#/usuarios", "shield", "Administradores", "usuarios") : ""}
          ${link("#/cuenta", "key", "Mi cuenta", "cuenta")}
          ${isMain ? html`<a href="/api/admin/respaldo" download>${icon("download")} Descargar respaldo</a>` : ""}
          <a href="/" target="_blank" rel="noopener">${icon("globe")} Ver sitio público</a>
        </nav>
        <div class="sidebar-foot"><strong>${session.user.nombre}</strong>${isMain ? "Administrador principal" : "Administrador secundario"}<br>
          <button type="button" data-action="logout" class="text-link" style="color:var(--champagne)">Salir</button></div>
      </aside>
      <main class="main" id="main">${page.body}</main>
    </div>`;
  $app.innerHTML = nav.s;
  window.scrollTo(0, 0);
  if (flash) { toast(flash.type, flash.text); flash = null; }
  page.after?.();
}

function renderAuth(inner) { $app.innerHTML = html`<div class="auth"><div class="auth-card"><div class="logo"><img src="../assets/img/admin/logo.png" alt="Logotipo ENAF"></div>${inner}</div></div>`.s; if (flash) { toast(flash.type, flash.text); flash = null; } }

const pwField = (id, label, extra = "") => html`<div class="field"><label for="${id}">${label}</label><div class="password-row"><input id="${id}" name="${id}" type="password" autocomplete="${id === "actual" ? "current-password" : "new-password"}" ${raw(extra)}><button type="button" data-action="toggle-pw" data-target="${id}" aria-label="Mostrar contraseña">Mostrar</button></div></div>`;

/* ------------------------------ Acceso ------------------------------------ */

function viewLogin() {
  document.title = "Iniciar sesión · Administración ENAF";
  renderAuth(html`<h1>Administración</h1><p class="lead">Mausoleo ENAF Oruro. Ingresa con tu cuenta de administrador.</p>
    <div id="form-errors"></div>
    <form data-form="login" novalidate>
      <div class="field"><label for="usuario">Usuario</label><input id="usuario" name="usuario" autocomplete="username" required autofocus></div>
      ${pwField("password", "Contraseña", "required")}
      <button class="button primary" type="submit">Entrar</button>
    </form><a class="back" href="/">← Volver al sitio</a>`);
}

function viewSetup() {
  document.title = "Crear cuenta · Administración ENAF";
  renderAuth(html`<h1>Crear cuenta</h1><p class="lead">Es la primera vez. Esta cuenta será el <strong>administrador principal</strong>; no existe contraseña predeterminada.</p>
    <div id="form-errors"></div>
    <form data-form="setup" novalidate>
      <div class="field"><label for="nombre">Tu nombre</label><input id="nombre" name="nombre" autocomplete="name" data-only="letters" maxlength="100" required autofocus><small>Solo letras (sin números).</small></div>
      <div class="field"><label for="usuario">Usuario</label><input id="usuario" name="usuario" autocomplete="username" required><small>De 3 a 40 caracteres: letras, números, punto o guion.</small></div>
      ${pwField("password", "Contraseña (10 a 128 caracteres)", "required")}
      ${pwField("confirmacion", "Repite la contraseña", "required")}
      <button class="button primary" type="submit">Crear cuenta y entrar</button>
    </form>`);
}

/* ------------------------------ Inicio ------------------------------------ */

async function viewDashboard() {
  const r = await api("GET", "/api/admin/resumen");
  const isMain = session.user.rol === "principal";
  return {
    active: "admin", title: "Administrar datos",
    body: html`
      <div class="page-heading"><div><div class="eyebrow">PANEL DE ADMINISTRACIÓN</div><h1>Administrar datos</h1><p>Consulta las tablas del mausoleo y gestiona sus registros.</p></div>
        ${isMain ? html`<div class="inline-actions"><a class="button secondary" href="/api/admin/respaldo" download>${icon("download")} Descargar respaldo</a><a class="button primary" href="#/usuarios/nuevo">${icon("plus")} Nuevo administrador</a></div>` : ""}</div>
      <div class="admin-summary"><span class="stat-icon">${icon("database")}</span><div><strong>${plural(r.total, "registro", "registros")} en la base de datos</strong><p>Selecciona una tabla para buscar, agregar, editar o exportar información.</p></div><span class="admin-local">${icon("check")} Base SQLite conectada al sitio ENAF</span></div>
      <div class="mini-stats">
        <div><b>${r.contratos.activos}</b><span>Contratos activos</span></div>
        <div><b>${r.contratos.porVencer}</b><span>Por vencer (60 días)</span></div>
        <div><b>${r.contratos.vencidos}</b><span>Contratos vencidos</span></div>
        <div><b>${r.nichosOcupados}</b><span>Nichos ocupados hoy</span></div>
      </div>
      <div class="admin-cards">${TABLES.map((key) => html`
        <section class="panel admin-card"><div class="admin-card-top"><span class="stat-icon">${icon(ENTITIES[key].icon)}</span><span class="admin-table-name">Tabla: ${key}</span></div>
          <h2><a href="#/t/${key}">${ENTITIES[key].title}</a></h2>
          <strong class="admin-count">${r.counts[key]} <small>${r.counts[key] === 1 ? "registro" : "registros"}</small></strong>
          <p>${ENTITIES[key].description}</p>
          <div class="admin-card-actions"><a class="button primary" href="#/t/${key}">Abrir tabla ${icon("arrow")}</a>${key !== "mensajes" ? html`<a class="text-link" href="#/t/${key}/nuevo">+ Agregar</a>` : ""}</div></section>`)}</div>
      <section class="panel admin-account-panel"><div><h2>${icon("users")} ${isMain ? "Administradores del sistema" : "Mi cuenta secundaria"}</h2>
        <p>${isMain ? raw(`${esc(plural(r.usuarios, "cuenta", "cuentas"))} · Principal: <strong>${esc(session.user.nombre)}</strong>`) : raw(`<strong>${esc(session.user.nombre)}</strong> · Usuario: ${esc(session.user.usuario)}`)}</p></div>
        <a class="button secondary" href="${isMain ? "#/usuarios" : "#/cuenta"}">${isMain ? "Gestionar administradores" : "Mi cuenta y contraseña"} ${icon("arrow")}</a></section>
      <p class="helper">${icon("info")} Los cambios se guardan directamente en los datos que usa el sitio público (consulta de difuntos y estado de registros).</p>`,
  };
}

/* ------------------------------ Tablas ------------------------------------ */

function cell(kind, key, row) {
  const v = row[key];
  if (kind === "id") return html`<a class="table-primary" href="#/ficha/${row._entity}/${row.id}">#${v}</a>`;
  if (kind === "date") return v ? fecha(v) : html`<span class="admin-null">—</span>`;
  if (kind === "money") return html`<span class="nowrap">${money(v, row.moneda)}</span>`;
  if (kind === "status") return badge(row.estado);
  if (kind === "estado") return badge(v || "Sin contrato");
  if (kind === "relation") return html`<a href="#/ficha/${DETAIL_ROUTE[key]}/${row[DETAIL_ID[key]]}">${v}</a><span class="table-secondary">ID ${row[DETAIL_ID[key]]}</span>`;
  if (v == null || v === "") return html`<span class="admin-null">—</span>`;
  if (key === "creado") return html`${fechaHora(v)}`;
  if (kind === "text" && String(v).length > 75) return html`<details class="admin-long-text"><summary>${String(v).slice(0, 65)}…</summary><p>${v}</p></details>`;
  return html`${v}`;
}

async function viewTable(entity, query) {
  const meta = ENTITIES[entity];
  const params = { q: query.q || "", orden: query.orden || "id", direccion: query.direccion === "asc" ? "asc" : "desc", pagina: query.pagina || "" };
  const d = await api("GET", `/api/admin/${entity}${qs(params)}`);
  const isMain = session.user.rol === "principal";
  const highlight = Number(query.registro) || 0;
  if (entity === "contratos" && highlight) clearDraft();
  const sortHref = (key) => `#/t/${entity}${qs({ q: d.q, orden: key, direccion: d.sort === key && d.direction === "desc" ? "asc" : "desc" })}`;
  const pageHref = (p) => `#/t/${entity}${qs({ q: d.q, orden: d.sort, direccion: d.direction, pagina: p })}`;

  const actions = (row) => {
    const parts = [html`<a class="admin-action" href="#/ficha/${entity}/${row.id}">Ver ficha</a>`];
    if (entity !== "mensajes") parts.push(html`<a class="admin-action" href="#/t/${entity}/${row.id}/editar">${icon("edit")} Editar</a>`);
    if (entity === "contratos") {
      if (!row.cancelado) parts.push(html`<button type="button" class="admin-action admin-danger" data-action="cancel" data-id="${row.id}" data-msg="${`¿Cancelar el contrato ${ctCode(row.id)}? Se conservará su historial.`}">Cancelar</button>`);
      else if (isMain) parts.push(html`<button type="button" class="admin-action admin-danger" data-action="delete" data-entity="contratos" data-id="${row.id}" data-msg="¿Eliminar definitivamente este contrato cancelado? Se borrará su historial. Esta acción no se puede deshacer.">Eliminar</button>`);
      else parts.push(html`<span class="admin-protected">Cancelado</span>`);
    } else if (d.references[row.id]) {
      parts.push(html`<span class="admin-protected" title="Tiene contratos asociados y debe conservarse">${plural(d.references[row.id], "contrato", "contratos")}</span>`);
    } else {
      const label = entity === "nichos" ? row.codigo : entity === "mensajes" ? `el mensaje de ${row.nombre}` : row.nombre;
      parts.push(html`<button type="button" class="admin-action admin-danger" data-action="delete" data-entity="${entity}" data-id="${row.id}" data-msg="${`¿Eliminar ${label} (ID ${row.id})? Esta acción no se puede deshacer.`}">Eliminar</button>`);
    }
    return parts;
  };

  const from = (d.page - 1) * 25 + 1, to = Math.min(d.page * 25, d.count);
  return {
    active: entity, title: meta.title,
    body: html`
      <a class="back-link" href="#/">${icon("back")} Volver a administrar datos</a>
      <div class="page-heading"><div><div class="eyebrow">BASE DE DATOS · TABLA ${entity.toUpperCase()}</div><h1>${meta.title}</h1><p>Revisa los campos de cada registro y administra la información.</p></div>
        <div class="inline-actions"><a class="button secondary" href="/api/admin/${entity}/exportar.csv${qs({ q: d.q })}" download>${icon("download")} Exportar CSV</a>
        ${entity !== "mensajes" ? html`<a class="button primary" href="#/t/${entity}/nuevo">${icon("plus")} Agregar ${meta.singular}</a>` : ""}</div></div>
      <nav class="admin-tabs" aria-label="Tablas de la base de datos">${TABLES.map((k) => html`<a href="#/t/${k}" class="${k === entity ? "selected" : ""}" ${k === entity ? raw('aria-current="page"') : ""}>${icon(ENTITIES[k].icon)} ${ENTITIES[k].title} <span>${d.counts[k]}</span></a>`)}</nav>
      <section class="panel">
        <form class="filters" data-form="search" data-entity="${entity}" data-orden="${d.sort}" data-direccion="${d.direction}">
          <label class="search-field">${icon("search")}<input name="q" type="search" value="${d.q}" maxlength="150" placeholder="Buscar en todos los campos…" aria-label="Buscar en la tabla ${meta.title.toLowerCase()}"></label>
          <button class="button secondary" type="submit">Buscar</button>${d.q ? html`<a class="text-link" href="#/t/${entity}">Limpiar búsqueda</a>` : ""}
          <span class="result-count">${d.count === 1 ? "1 registro" : `${d.count} registros`}${d.q ? (d.count === 1 ? " encontrado" : " encontrados") : ""}</span></form>
        ${d.rows.length ? html`
          <div class="table-scroll" tabindex="0" aria-label="Tabla de ${meta.title.toLowerCase()}"><table class="admin-table"><thead><tr>
            ${d.columns.map(([key, label]) => html`<th scope="col" ${d.sort === key ? raw(`aria-sort="${d.direction === "asc" ? "ascending" : "descending"}"`) : ""}><a href="${sortHref(key)}">${label} ${d.sort === key ? (d.direction === "asc" ? "↑" : "↓") : ""}</a></th>`)}
            <th scope="col">Acciones</th></tr></thead>
            <tbody>${d.rows.map((row) => { row._entity = entity; return html`<tr ${row.id === highlight ? raw('class="admin-highlight"') : ""}>
              ${d.columns.map(([key, label, kind]) => html`<td data-label="${label}">${cell(kind, key, row)}</td>`)}
              <td data-label="Acciones" class="admin-row-actions"><div>${actions(row)}</div></td></tr>`; })}</tbody></table></div>
          <div class="admin-pagination"><span>Mostrando ${from}–${to} de ${d.count}</span>
            <nav aria-label="Páginas de registros">${d.page > 1 ? html`<a class="button secondary" href="${pageHref(d.page - 1)}">${icon("back")} Anterior</a>` : ""}<span>Página ${d.page} de ${d.pages}</span>${d.page < d.pages ? html`<a class="button secondary" href="${pageHref(d.page + 1)}">Siguiente ${icon("arrow")}</a>` : ""}</nav></div>`
        : html`<div class="empty"><h3>${d.q ? "No se encontraron registros" : "Esta tabla aún está vacía"}</h3><p>${d.q ? "Prueba otra búsqueda o limpia el filtro." : entity === "mensajes" ? "Aquí aparecerán las consultas del formulario de contacto." : "Agrega el primer registro con el botón superior."}</p></div>`}
      </section>
      <p class="helper">${icon("info")} Haz clic en el nombre de una columna para ordenar. ${entity === "contratos" ? "Solo el principal puede eliminar definitivamente contratos que ya estén cancelados." : entity === "mensajes" ? "Los mensajes se pueden consultar y eliminar." : "Solo puedes eliminar registros que no tengan contratos asociados."}</p>`,
    after() { if (highlight) document.querySelector(".admin-highlight")?.scrollIntoView({ block: "center" }); },
  };
}

/* ------------------------------ Formularios ------------------------------- */

const DRAFT_KEY = "enaf_contrato_borrador";
const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* sin almacenamiento */ } };
const saveDraft = () => {
  const form = document.querySelector('form[data-form="record"][data-entity="contratos"]');
  if (!form || form.dataset.id) return;
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(new FormData(form)))); } catch { /* sin almacenamiento */ }
};
const readDraft = () => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}"); } catch { return {}; } };

function fieldHtml(f, data) {
  const id = `f_${f.k}`, v = data[f.k] ?? "";
  const attrs = `${f.req ? "required " : ""}${f.max ? `maxlength="${f.max}" ` : ""}${f.maxToday ? `max="${todayBO()}" ` : ""}${f.only ? `data-only="${f.only}" autocomplete="off" ` : ""}${f.only === "digits" ? 'inputmode="numeric" ' : ""}`;
  const control = f.area ? html`<textarea id="${id}" name="${f.k}" ${raw(attrs)}>${v}</textarea>`
    : html`<input id="${id}" name="${f.k}" type="${f.type || "text"}" value="${v}" ${raw(attrs)}>`;
  return html`<div class="field ${f.wide ? "wide" : ""}"><label for="${id}">${f.l}${f.req ? html` <span class="req">*</span>` : ""}</label>${control}${f.hint ? html`<small>${f.hint}</small>` : ""}</div>`;
}

async function viewForm(entity, id, query) {
  if (entity === "mensajes") return null;
  const meta = ENTITIES[entity];
  let data = {};
  if (id) {
    const r = await api("GET", `/api/admin/${entity}/${id}`);
    data = { ...r.row };
    if (entity === "contratos") data.precio = (r.row.precio_centavos / 100).toFixed(2);
  }
  const fromContract = query.desde === "contrato" && entity !== "contratos" && !id;
  const back = id ? `#/t/${entity}?registro=${id}` : `#/t/${entity}`;
  const title = `${id ? "Editar" : "Agregar"} ${meta.singular}`;
  const head = html`<a class="back-link" href="${back}">${icon("back")} Volver a ${meta.title.toLowerCase()}</a>
    <div class="page-heading"><div><div class="eyebrow">${id ? "EDITAR REGISTRO" : "NUEVO REGISTRO"}</div><h1>${title}</h1>
    <p>${fromContract ? "Al guardar volverás al contrato con este registro ya seleccionado." : "Los campos marcados con * son obligatorios."}</p></div></div>`;

  if (entity === "contratos") {
    const opts = await api("GET", "/api/admin/opciones");
    if (!id) {
      data = { moneda: "BOB", ...readDraft(), ...data };
      for (const k of ["responsable_id", "difunto_id", "nicho_id"]) if (query[k]) data[k] = query[k];
    }
    const select = (name, label, list, text, newPath, singular) => html`
      <div class="field wide"><div class="field-with-link"><label for="f_${name}">${label} <span class="req">*</span></label>
        <a href="#/t/${newPath}/nuevo?desde=contrato" data-action="save-draft">+ Nuevo ${singular}</a></div>
        <select id="f_${name}" name="${name}" required><option value="">Selecciona…</option>
        ${list.map((o) => html`<option value="${o.id}" ${String(data[name]) === String(o.id) ? raw("selected") : ""}>${text(o)}</option>`)}</select></div>`;
    return {
      active: entity, title,
      body: html`${head}<section class="panel form-panel"><div id="form-errors"></div>
        <form data-form="record" data-entity="contratos" data-id="${id || ""}" novalidate><div class="form-grid">
          ${select("responsable_id", "Responsable", opts.responsables, (o) => `${o.nombre}${o.documento ? ` · ${o.documento}` : ""}`, "responsables", "responsable")}
          ${select("difunto_id", "Difunto", opts.difuntos, (o) => `${o.nombre}${o.documento ? ` · ${o.documento}` : ""}`, "difuntos", "difunto")}
          ${select("nicho_id", "Nicho", opts.nichos, (o) => `${o.codigo} · ${o.sector}${o.fila ? ` · fila ${o.fila}` : ""}${o.nivel ? ` · nivel ${o.nivel}` : ""}`, "nichos", "nicho")}
          <div class="field"><label for="f_inicio">Inicio del contrato <span class="req">*</span></label><input id="f_inicio" name="inicio" type="date" value="${data.inicio || ""}" required></div>
          <div class="field"><label for="f_meses">Duración (meses) <span class="req">*</span></label><input id="f_meses" name="meses" type="number" min="1" max="1200" step="1" value="${data.meses || ""}" required></div>
          <div class="field wide"><div class="preview" id="vencimiento" aria-live="polite">Indica inicio y duración para calcular el vencimiento.</div></div>
          <div class="field"><label for="f_precio">Precio total <span class="req">*</span></label><input id="f_precio" name="precio" inputmode="decimal" value="${data.precio || ""}" placeholder="0.00" required><small>Importe acordado por todo el período, con hasta dos decimales.</small></div>
          <div class="field"><label for="f_moneda">Moneda</label><select id="f_moneda" name="moneda"><option value="BOB" ${data.moneda !== "USD" ? raw("selected") : ""}>Bolivianos (Bs)</option><option value="USD" ${data.moneda === "USD" ? raw("selected") : ""}>Dólares (US$)</option></select></div>
          <div class="field wide"><label for="f_notas">Observaciones</label><textarea id="f_notas" name="notas" maxlength="4000">${data.notas || ""}</textarea></div>
        </div><div class="form-actions"><button class="button primary" type="submit">${icon("check")} Guardar contrato</button><a class="button secondary" href="${back}">Cancelar</a></div></form></section>`,
      after() {
        const form = document.querySelector('form[data-form="record"]');
        const out = document.getElementById("vencimiento");
        const update = () => {
          const end = addMonthsISO(form.inicio.value, parseInt(form.meses.value, 10));
          out.innerHTML = end ? `El contrato vencerá el <strong>${esc(fecha(end))}</strong>. Termina al comenzar esa fecha; una renovación puede iniciar ese mismo día.` : "Indica inicio y duración para calcular el vencimiento.";
        };
        form.addEventListener("input", () => { update(); saveDraft(); }); update();
      },
    };
  }

  return {
    active: entity, title,
    body: html`${head}<section class="panel form-panel"><div id="form-errors"></div>
      <form data-form="record" data-entity="${entity}" data-id="${id || ""}" data-from="${fromContract ? "contrato" : ""}" novalidate>
        <div class="form-grid">${FORMS[entity].map((f) => fieldHtml(f, data))}</div>
        <div class="form-actions"><button class="button primary" type="submit">${icon("check")} Guardar ${meta.singular}</button><a class="button secondary" href="${back}">Cancelar</a></div></form></section>`,
  };
}

/* ------------------------------ Ficha ------------------------------------- */

async function viewDetail(entity, id) {
  const meta = ENTITIES[entity];
  const d = await api("GET", `/api/admin/${entity}/${id}`);
  const row = d.row; row._entity = entity;
  const isMain = session.user.rol === "principal";
  const heading = entity === "contratos" ? ctCode(row.id) : row.nombre || row.codigo || `#${row.id}`;
  const fields = d.columns.filter(([k]) => k !== "id").map(([key, label, kind]) => html`<div><dt>${label}</dt><dd class="preserve-lines">${cell(kind, key, row)}</dd></div>`);
  const relatedTable = d.related.length ? html`
    <h2 class="section-title">Contratos asociados</h2><div class="panel" style="padding:0"><div class="table-scroll"><table class="admin-table"><thead><tr><th>Contrato</th><th>Responsable</th><th>Difunto</th><th>Nicho</th><th>Vence</th><th>Estado</th></tr></thead><tbody>
    ${d.related.map((c) => html`<tr><td data-label="Contrato"><a class="table-primary" href="#/ficha/contratos/${c.id}">${ctCode(c.id)}</a></td><td data-label="Responsable">${c.responsable}</td><td data-label="Difunto">${c.difunto}</td><td data-label="Nicho">${c.nicho}</td><td data-label="Vence">${fecha(c.fin)}</td><td data-label="Estado">${badge(c.estado)}</td></tr>`)}</tbody></table></div></div>` : "";
  return {
    active: entity, title: heading,
    body: html`
      <a class="back-link no-print" href="#/t/${entity}?registro=${id}">${icon("back")} Volver a ${meta.title.toLowerCase()}</a>
      <div class="page-heading"><div><div class="eyebrow">FICHA · ${meta.singular.toUpperCase()}</div><h1>${heading}</h1>${entity === "contratos" ? html`<p>${badge(row.estado)}</p>` : ""}</div>
        <div class="inline-actions no-print">
          ${entity === "contratos" ? html`<button class="button secondary" type="button" data-action="print">${icon("print")} Imprimir ficha</button>` : ""}
          ${entity !== "mensajes" ? html`<a class="button primary" href="#/t/${entity}/${id}/editar">${icon("edit")} Editar</a>` : ""}
          ${entity === "contratos" && !row.cancelado ? html`<button class="button secondary" type="button" data-action="cancel" data-id="${id}" data-back="1" data-msg="${`¿Cancelar el contrato ${ctCode(id)}? Se conservará su historial.`}">Cancelar contrato</button>` : ""}
          ${entity === "contratos" && row.cancelado && isMain ? html`<button class="button danger" type="button" data-action="delete" data-entity="contratos" data-id="${id}" data-back="1" data-msg="¿Eliminar definitivamente este contrato cancelado? Se borrará su historial. Esta acción no se puede deshacer.">Eliminar</button>` : ""}</div></div>
      <section class="panel"><dl class="detail-grid"><div><dt>ID</dt><dd>#${row.id}</dd></div>${fields}</dl></section>
      ${relatedTable}
      ${entity === "contratos" ? html`<p class="helper">${icon("info")} La ficha impresa es un resumen administrativo, no una plantilla legal.</p>` : ""}`,
  };
}

/* ------------------------------ Administradores --------------------------- */

async function viewUsers() {
  const { usuarios } = await api("GET", "/api/admin/usuarios");
  return {
    active: "usuarios", title: "Administradores",
    body: html`
      <a class="back-link" href="#/">${icon("back")} Volver a administrar datos</a>
      <div class="page-heading"><div><div class="eyebrow">SISTEMA</div><h1>Administradores</h1><p>Existe un solo principal. Las cuentas nuevas son secundarias.</p></div>
        <div class="inline-actions"><a class="button primary" href="#/usuarios/nuevo">${icon("plus")} Nuevo administrador</a></div></div>
      <section class="panel"><div class="table-scroll"><table class="admin-table"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th>Creada</th><th>Acciones</th></tr></thead><tbody>
        ${usuarios.map((u) => html`<tr><td data-label="Nombre">${u.nombre}</td><td data-label="Usuario">${u.usuario}</td><td data-label="Rol">${u.rol === "principal" ? "Principal" : "Secundario"}</td>
          <td data-label="Estado">${u.activo ? html`<span class="badge vigente">Activa</span>` : html`<span class="badge cancelado">Desactivada</span>`}</td><td data-label="Creada">${fecha(u.creado)}</td>
          <td data-label="Acciones" class="admin-row-actions"><div><a class="admin-action" href="#/usuarios/${u.id}/editar">${icon("edit")} Editar</a>
          ${u.rol === "principal" ? html`<span class="admin-protected">No se desactiva</span>` : html`<button type="button" class="admin-action ${u.activo ? "admin-danger" : ""}" data-action="toggle-user" data-id="${u.id}" data-msg="${u.activo ? `¿Desactivar la cuenta de ${u.nombre}? Se cerrarán sus sesiones.` : `¿Activar la cuenta de ${u.nombre}?`}">${u.activo ? "Desactivar" : "Activar"}</button>`}</div></td></tr>`)}
      </tbody></table></div></section>`,
  };
}

async function viewUserForm(id) {
  let u = {};
  if (id) u = (await api("GET", `/api/admin/usuarios/${id}`)).usuario;
  return {
    active: "usuarios", title: id ? "Editar administrador" : "Nuevo administrador",
    body: html`<a class="back-link" href="#/usuarios">${icon("back")} Volver a administradores</a>
      <div class="page-heading"><div><div class="eyebrow">SISTEMA</div><h1>${id ? "Editar administrador" : "Nuevo administrador"}</h1>
      <p>${id ? "Deja la contraseña en blanco para conservar la actual. Guardar cierra sus sesiones anteriores." : "La cuenta nueva será de tipo secundario."}</p></div></div>
      <section class="panel form-panel"><div id="form-errors"></div>
      <form data-form="user" data-id="${id || ""}" novalidate><div class="form-grid">
        <div class="field wide"><label for="nombre">Nombre completo <span class="req">*</span></label><input id="nombre" name="nombre" value="${u.nombre || ""}" maxlength="100" data-only="letters" autocomplete="off" required><small>Solo letras (sin números).</small></div>
        <div class="field wide"><label for="usuario">Usuario <span class="req">*</span></label><input id="usuario" name="usuario" value="${u.usuario || ""}" maxlength="40" autocomplete="off" required><small>De 3 a 40 caracteres: letras, números, punto o guion.</small></div>
        ${pwField("password", id ? "Nueva contraseña (opcional)" : "Contraseña (10 a 128 caracteres)", id ? "" : "required")}
        ${pwField("confirmacion", "Repite la contraseña", id ? "" : "required")}
      </div><div class="form-actions"><button class="button primary" type="submit">${icon("check")} Guardar</button><a class="button secondary" href="#/usuarios">Cancelar</a></div></form></section>`,
  };
}

function viewAccount() {
  const u = session.user;
  return {
    active: "cuenta", title: "Mi cuenta",
    body: html`<div class="page-heading"><div><div class="eyebrow">SISTEMA</div><h1>Mi cuenta</h1><p>${u.nombre} · Usuario: ${u.usuario} · ${u.rol === "principal" ? "Administrador principal" : "Administrador secundario"}</p></div></div>
      <section class="panel form-panel"><h2 style="font-size:18px;margin-bottom:14px">Cambiar contraseña</h2><div id="form-errors"></div>
      <form data-form="account" novalidate><div class="form-grid">
        <div class="wide field">${pwField("actual", "Contraseña actual", "required")}</div>
        ${pwField("password", "Nueva contraseña (10 a 128 caracteres)", "required")}
        ${pwField("confirmacion", "Repite la nueva contraseña", "required")}
      </div><p class="helper">${icon("info")} Al cambiarla se cierran tus otras sesiones abiertas.</p>
      <div class="form-actions"><button class="button primary" type="submit">${icon("check")} Cambiar contraseña</button></div></form></section>`,
  };
}

/* ------------------------------ Eventos ----------------------------------- */

const formData = (form) => Object.fromEntries(new FormData(form));
const showErrors = (list) => { const box = document.getElementById("form-errors"); if (box) { box.innerHTML = errorsBox(list).s; box.scrollIntoView({ block: "nearest" }); } };

async function guarded(button, task) {
  if (button) button.disabled = true;
  try { await task(); } catch (err) { if (!err.silent) showErrors(err.errores || ["Ocurrió un error inesperado."]); } finally { if (button?.isConnected) button.disabled = false; }
}

document.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-form]"); if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form, button = form.querySelector('button[type="submit"]');
  const body = formData(form);

  if (kind === "search") {
    return go(`#/t/${form.dataset.entity}${qs({ q: String(body.q || "").trim(), orden: form.dataset.orden, direccion: form.dataset.direccion })}`);
  }
  guarded(button, async () => {
    if (kind === "login" || kind === "setup") {
      const r = await api("POST", kind === "login" ? "/api/auth/login" : "/api/auth/configurar", body);
      session.user = r.usuario; session.csrf = r.csrf; session.configured = true;
      flash = { type: "success", text: `Bienvenido, ${r.usuario.nombre}.` };
      return go("#/");
    }
    if (kind === "record") {
      const entity = form.dataset.entity, id = form.dataset.id;
      const r = await api(id ? "PUT" : "POST", `/api/admin/${entity}${id ? `/${id}` : ""}`, body);
      flash = { type: "success", text: "Registro guardado correctamente." };
      if (entity === "contratos") clearDraft();
      if (form.dataset.from === "contrato") {
        const key = { responsables: "responsable_id", difuntos: "difunto_id", nichos: "nicho_id" }[entity];
        return go(`#/t/contratos/nuevo?${key}=${r.id}`);
      }
      return go(`#/t/${entity}?registro=${r.id}`);
    }
    if (kind === "user") {
      const id = form.dataset.id;
      await api(id ? "PUT" : "POST", `/api/admin/usuarios${id ? `/${id}` : ""}`, body);
      flash = { type: "success", text: "Administrador guardado." };
      return go("#/usuarios");
    }
    if (kind === "account") {
      await api("POST", "/api/auth/cuenta", body);
      form.reset(); showErrors([]);
      toast("success", "Contraseña actualizada.");
    }
  });
});

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) { if (event.target === document.body && document.body.classList.contains("menu-open")) document.body.classList.remove("menu-open"); return; }
  const action = el.dataset.action;

  if (action === "menu") { const open = document.body.classList.toggle("menu-open"); el.setAttribute("aria-expanded", String(open)); return; }
  if (action === "print") return window.print();
  if (action === "save-draft") return saveDraft();
  if (action === "toggle-pw") {
    const input = document.getElementById(el.dataset.target); const show = input.type === "password";
    input.type = show ? "text" : "password"; el.textContent = show ? "Ocultar" : "Mostrar"; return;
  }
  if (action === "logout") {
    return api("POST", "/api/auth/logout").catch(() => {}).then(() => { session.user = null; session.csrf = null; clearDraft(); flash = { type: "success", text: "Sesión cerrada." }; go("#/login"); });
  }
  if (["delete", "cancel", "toggle-user"].includes(action)) {
    if (!window.confirm(el.dataset.msg)) return;
    const id = el.dataset.id, entity = el.dataset.entity;
    el.disabled = true;
    const request = action === "delete" ? api("DELETE", `/api/admin/${entity}/${id}`)
      : action === "cancel" ? api("POST", `/api/admin/contratos/${id}/cancelar`)
      : api("POST", `/api/admin/usuarios/${id}/estado`);
    request.then(() => {
      toast("success", action === "cancel" ? "Contrato cancelado. Su historial se ha conservado." : action === "delete" ? "Registro eliminado." : "Cuenta actualizada.");
      if (action === "delete" && el.dataset.back) return go(`#/t/${entity}`);
      route();
    }).catch((err) => { if (!err.silent) toast("error", (err.errores || ["No se pudo completar la operación."])[0]); el.disabled = false; });
  }
});

/* Campos con data-only: "letters" admite solo letras (con tildes, espacio, apóstrofo y guion); "digits" solo números.
   Se limpia al escribir o pegar; el servidor vuelve a validar. */
const ONLY_RULES = { letters: /[^\p{L}\p{M} '’-]/gu, digits: /\D/g };
document.addEventListener("input", (event) => {
  const el = event.target, rule = el.dataset && ONLY_RULES[el.dataset.only];
  if (!rule || event.isComposing) return;
  const clean = el.value.replace(rule, "");
  if (clean === el.value) return;
  const pos = (el.selectionStart ?? el.value.length) - (el.value.length - clean.length);
  el.value = clean;
  try { el.setSelectionRange(pos, pos); } catch { /* el tipo de campo no admite selección */ }
});

document.addEventListener("keydown", (event) => { if (event.key === "Escape") document.body.classList.remove("menu-open"); });
window.addEventListener("hashchange", route);
route();
