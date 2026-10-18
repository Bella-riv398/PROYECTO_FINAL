"use strict";
/**
 * Almacén de datos del mausoleo: base de datos SQLite (data/mausoleo.db).
 *
 * Usa el módulo integrado de Node.js (node:sqlite, Node 22.13 o superior), así que
 * no hay que instalar ni compilar nada. Las claves foráneas impiden borrar
 * responsables, difuntos o nichos que tengan contratos, y los índices únicos
 * (documento, código de nicho, usuario) evitan duplicados aunque falle una
 * validación de la aplicación.
 *
 * La interfaz (all, find, insert, update, remove) es la misma que usaba el
 * almacén anterior en JSON, de modo que el resto del sistema no cambia.
 */

const fs = require("fs");
const path = require("path");

function loadSqlite() {
  // Node 22 muestra un aviso "experimental" al cargar el módulo; se silencia solo ese aviso.
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const text = typeof warning === "string" ? warning : warning && warning.message;
    if (/sqlite/i.test(String(text))) return undefined;
    return original.call(process, warning, ...args);
  };
  try {
    return require("node:sqlite");
  } catch {
    throw new Error(
      `Este sistema guarda los datos en SQLite y necesita Node.js 22.13 o superior ` +
      `(tu versión es ${process.version}). Instálalo desde https://nodejs.org y vuelve a iniciar.`
    );
  } finally {
    process.emitWarning = original;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  nombre          TEXT    NOT NULL,
  password_hash   TEXT    NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  rol             TEXT    NOT NULL CHECK (rol IN ('principal','secundario')),
  activo          INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0,1)),
  creado          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS responsables (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT NOT NULL,
  documento TEXT UNIQUE,
  telefono  TEXT NOT NULL DEFAULT '',
  email     TEXT NOT NULL DEFAULT '',
  direccion TEXT NOT NULL DEFAULT '',
  notas     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS difuntos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre        TEXT NOT NULL,
  documento     TEXT UNIQUE,
  nacimiento    TEXT,
  fallecimiento TEXT NOT NULL,
  notas         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS nichos (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sector TEXT NOT NULL,
  fila   TEXT NOT NULL DEFAULT '',
  nivel  TEXT NOT NULL DEFAULT '',
  notas  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS contratos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  responsable_id  INTEGER NOT NULL REFERENCES responsables(id) ON DELETE RESTRICT,
  difunto_id      INTEGER NOT NULL REFERENCES difuntos(id)     ON DELETE RESTRICT,
  nicho_id        INTEGER NOT NULL REFERENCES nichos(id)       ON DELETE RESTRICT,
  inicio          TEXT    NOT NULL,
  meses           INTEGER NOT NULL CHECK (meses BETWEEN 1 AND 1200),
  fin             TEXT    NOT NULL,
  precio_centavos INTEGER NOT NULL CHECK (precio_centavos > 0),
  moneda          TEXT    NOT NULL DEFAULT 'BOB' CHECK (moneda IN ('BOB','USD')),
  notas           TEXT    NOT NULL DEFAULT '',
  cancelado       INTEGER NOT NULL DEFAULT 0 CHECK (cancelado IN (0,1)),
  creado          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contratos_responsable ON contratos(responsable_id);
CREATE INDEX IF NOT EXISTS idx_contratos_difunto     ON contratos(difunto_id);
CREATE INDEX IF NOT EXISTS idx_contratos_nicho       ON contratos(nicho_id);

CREATE TABLE IF NOT EXISTS mensajes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre   TEXT NOT NULL,
  contacto TEXT NOT NULL,
  asunto   TEXT NOT NULL,
  mensaje  TEXT NOT NULL,
  creado   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

// Columnas permitidas por tabla (lista blanca: solo estas llegan a una sentencia SQL).
const TABLES = {
  usuarios: { cols: ["usuario", "nombre", "password_hash", "session_version", "rol", "activo", "creado"], bools: ["activo"] },
  responsables: { cols: ["nombre", "documento", "telefono", "email", "direccion", "notas"], bools: [] },
  difuntos: { cols: ["nombre", "documento", "nacimiento", "fallecimiento", "notas"], bools: [] },
  nichos: { cols: ["codigo", "sector", "fila", "nivel", "notas"], bools: [] },
  contratos: {
    cols: ["responsable_id", "difunto_id", "nicho_id", "inicio", "meses", "fin", "precio_centavos", "moneda", "notas", "cancelado", "creado"],
    bools: ["cancelado"],
  },
  mensajes: { cols: ["nombre", "contacto", "asunto", "mensaje", "creado"], bools: [] },
};
const ORDER = ["usuarios", "responsables", "difuntos", "nichos", "contratos", "mensajes"];

class Store {
  /**
   * @param {string} file         ruta de la base (data/mausoleo.db)
   * @param {object} [options]
   * @param {string} [options.legacyJson]  JSON de la versión anterior; si la base está vacía se importa una vez.
   */
  constructor(file, options = {}) {
    const { DatabaseSync } = loadSqlite();
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this._cache = new Map();
    if (options.legacyJson) this._maybeImport(options.legacyJson);
  }

  _stmt(sql) {
    let s = this._cache.get(sql);
    if (!s) { s = this.db.prepare(sql); this._cache.set(sql, s); }
    return s;
  }

  _table(name) {
    const t = TABLES[name];
    if (!t) throw new Error(`Tabla desconocida: ${name}`);
    return t;
  }

  _out(name, row) {
    if (!row) return null;
    const out = { ...row };
    for (const b of this._table(name).bools) out[b] = !!out[b];
    return out;
  }

  _in(name, values) {
    const t = this._table(name);
    const keys = Object.keys(values).filter((k) => t.cols.includes(k));
    const params = keys.map((k) => {
      let v = values[k];
      if (typeof v === "boolean") v = v ? 1 : 0;
      return v === undefined ? null : v;
    });
    return { keys, params };
  }

  /** Ejecuta varias sentencias como una sola operación: o se guardan todas o ninguna. */
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ya revertida */ }
      throw err;
    }
  }

  count(name) {
    this._table(name);
    return this._stmt(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
  }

  all(name) {
    this._table(name);
    return this._stmt(`SELECT * FROM ${name} ORDER BY id`).all().map((r) => this._out(name, r));
  }

  find(name, id) {
    this._table(name);
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return this._out(name, this._stmt(`SELECT * FROM ${name} WHERE id = ?`).get(n));
  }

  /** Cuenta de acceso por nombre de usuario (sin distinguir mayúsculas). */
  findUser(usuario) {
    return this._out("usuarios", this._stmt("SELECT * FROM usuarios WHERE usuario = ?").get(String(usuario)));
  }

  insert(name, values) {
    const { keys, params } = this._in(name, values);
    const sql = `INSERT INTO ${name} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    const info = this._stmt(sql).run(...params);
    return this.find(name, info.lastInsertRowid);
  }

  update(name, id, values) {
    const { keys, params } = this._in(name, values);
    if (!keys.length) return this.find(name, id);
    const sql = `UPDATE ${name} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
    const info = this._stmt(sql).run(...params, Number(id));
    return info.changes ? this.find(name, id) : null;
  }

  remove(name, id) {
    this._table(name);
    return this._stmt(`DELETE FROM ${name} WHERE id = ?`).run(Number(id)).changes > 0;
  }

  /** Copia consistente de toda la base en `target` (un archivo .db que se puede abrir con cualquier visor SQLite). */
  backupTo(target) {
    this.db.exec(`VACUUM INTO '${String(target).replace(/'/g, "''")}'`);
  }

  /* ---------------------------- Migración desde JSON ---------------------------- */

  _isEmpty() {
    return ORDER.every((t) => this.count(t) === 0);
  }

  _maybeImport(jsonFile) {
    const done = this._stmt("SELECT valor FROM meta WHERE clave = 'importado_json'").get();
    if (done || !this._isEmpty() || !fs.existsSync(jsonFile)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    } catch (err) {
      throw new Error(`No se pudo leer ${jsonFile} para migrarlo a SQLite (${err.message}). Corrígelo o muévelo de la carpeta data.`);
    }
    const resumen = this.importLegacy(parsed);
    this._stmt("INSERT OR REPLACE INTO meta (clave, valor) VALUES ('importado_json', ?)")
      .run(`${new Date().toISOString()} · ${path.basename(jsonFile)}`);
    const partes = Object.entries(resumen).map(([t, n]) => `${t}: ${n}`).join(", ");
    console.log(`Datos de ${path.basename(jsonFile)} migrados a SQLite (${partes}).`);
  }

  /** Copia los registros del JSON anterior conservando sus identificadores. */
  importLegacy(parsed) {
    const resumen = {};
    this.transaction(() => {
      for (const name of ORDER) {
        const t = this._table(name);
        const rows = Array.isArray(parsed[name]) ? parsed[name] : [];
        let ok = 0;
        for (const src of rows) {
          const row = { ...src };
          if (row.documento === "") row.documento = null;
          const { keys, params } = this._in(name, row);
          const sql = `INSERT INTO ${name} (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`;
          try {
            this._stmt(sql).run(Number(src.id), ...params);
          } catch (err) {
            // Un documento repetido en datos antiguos no debe impedir la migración: se conserva el registro sin documento.
            if (/UNIQUE/i.test(err.message) && t.cols.includes("documento") && row.documento) {
              const idx = keys.indexOf("documento");
              const p2 = [...params]; p2[idx] = null;
              const nIdx = keys.indexOf("notas");
              if (nIdx >= 0) p2[nIdx] = `${p2[nIdx] ? p2[nIdx] + " · " : ""}CI repetido en la migración: ${row.documento}`;
              this._stmt(sql).run(Number(src.id), ...p2);
            } else throw err;
          }
          ok += 1;
        }
        // Mantiene la numeración: los identificadores nuevos continúan donde iba el sistema anterior.
        const seq = Math.max(Number(parsed.seq?.[name]) || 0, rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0));
        if (seq > 0) {
          this.db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(name);
          this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(name, seq);
        }
        resumen[name] = ok;
      }
    });
    return resumen;
  }

  close() { this.db.close(); }
}

module.exports = { Store };
