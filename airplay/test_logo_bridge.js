'use strict';
const assert = require('assert'), { LogoBridge } = require('../apps/pllana_airplay/logo_bridge');
const brand = require('../apps/pllana_airplay/brand_logo');
const messages = [];
const gpu = { ready: true, native: true, sock: {}, placement: { w: 1920, h: 720, scale: 1 }, _write: b => messages.push(b) };
const c = { n: 0, _grow() {} }, buffer = new ArrayBuffer(128);
c.u = new Uint32Array(buffer); c.f = new Float32Array(buffer);
const logo = new LogoBridge({ gpu });
logo.draw(c, 38, 18, 64, 64);
assert.strictEqual(messages[0].readUInt32LE(0), 10, 'native picture upload, never upstream IMAGE 9');
assert.strictEqual(messages[0].readUInt32LE(8), brand.ID);
assert.strictEqual(messages[0].readUInt32LE(12), 128);
assert.strictEqual(c.u[0], 18); assert.strictEqual(c.f[1], 38); assert.strictEqual(c.f[2], 18);
assert.strictEqual(c.u[6], brand.ID, 'native draw operation has ID last');
for (let at = 20; at < messages[0].length; at += 4) {
    const alpha = messages[0][at + 3];
    for (let k = 0; k < 3; k++) assert(messages[0][at + k] <= alpha, 'premultiplied RGBA');
}
logo.draw(c, 38, 18, 64, 64); assert.strictEqual(messages.length, 1);
gpu.placement.scale = 1.1;
logo.draw(c, 38, 18, 64, 64); assert.strictEqual(messages.length, 2);
console.log('Native logo protocol, alpha blending and resource reuse passed');
