"use strict";
/**
 * Reglas de negocio del administrador (portadas de Mausoleo EMV a JavaScript):
 * fechas en hora de Bolivia (UTC-4), estados de contrato, búsqueda sin acentos
 * y validación de cada tipo de registro.
 */

const ENTITIES = {
  responsables: {
    title: "Responsables", singular: "responsable", icon: "users",
    description: "Propietarios y personas responsables de los contratos.",
  },
  difuntos: {
    title: "Difuntos", singular: "difunto", icon: "flower",
    description: "La memoria de quienes descansan aquí.",
  },
  nichos: {
    title: "Nichos", singular: "nicho", icon: "grid",
    description: "Ubicaciones y disponibilidad del mausoleo.",
  },
  contratos: {
    title: "Contratos", singular: "contrato", icon: "file",
    description: "Plazos, responsables y valores en un solo lugar.",
  },
  mensajes: {
    title: "Mensajes", singular: "mensaje", icon: "mail",
    description: "Consultas recibidas desde el formulario de contacto del sitio.",
  },
};

// [clave, etiqueta, tipo]
const ADMIN_COLUMNS = {
  responsables: [
    ["id", "ID", "id"], ["nombre", "Nombre completo", "text"], ["documento", "Documento", "text"],
    ["telefono", "Teléfono", "text"], ["email", "Correo", "text"], ["direccion", "Dirección", "text"],
    ["notas", "Observaciones", "text"],
  ],
  difuntos: [
    ["id", "ID", "id"], ["nombre", "Nombre completo", "text"], ["documento", "Documento", "text"],
    ["nacimiento", "Nacimiento", "date"], ["fallecimiento", "Fallecimiento", "date"],
    ["estado_contrato", "Estado del contrato", "estado"], ["vence", "Vence", "date"],
    ["notas", "Observaciones", "text"],
  ],
  nichos: [
    ["id", "ID", "id"], ["codigo", "Código", "text"], ["sector", "Sector / bloque", "text"],
    ["fila", "Fila", "text"], ["nivel", "Nivel", "text"],
    ["estado_contrato", "Estado del contrato", "estado"], ["vence", "Vence", "date"],
    ["notas", "Observaciones", "text"],
  ],
  contratos: [
    ["id", "ID", "id"], ["responsable", "Responsable", "relation"], ["difunto", "Difunto", "relation"],
    ["nicho", "Nicho", "relation"], ["inicio", "Inicio", "date"], ["meses", "Meses", "number"],
    ["fin", "Vencimiento", "date"], ["precio_centavos", "Precio total", "money"],
    ["moneda", "Moneda", "text"], ["cancelado", "Estado", "status"],
    ["notas", "Observaciones", "text"], ["creado", "Fecha de registro", "text"],
  ],
  mensajes: [
    ["id", "ID", "id"], ["nombre", "Nombre", "text"], ["contacto", "Contacto", "text"],
    ["asunto", "Asunto", "text"], ["mensaje", "Mensaje", "text"], ["creado", "Recibido", "text"],
  ],
};

/**
 * Nombres de personas: solo letras (con tildes, ñ, ü), separadas por un espacio; se admiten
 * apóstrofo y guion entre letras (D'Angelo, Pérez-Rojas). No se aceptan números ni otros símbolos.
 */
