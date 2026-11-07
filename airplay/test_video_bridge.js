'use strict';
const assert = require('assert');
const { VideoBridge } = require('../apps/pllana_airplay/video_bridge');
const messages = [];
const gpu = { ready: true, native: true, info: { video: true }, sock: {},
    placement: { w: 1920, h: 600, scale: 1 }, _write: b => messages.push(b.readUInt32LE(0)) };
const bridge = new VideoBridge({ gpu });
assert(bridge.attach('/dev/shm/mgu-video-test', '1:42'));
bridge.attach('/dev/shm/mgu-video-test', '1:42');
assert.deepStrictEqual(messages, [13], 'stable frames do not reopen the native transport');
bridge.attach('/dev/shm/mgu-video-test', '1:43');
assert.deepStrictEqual(messages, [13, 13], 'HLS file replacement reopens its new inode');
gpu.placement.h = 520;
bridge.attach('/dev/shm/mgu-video-test', '1:43');
assert.strictEqual(messages.length, 3, 'layout resize redefines discarded video');
gpu.sock = {};
bridge.attach('/dev/shm/mgu-video-test', '1:43');
assert.strictEqual(messages.length, 4, 'renderer reconnect redefines video');
bridge.detach();
assert.strictEqual(messages[4], 14);
function draw(frame, target, fit) {
    const bytes = new ArrayBuffer(256), c = { n: 0, f: new Float32Array(bytes), u: new Uint32Array(bytes),
        _grow() {}, clip(x, y, w, h) {
            this.u[this.n++] = 13;
            [x, y, w, h].forEach(v => { this.f[this.n++] = v; });
            return this;
        }, noclip() { this.u[this.n++] = 14; return this; } };
    bridge.draw(c, target.x, target.y, target.w, target.h, frame, fit);
    return c;
}
function near(a, b) { assert(Math.abs(a - b) < 0.002, a + ' != ' + b); }
const formats = [[1920, 1080], [2520, 1080], [1920, 1200], [1080, 1920], [2560, 504], [1920, 504]];
for (const target of [{ x: 0, y: 0, w: 1920, h: 504 }, { x: 20, y: 30, w: 1600, h: 520 }]) {
    for (const size of formats) for (const fit of [undefined, 'stretch', 'contain', 'cover']) {
        const c = draw({ width: size[0], height: size[1] }, target, fit);
        assert.strictEqual(c.n, 7, 'video never inserts a clip or expands outside its viewport');
        assert.strictEqual(c.u[0], 19);
        [target.x, target.y, target.w, target.h].forEach((v, i) => near(c.f[i + 1], v));
        assert.strictEqual(c.f[5], 0, 'the documented corner radius stays zero');
        assert.strictEqual(c.u[6], 1);
        // Model the renderer's documented contain behavior. Every source
        // corner remains inside the target, even with an older runtime.
        const scale = Math.min(target.w / size[0], target.h / size[1]);
        const left = target.x + (target.w - size[0] * scale) / 2;
        const top = target.y + (target.h - size[1] * scale) / 2;
        assert(left >= target.x - 0.002 && top >= target.y - 0.002);
        assert(left + size[0] * scale <= target.x + target.w + 0.002);
        assert(top + size[1] * scale <= target.y + target.h + 0.002);
    }
}
assert.strictEqual(draw(null, { x: 0, y: 0, w: 1920, h: 504 }).n, 0);
assert.strictEqual(draw({ width: 1920, height: 504 }, { x: 0, y: 0, w: 0, h: 504 }, 'stretch').n, 0);
console.log('Video transport replacement, resize/reconnect and complete uncropped source for stretch/legacy/contain in six aspect ratios passed');
