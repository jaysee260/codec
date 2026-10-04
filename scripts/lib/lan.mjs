/** LAN address helpers shared by scripts/lan-proxy.mjs and scripts/cap-build-android.mjs. */
import os from 'node:os';

/** Default port of the LAN proxy (scripts/lan-proxy.mjs). Synapse itself stays on 127.0.0.1:8008. */
export const LAN_PROXY_PORT = Number(process.env.LAN_PROXY_PORT ?? 8009);

/**
 * Non-internal IPv4 addresses, physical adapters first (Wi-Fi/Ethernet), virtual ones last (WSL, Hyper-V,
 * Docker, VPNs). Each entry: `{ name, address, virtual }`.
 */
export function lanIPv4Addresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const virtual =
        /wsl|vethernet|hyper-v|docker|vmware|virtualbox|vpn|tailscale|zerotier|loopback|bluetooth/i.test(name) ||
        a.address.startsWith('169.254.');
      out.push({ name, address: a.address, virtual });
    }
  }
  out.sort((x, y) => Number(x.virtual) - Number(y.virtual) || x.name.localeCompare(y.name));
  return out;
}

/** Best guess for the address a phone on the same Wi-Fi can reach, or undefined when offline. */
export function primaryLanIPv4() {
  return lanIPv4Addresses()[0]?.address;
}

/** `http://<ip>:<port>` for the homeserver as seen from the phone. */
export function lanHomeserverUrl(port = LAN_PROXY_PORT, ip = primaryLanIPv4()) {
  return ip ? `http://${ip}:${port}` : undefined;
}
