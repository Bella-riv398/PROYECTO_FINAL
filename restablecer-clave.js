"use strict";
/* Restablece la contraseña de una cuenta desde la terminal (no existe recuperación por correo).
   Uso:  node restablecer-clave.js            -> cuenta principal
         node restablecer-clave.js nombre.usuario */
const readline = require("readline");
const crypto = require("crypto");
const path = require("path");
const { Store } = require("./lib/store");
const { validPassword } = require("./lib/logic");

let store;
try { store = new Store(path.join(__dirname, "data", "mausoleo.db")); }
catch (err) { console.error(err.message); process.exit(1); }
const wanted = process.argv[2];
const user = wanted
  ? store.findUser(wanted)
  : store.all("usuarios").find((u) => u.rol === "principal");
if (!user) { console.error(wanted ? `No existe el usuario "${wanted}".` : "Aún no hay cuentas. Abre /admin/ para crear la primera."); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
const write = rl._writeToOutput.bind(rl);
rl._writeToOutput = (text) => { if (!muted) write(text); else if (/[\r\n]/.test(text)) write(text); };
const ask = (question) => new Promise((resolve) => { rl.question(question, (a) => { muted = false; resolve(a); }); muted = true; });

(async () => {
  console.log(`Cuenta: ${user.nombre} (${user.usuario})`);
  process.stdout.write("");
  const first = await ask("Nueva contraseña (10 a 128 caracteres): ");
  const second = await ask("Repite la contraseña: ");
  rl.close();
  const errors = validPassword(first, second);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  const salt = crypto.randomBytes(16).toString("hex");
  store.update("usuarios", user.id, {
    password_hash: `scrypt$${salt}$${crypto.scryptSync(first, salt, 64).toString("hex")}`,
    session_version: user.session_version + 1,
    activo: true,
  });
  console.log("Contraseña actualizada. Se cerraron las sesiones anteriores de esa cuenta.");
})();
