// Local test helper: fills a dev backend with molds and assignments, then posts
// PLC bytes once a second so the dashboards have live data.
//
//   node scripts/dev-simulate.mjs
//
// Env: API (default http://127.0.0.1:3901/api), DAEMON_API_KEY (default
// local-daemon-key), ADMIN_USER / ADMIN_PASS (default admin / admin123),
// FACTORY_UTC_OFFSET_MINUTES (default 300, must match the backend).
//
// Each wired machine gets one of these behaviours, in order:
//   running            power on, a unit every few seconds
//   intermittent       like running, but stops cycling 4 minutes in every 10
//                      (shows as a stoppage after the cycle timeout)
//   producing-no-power cycles arrive without the power signal
//   off                no signals at all

const API = process.env.API ?? 'http://127.0.0.1:3901/api';
const KEY = process.env.DAEMON_API_KEY ?? 'local-daemon-key';
const OFFSET_MIN = Number(process.env.FACTORY_UTC_OFFSET_MINUTES ?? 300);
const PLC_ID = 'default';

const BEHAVIOURS = [
  'running', 'running', 'running', 'intermittent',
  'running', 'running', 'producing-no-power', 'off',
];

async function call(method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const list = (value, key) => (Array.isArray(value) ? value : value?.[key] ?? []);

/** "Q1.3" -> bit index 11. */
function bitOf(pinId) {
  const m = /^Q(\d+)\.(\d)$/.exec(pinId);
  return m ? Number(m[1]) * 8 + Number(m[2]) : null;
}

const login = await call('POST', '/auth/login', {
  username: process.env.ADMIN_USER ?? 'admin',
  password: process.env.ADMIN_PASS ?? 'admin123',
});
const auth = { authorization: `Bearer ${login.token}` };

const machines = list(await call('GET', '/machines', null, auth), 'machines');
const users = list(await call('GET', '/users/admin/all', null, auth), 'users');
const operator = users.find((u) => u.role === 'operator') ?? users[0];

// One mold per department, sized so a healthy machine lands near 90% performance.
let molds = list(await call('GET', '/molds/admin/all?limit=100', null, auth), 'molds');
const departments = new Map(machines.map((m) => [m.departmentId?._id ?? m.departmentId, m.departmentId?.name ?? 'Department']));
for (const [departmentId, name] of departments) {
  if (molds.some((m) => (m.departmentId?._id ?? m.departmentId) === departmentId)) continue;
  await call('POST', '/molds', { name: `${name} mold A`, description: 'Simulator mold', productionCapacityPerHour: 1000, departmentId }, auth);
}
molds = list(await call('GET', '/molds/admin/all?limit=100', null, auth), 'molds');

// Wired machines, with the bit each of their signals lives on.
const wired = [];
for (const machine of machines) {
  const signals = await call('GET', `/machines/${machine._id}/signals`, null, auth);
  const power = signals.find((s) => s.role === 'power' && s.plcId === PLC_ID);
  const cycle = signals.find((s) => s.role === 'unit-cycle' && s.plcId === PLC_ID);
  if (!power || !cycle) continue;
  wired.push({
    id: machine._id,
    name: machine.name,
    departmentId: machine.departmentId?._id ?? machine.departmentId,
    powerBit: bitOf(power.pinId),
    cycleBit: bitOf(cycle.pinId),
    behaviour: BEHAVIOURS[wired.length % BEHAVIOURS.length],
    cycleEvery: 3 + (wired.length % 4), // seconds between units
  });
}
if (wired.length === 0) {
  console.error('No machine has both a power and a unit-cycle signal on PLC "default". Wire some in Setup first.');
  process.exit(1);
}

// Assign the mold and an operator for the current factory hour, for the shift.
const factoryNow = () => new Date(Date.now() + OFFSET_MIN * 60_000);
let assignedHour = -1;
async function assignCurrentHour() {
  const now = factoryNow();
  const hour = now.getUTCHours();
  if (hour === assignedHour) return;
  assignedHour = hour;
  const date = now.toISOString().slice(0, 10);
  for (const m of wired) {
    const mold = molds.find((x) => (x.departmentId?._id ?? x.departmentId) === m.departmentId);
    try {
      await call('POST', '/analytics/production-assignment', {
        machineId: m.id, hour, date, operatorId: operator?._id, moldId: mold?._id, defectiveUnits: 0, applyToShift: true,
      }, auth);
    } catch (e) {
      console.log(`  assignment for ${m.name} skipped: ${e.message}`);
    }
  }
}

console.log(`Simulating ${wired.length} machine(s) on PLC "${PLC_ID}" -> ${API}`);
for (const m of wired) console.log(`  ${m.name.padEnd(22)} ${m.behaviour}${m.behaviour === 'off' ? '' : `, a unit every ${m.cycleEvery}s`}`);
console.log('Ctrl+C to stop. About 5 minutes after stopping, the silent-PLC sweep sets the machines to inactive.\n');

const byteCount = Math.max(...wired.flatMap((m) => [m.powerBit, m.cycleBit])) >> 3;
const started = Date.now();
let tick = 0;
let units = 0;
let failures = 0;

async function step() {
  tick += 1;
  const elapsed = (Date.now() - started) / 1000;
  const bytes = new Uint8Array(byteCount + 1);
  const set = (bit) => { bytes[bit >> 3] |= 1 << (bit & 7); };

  for (const m of wired) {
    if (m.behaviour === 'off') continue;
    // Intermittent: minutes 3-7 of every 10 have power but no cycles.
    const paused = m.behaviour === 'intermittent' && elapsed % 600 >= 180 && elapsed % 600 < 420;
    if (m.behaviour !== 'producing-no-power') set(m.powerBit);
    if (!paused && tick % m.cycleEvery === 0) {
      set(m.cycleBit);
      units += 1;
    }
  }

  const pinData = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  try {
    await call('POST', '/signals/pin-data', { plcId: PLC_ID, pinData, timestamp: new Date().toISOString() }, { 'x-api-key': KEY });
    failures = 0;
  } catch (e) {
    failures += 1;
    if (failures === 1 || failures % 30 === 0) console.log(`  post failed (${failures}): ${e.message}`);
  }
  if (tick % 30 === 0) {
    console.log(`  ${new Date().toLocaleTimeString()}  ${tick} payloads, ${units} units sent`);
    await assignCurrentHour().catch((e) => console.log(`  assignment failed: ${e.message}`));
  }
}

await assignCurrentHour();
setInterval(() => { step(); }, 1000);
