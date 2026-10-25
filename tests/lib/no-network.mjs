// Network guard for the fast test layer (npm test): preloaded with `node --import` by
// scripts/run-tests.mjs and inherited by every test file process of `node --test`.
//
// Every TCP connection goes through net.Socket.prototype.connect (http, https, fetch/undici,
// tls, net.connect), so refusing non-loopback hosts there blocks any real network access,
// including a model download, before DNS is even asked. Loopback stays allowed for local
// fixture servers. Blocked attempts are recorded in globalThis.__vhoNetworkGuard.blocked.
import net from "node:net";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class NetworkBlockedError extends Error {
  constructor(target) {
    super(`network access blocked in the unit test layer: ${target} (real network/model tests belong in npm run test:ai)`);
    this.name = "NetworkBlockedError";
    this.code = "ERR_VHO_NETWORK_BLOCKED";
  }
}

function targetOf(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // internal normalized form: [options, cb]
  if (a && typeof a === "object") {
    if (a.path) return { local: true, label: `ipc ${a.path}` };
    return { host: a.host ?? "localhost", port: a.port };
  }
  if (typeof a === "number" || /^\d+$/.test(String(a))) return { host: typeof args[1] === "string" ? args[1] : "localhost", port: a };
  return { local: true, label: `ipc ${a}` }; // named pipe / unix socket path
}

if (!globalThis.__vhoNetworkGuard) {
  const guard = { blocked: [] };
  globalThis.__vhoNetworkGuard = guard;
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const t = targetOf(args);
    if (!t.local && !LOOPBACK.has(String(t.host).toLowerCase())) {
      const label = `${t.host}:${t.port}`;
      guard.blocked.push(label);
      const err = new NetworkBlockedError(label);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return realConnect.apply(this, args);
  };
}
