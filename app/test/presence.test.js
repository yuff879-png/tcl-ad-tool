'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PresenceMonitor } = require('../src/presence');
function fixture() {
  let time = 0, present = true, closes = 0, error = false;
  const logs = [];
  const engine = { running: true, stops: 0, log: (level, message) => logs.push({ level, message }), stop() { this.stops++; this.running = false; } };
  const monitor = new PresenceMonitor({ probe: async () => { if (error) throw new Error('probe failed'); return present; }, engine,
    close: async () => { closes++; }, canClose: () => !engine.running, now: () => time });
  return { monitor, engine, logs, step: async (ms, visible = present) => { time += ms; present = visible; await monitor.tick(); },
    fail: value => { error = value; }, closes: () => closes };
}
test('a visible or minimized native window keeps running for hours without JS heartbeats', async () => {
  const f = fixture();
  for (const ms of [0, 45001, 90001, 3600000]) await f.step(ms, true);
  assert.equal(f.engine.running, true); assert.equal(f.engine.stops, 0); assert.equal(f.closes(), 0);
  assert.ok(f.monitor.snapshot().heartbeatAgeSeconds > 3600); assert.equal(f.logs.length, 0);
});
test('closing the last native window pauses once after grace, then permits shutdown', async () => {
  const f = fixture(); await f.step(0, false); await f.step(9999);
  assert.equal(f.engine.running, true); await f.step(1); assert.equal(f.engine.stops, 1);
  await f.step(79000); assert.equal(f.closes(), 0); await f.step(1000); assert.equal(f.closes(), 1);
});

test('closing the legacy window also cancels an energy recovery wait', async () => {
  const f = fixture(); f.engine.running = false; f.engine.energyRecovery = {};
  f.engine.stop = function () { this.stops++; this.energyRecovery = null; };
  await f.step(0, false); await f.step(10000);
  assert.equal(f.engine.stops, 1); assert.equal(f.engine.energyRecovery, null);
});
test('brief window recreation does not stop work and reappearance resets absence time', async () => {
  const f = fixture(); await f.step(0, false); await f.step(9000, true); await f.step(90000, true);
  assert.equal(f.engine.running, true); assert.equal(f.closes(), 0);
  await f.step(0, false); await f.step(5000); assert.equal(f.engine.running, true);
});
test('failed native probes cannot masquerade as a closed window and warn only once', async () => {
  const f = fixture(); await f.step(0, false); f.fail(true); await f.step(90000); await f.step(90000);
  assert.equal(f.engine.running, true); assert.equal(f.closes(), 0); assert.equal(f.logs.length, 1);
  f.fail(false); await f.step(0, false); assert.equal(f.engine.running, true);
});
test('late heartbeat never resumes a previously paused campaign', async () => {
  const f = fixture(); await f.step(0, false); await f.step(10000); f.monitor.heartbeat(); await f.step(10000, true);
  assert.equal(f.engine.running, false); assert.equal(f.engine.stops, 1);
});
test('closing monitor ignores an in-flight native probe before accessing a closed database', async () => {
  let release, stops = 0;
  const monitor = new PresenceMonitor({ probe: () => new Promise(r => { release = r; }), now: () => 100000,
    engine: { running: true, stop: () => stops++, log: () => { throw new Error('database closed'); } }, canClose: () => true, close: async () => {} });
  const tick = monitor.tick(); monitor.stop(); release(false); await tick;
  assert.equal(stops, 0); assert.equal(monitor.lastCheck, null);
});
test('closed window pauses an active wallet preparation batch as well as campaigns', async () => {
  let now = 0, stops = 0;
  const pool = { running: true, async stop() { this.running = false; stops++; } };
  const monitor = new PresenceMonitor({ probe: async () => false, pool, now: () => now,
    engine: { running: false, stop() {}, log() {} }, canClose: () => false, close: async () => {} });
  await monitor.tick(); now = 10000; await monitor.tick();
  assert.equal(pool.running, false); assert.equal(stops, 1);
});
