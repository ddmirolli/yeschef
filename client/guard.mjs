// Who may act at the Pass: Dan, through the tailnet, from an allowed device, on the Pass's own page.
// The checks of the old Python pass's answer() (brigade spec, section 8): an agent on this Mac must never act as Dan.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** {logins, devices} from lines "login <email>" and "device <100.x.y.z>". No file: nobody. */
export function loadAllow(path) {
  const logins = new Set(), devices = new Set();
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const [kind, ...rest] = line.trim().split(' ');
      const value = rest.join(' ').trim();
      if (kind === 'login' && value) logins.add(value);
      else if (kind === 'device' && value) devices.add(value);
    }
  } catch { /* nobody */ }
  return { logins, devices };
}

// One `netstat -anv -p tcp` row: local and foreign address, then "process:pid" before the hex state column.
const ROW = /^tcp4\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+\S+\s+\d+\s+\d+\s+\d+\s+\d+\s+.+:(\d+)\s+[0-9a-f]{5}\s/;

/** PIDs that netstat names for the client end of one loopback connection to the Pass. */
export function peerPids(table, peerPort, serverPort) {
  const want = [`127.0.0.1.${peerPort}`, `127.0.0.1.${serverPort}`];
  const pids = new Set();
  for (const line of table.split('\n')) { const m = ROW.exec(line); if (m && m[1] === want[0] && m[2] === want[1]) pids.add(Number(m[3])); }
  return pids;
}

/** {uid, comm} of a live process, or null when ps cannot read it (the process has exited). */
async function procOf(pid) {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'uid=,comm=', '-p', String(pid)], { timeout: 10000 });
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
    return m ? { uid: Number(m[1]), comm: m[2] } : null;
  } catch { return null; }
}
// Tailscale's network extension (macOS app) or tailscaled (standalone), running as root. Anything else is refused,
// including Tailscale's own updater, which also runs as root (checked on Dan's Mac, 2026-11-06).
const TAILSCALE = /(\/io\.tailscale\.ipn[\w.]*\.network-extension|\/tailscaled)$/;

/** True unless netstat proves the TCP peer is Tailscale's own process, running as another user.
 *  Fails closed: no row, PID 0, an exited process, a process of this user, a process that is not
 *  Tailscale (another local user or service), or a netstat failure all count as local. */
export async function peerIsLocal(peerPort, serverPort, { table, proc = procOf, me = process.getuid() } = {}) {
  if (table == null) {
    try { table = (await run('/usr/sbin/netstat', ['-anv', '-p', 'tcp'], { timeout: 10000, maxBuffer: 16 << 20 })).stdout; }
    catch { return true; }
  }
  const pids = peerPids(table, peerPort, serverPort);
  if (!pids.size || pids.has(0)) return true;
  for (const pid of pids) { const p = await proc(pid); if (!p || p.uid !== 0 || p.uid === me || !TAILSCALE.test(p.comm)) return true; }
  return false;
}

/** null when the request may act, else the reason it may not. */
export async function refuse({ headers, peerPort, serverPort, origin, allowPath, peerCheck = peerIsLocal }) {
  if (await peerCheck(peerPort, serverPort)) return 'Actions come only through the tailnet. A process on this Mac cannot act at the Pass.';
  const { logins, devices } = loadAllow(allowPath);
  const login = headers['tailscale-user-login'] || '';
  const device = String(headers['x-forwarded-for'] || '').split(',').pop().trim();
  if (!logins.has(login) || !devices.has(device)) return "Only Dan's login on an allowed device can act at the Pass.";
  if (headers.origin !== origin) return 'Actions come only from the Pass page.';
  return null;
}
