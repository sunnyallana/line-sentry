// Ingestion benchmark: how fast the backend takes PLC payloads, and whether
// every unit it was sent ends up counted.
//
//   node scripts/bench-ingest.mjs
//
// Env: API (default http://127.0.0.1:3901/api), DAEMON_API_KEY (default
// local-daemon-key), ADMIN_USER / ADMIN_PASS (default admin / admin123),
// MACHINES (default 8), PAYLOADS (default 600), CONCURRENCY (default 8),
// LABEL (free text shown in the result).
//
// Run it against a backend started with FACTORY_UTC_OFFSET_MINUTES=0 on an
// EMPTY database: it creates its own department and machines, and the unit
// check assumes nothing else is posting.
//
// Every payload sets every machine's power and cycle bit, so each one is the
// worst case for the pipeline: one unit per machine per payload.

const API = process.env.API ?? 'http://127.0.0.1:3901/api';
const KEY = process.env.DAEMON_API_KEY ?? 'local-daemon-key';
const MACHINES = Number(process.env.MACHINES ?? 8);
const PAYLOADS = Number(process.env.PAYLOADS ?? 600);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const LABEL = process.env.LABEL ?? API;

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

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const round = (n) => Math.round(n * 100) / 100;

await call('POST', '/auth/init-demo', {});
const { token } = await call('POST', '/auth/login', {
  username: process.env.ADMIN_USER ?? 'admin',
  password: process.env.ADMIN_PASS ?? 'admin123',
});
const auth = { authorization: `Bearer ${token}` };

// One department, MACHINES machines, each with a power and a unit-cycle signal
// on consecutive pins of the default PLC.
const byteCount = Math.ceil((MACHINES * 2) / 8);
const plcs = await call('GET', '/plcs', null, auth);
const plc = plcs.find((p) => p.plcId === 'default');
if (plc && plc.byteCount < byteCount) {
  await call('PUT', `/plcs/${plc._id}`, { ...plc, byteCount }, auth);
}
const department = await call('POST', '/departments', { name: `Bench ${Date.now()}`, description: 'Benchmark' }, auth);
const machines = [];
for (let i = 0; i < MACHINES; i++) {
  const m = await call('POST', '/machines', { name: `Bench ${i + 1}`, departmentId: department._id }, auth);
  const pin = (n) => `Q${Math.floor(n / 8)}.${n % 8}`;
  await call('POST', `/machines/${m._id}/signals`, { plcId: 'default', pinId: pin(i * 2), role: 'power' }, auth);
  await call('POST', `/machines/${m._id}/signals`, { plcId: 'default', pinId: pin(i * 2 + 1), role: 'unit-cycle' }, auth);
  machines.push(m._id);
}
const allOn = 'ff'.repeat(byteCount);

// A fixed hour today, so the unit check reads one bucket per machine.
const day = new Date().toISOString().slice(0, 10);
const base = Date.parse(`${day}T03:00:00.000Z`);
let sequence = 0;
const nextTimestamp = () => new Date(base + sequence++ * 250).toISOString();

async function post() {
  const started = performance.now();
  await call('POST', '/signals/pin-data', { plcId: 'default', pinData: allOn, timestamp: nextTimestamp() }, { 'x-api-key': KEY });
  return performance.now() - started;
}

async function run(total, concurrency) {
  const latencies = [];
  const started = performance.now();
  let issued = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (issued < total) {
        issued += 1;
        latencies.push(await post());
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    payloads: latencies.length,
    payloadsPerSecond: round(latencies.length / seconds),
    unitsPerSecond: round((latencies.length * MACHINES) / seconds),
    msMean: round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    msP50: round(percentile(latencies, 50)),
    msP95: round(percentile(latencies, 95)),
    msP99: round(percentile(latencies, 99)),
  };
}

async function unitsCounted() {
  let total = 0;
  for (const id of machines) {
    const { timeline } = await call(
      'GET',
      `/analytics/production-timeline/${id}?timeframe=custom&startDate=${day}&endDate=${day}`,
      null,
      auth,
    );
    for (const d of timeline ?? []) for (const h of d.hours ?? []) total += h.unitsProduced ?? 0;
  }
  return total;
}

await run(40, 1); // warm caches and create the hour buckets
const warmUnits = await unitsCounted();

const sequential = await run(PAYLOADS, 1);
const afterSequential = await unitsCounted();
const concurrent = await run(PAYLOADS, CONCURRENCY);
const afterConcurrent = await unitsCounted();

const check = (sent, counted) => ({ sent, counted, lost: sent - counted });
console.log(
  JSON.stringify(
    {
      label: LABEL,
      machines: MACHINES,
      sequential: { ...sequential, units: check(PAYLOADS * MACHINES, afterSequential - warmUnits) },
      [`concurrent x${CONCURRENCY}`]: { ...concurrent, units: check(PAYLOADS * MACHINES, afterConcurrent - afterSequential) },
    },
    null,
    2,
  ),
);