const NAME_RE = /^[\p{L}\p{M}]+(?:[ '’-][\p{L}\p{M}]+)*$/u;
const NAME_ERROR = "El nombre solo puede contener letras (sin números ni símbolos).";
const validName = (value) => NAME_RE.test(String(value ?? ""));

/** Carnet de identidad: solo dígitos. */
const DOC_RE = /^\d{1,15}$/;
const DOC_ERROR = "El documento (CI) solo puede contener números, sin letras ni símbolos.";
const validDocument = (value) => DOC_RE.test(String(value ?? ""));

const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (y, m, d) => `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;

/** Fecha actual de Bolivia (UTC-4) como "YYYY-MM-DD". */
function today() {
  const d = new Date(Date.now() - 4 * 3600 * 1000);
  return fmtDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmtDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Valida y descompone una fecha ISO estricta; devuelve null si no es válida. */
function parseISO(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) return null;
  return { y, m, d };
}

/** Suma meses de calendario; si el día no existe, usa el último día del mes. */
function addMonths(iso, months) {
  const p = parseISO(iso);
  const index = p.m - 1 + months;
  const year = p.y + Math.floor(index / 12);
  const month = (index % 12) + 1;
  if (year > 9999) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return fmtDate(year, month, Math.min(p.d, last));
}

function contractStatus(c) {
  if (c.cancelado) return "Cancelado";
  const now = today();
  if (c.inicio > now) return "Programado";
  if (c.fin <= now) return "Vencido";
  if (c.fin <= addDays(now, 60)) return "Por vencer";
  return "Vigente";
}

const STATUS_RANK = { Vigente: 0, "Por vencer": 0, Programado: 1, Vencido: 2, Cancelado: 3 };

/**
 * Contrato más relevante de una lista (vigente > programado > vencido > cancelado;
 * a igual estado, el que vence más tarde). Devuelve { c, s } con el estado calculado, o null.
 */
function bestContract(contracts) {
  return (contracts || [])
    .map((c) => ({ c, s: contractStatus(c) }))
    .sort((a, b) => STATUS_RANK[a.s] - STATUS_RANK[b.s] || (a.c.fin < b.c.fin ? 1 : -1))[0] || null;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function validPassword(password, confirmation) {
  const errors = [];
  if (typeof password !== "string" || password.length < 10 || password.length > 128 || !password.trim()) {
    errors.push("La contraseña debe tener entre 10 y 128 caracteres.");
  }
  if (password !== confirmation) errors.push("Las contraseñas no coinciden.");
  return errors;
}

/**
 * Valida un registro. `store` expone find(entity,id) y all(entity).
 * Devuelve { values, errors }.
 */
function validate(entity, data, store, recordId = null) {
  const errors = [];
  const values = {};
  data = data && typeof data === "object" ? data : {};

  const text = (key, label, required = false, max = 200) => {
    const raw = data[key];
    const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (required && !value) errors.push(`Completa el campo ${label}.`);
    if (value.length > max) errors.push(`${label}: máximo ${max} caracteres.`);
    values[key] = value;
    return value;
  };

  const dateField = (key, label, required = true) => {
    const value = typeof data[key] === "string" ? data[key].trim() : "";
    const ok = parseISO(value);
    if (!ok && (value || required)) errors.push(`Indica una fecha válida en ${label}.`);
    values[key] = value || null;
    return ok ? value : null;
  };

  if (entity === "responsables" || entity === "difuntos") {
    const nombre = text("nombre", "nombre completo", true).replace(/\s+/g, " ");
    values.nombre = nombre;
    if (nombre && !validName(nombre)) errors.push("Nombre completo: solo puede contener letras (sin números ni símbolos).");
    const documento = text("documento", "documento", false, 15);
    if (documento && !validDocument(documento)) errors.push(DOC_ERROR);
    values.documento = documento || null;
    if (entity === "responsables") {
      text("telefono", "teléfono", false, 50);
      const email = text("email", "correo electrónico");
      if (email && (!email.includes("@") || !email.split("@").pop().includes(".") || /\s/.test(email))) {
        errors.push("Indica un correo electrónico válido.");
      }
      text("direccion", "dirección", false, 500);
    } else {
      const birth = dateField("nacimiento", "nacimiento", false);
      const death = dateField("fallecimiento", "fallecimiento");
      if (death && death > today()) errors.push("El fallecimiento no puede ser una fecha futura.");
      if (birth && death && birth > death) errors.push("El nacimiento debe ser anterior o igual al fallecimiento.");
    }
  } else if (entity === "nichos") {
    values.codigo = text("codigo", "código", true, 50).toUpperCase();
    text("sector", "sector / bloque", true, 100);
    text("fila", "fila", false, 50);
    text("nivel", "nivel", false, 50);
  } else if (entity === "contratos") {
    for (const [key, table, label] of [
      ["responsable_id", "responsables", "responsable"],
      ["difunto_id", "difuntos", "difunto"],
      ["nicho_id", "nichos", "nicho"],
    ]) {
      const n = Number(data[key]);
      if (Number.isInteger(n) && store.find(table, n)) values[key] = n;
      else errors.push(`Selecciona un ${label} válido.`);
    }
    const start = dateField("inicio", "inicio del contrato");
    let end = null;
    const months = Number(data.meses);
    if (Number.isInteger(months) && months >= 1 && months <= 1200 && String(data.meses).trim() !== "") {
      values.meses = months;
      if (start) {
        end = addMonths(start, months);
        if (end) values.fin = end;
      }
      if (start && !end) errors.push("El vencimiento debe ser anterior al año 10000.");
    } else {
      errors.push("La duración debe ser un número entero de 1 a 1200 meses, con vencimiento anterior al año 10000.");
    }
    const priceRaw = String(data.precio ?? "").trim().replace(",", ".");
    if (/^\d+(\.\d{1,2})?$/.test(priceRaw) && Number(priceRaw) > 0 && Number(priceRaw) <= 999999999.99) {
      const [whole, frac = ""] = priceRaw.split(".");
      values.precio_centavos = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
    } else {
      errors.push("Indica un precio total mayor a cero, con un máximo de dos decimales.");
    }
    values.moneda = data.moneda || "BOB";
    if (!["BOB", "USD"].includes(values.moneda)) errors.push("Selecciona una moneda válida.");

    const current = recordId ? store.find("contratos", recordId) : null;
    if (start && end && !(current && current.cancelado)) {
      // Periodos [inicio, fin): se permite renovar el mismo día del vencimiento.
      for (const [key, label] of [["nicho_id", "El nicho"], ["difunto_id", "El difunto"]]) {
        if (!(key in values)) continue;
        const overlap = store.all("contratos").find((c) =>
          c[key] === values[key] && !c.cancelado && c.inicio < end && c.fin > start && c.id !== (recordId || 0));
        if (overlap) {
          errors.push(`${label} ya tiene un contrato durante ese período (CT-${String(overlap.id).padStart(4, "0")}). Ajusta las fechas.`);
        }
      }
    }
  }
  text("notas", "observaciones", false, 4000);
  if (entity === "mensajes") delete values.notas;
  return { values, errors };
}

module.exports = {
  ENTITIES, ADMIN_COLUMNS, today, addDays, addMonths, parseISO,
  contractStatus, bestContract, normalize, validPassword, validate,
  validName, validDocument, NAME_ERROR, DOC_ERROR,
};
