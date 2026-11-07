'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airplay-artwork-'));
const images = new Map(), messages = [];
const moduleShim = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../apps/pllana_airplay/music_artwork_bridge.js'), 'utf8'), {
    require: name => name === './kit/record' ? { imageById: images, setImage: (id, w, h, data) => {
        const im = { w, h, data, ver: (images.get(id) || { ver: 0 }).ver + 1 }; images.set(id, im); return im;
    } } :
        name === './video_bridge' ? require('../apps/pllana_airplay/video_bridge') : require(name),
    module: moduleShim, Buffer, process
});
const { MusicArtworkBridge, ID } = moduleShim.exports;
const gpu = { ready: true, native: true, sock: {}, placement: {}, _write: b => messages.push(b) };
const bridge = new MusicArtworkBridge({ gpu }, root);
const dir = path.join(root, 'audio-meta-123-' + 'a'.repeat(24)), file = path.join(dir, 'thumbnail.rgba');
const c = { n: 0, _grow() {}, image() { this.soft = true; } }, words = new ArrayBuffer(1024);
c.u = new Uint32Array(words); c.f = new Float32Array(words);
try {
    fs.mkdirSync(dir, 0o700);
    const pixels = Buffer.alloc(256 * 256 * 4);
    for (let at = 0; at < pixels.length; at += 4) { pixels[at] = 240; pixels[at + 1] = 100; pixels[at + 3] = 128; }
    fs.writeFileSync(file, pixels, { mode: 0o600 });
    const art = { file, mime: 'application/x-rgba', width: 256, height: 256, revision: 1 };
    assert(bridge.update(art, 'first')); assert(bridge.draw(c, 48, 111, 300, 300));
    assert.strictEqual(messages[0].readUInt32LE(0), 10); assert.strictEqual(messages[0].readUInt32LE(8), ID);
    assert.strictEqual(messages[0].readUInt32LE(12), 256); assert.strictEqual(c.u[0], 18); assert.strictEqual(c.u[6], ID);
    assert.strictEqual(messages[0][20], 120, 'native renderer receives premultiplied alpha');
    assert.strictEqual(images.get(ID).data[0], 129, 'software renderer receives cover composited onto its card');
    assert.strictEqual(images.get(ID).data[3], 255);
    bridge.update(art, 'first'); bridge.draw(c, 48, 111, 300, 300);
    assert.strictEqual(messages.length, 1, 'same revision reuses thumbnail');
    gpu.sock = {}; bridge.draw(c, 48, 111, 300, 300); assert.strictEqual(messages.length, 2, 'renderer reconnect reuploads thumbnail');
    const oldVersion = images.get(ID).ver;
    assert(!bridge.update(null)); assert.strictEqual(messages[2].readUInt32LE(0), 11); assert(!images.has(ID), 'track reset clears old cover');
    assert(bridge.update(Object.assign({}, art, { revision: 2 }), 'first'));
    assert(images.get(ID).ver > oldVersion, 'replacement cover changes version despite dropping the previous SDK image');
    gpu.native = false; bridge.draw(c, 48, 111, 300, 300); assert(c.soft, 'fallback draws registered new image');
    bridge.drop(); gpu.native = true;
    fs.chmodSync(file, 0o644); assert(!bridge.update(art, 'second'), 'public artwork files rejected'); fs.chmodSync(file, 0o600);
    fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file); assert(!bridge.update(art, 'second'), 'symlink rejected'); fs.unlinkSync(file);
    fs.writeFileSync(file, Buffer.alloc(8), { mode: 0o600 }); assert(!bridge.update(art, 'second'), 'truncated artwork rejected');
    assert(!bridge.update(Object.assign({}, art, { file: '/tmp/thumbnail.rgba' }), 'second'), 'outside session rejected');
    console.log('Private bounded music artwork, native/software alpha, reuse and stale-resource cleanup passed');
} finally { bridge.drop(); fs.unlinkSync(file); fs.rmdirSync(dir); fs.rmdirSync(root); }
