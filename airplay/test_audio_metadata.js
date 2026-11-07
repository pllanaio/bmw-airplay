'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const EventEmitter = require('events');
const { AudioMetadata } = require('../apps/pllana_airplay/audio_metadata');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airplay-metadata-test-'));
const sessions = [];
function session(options) {
    const calls = [];
    const value = new AudioMetadata(root, Object.assign({ runtime: '/private/runtime', spawn: (bin, args, opts) => {
        const child = new EventEmitter(); child.stdout = new EventEmitter();
        child.kill = signal => { child.killed = signal; };
        calls.push({ bin, args, options: opts, child }); return child;
    } }, options || {}));
    value.calls = calls; sessions.push(value); return value;
}
function write(m, name, value) { fs.writeFileSync(path.join(m.directory, name), value, { mode: 0o600 }); }
function state(m, fields) { write(m, 'current.json', JSON.stringify(Object.assign({ revision: 1, title: 'Song', artist: 'Artist', album: 'Album', artwork: null }, fields || {}))); }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tN8AAAAASUVORK5CYII=', 'base64');
try {
    const m = session();
    assert.strictEqual(fs.statSync(m.directory).mode & 0o777, 0o700);
    assert.deepStrictEqual(m.env(), { MGU_AUDIO_METADATA_DIR: m.directory, MGU_MUSIC_DIR: m.directory });
    assert.strictEqual(m.poll().title, '');
    state(m, { title: '  First\n\t song\u0000\u202e 😀 ', artist: 'Björk', album: '音楽' });
    assert.deepStrictEqual(m.poll(), { revision: 1, title: 'First song 😀', artist: 'Björk', album: '音楽', artwork: null });
    state(m, { title: '😀'.repeat(300) });
    assert.strictEqual(Array.from(m.poll().title).length, 256, 'truncate whole Unicode characters');
    write(m, 'cover.png', png);
    state(m, { artwork: { file: 'cover.png', mime: 'image/png', revision: 2, width: 1, height: 1 } });
    assert.strictEqual(m.poll().artwork, null, 'artwork waits for bounded decode');
    assert.strictEqual(m.calls.length, 1);
    assert.strictEqual(m.calls[0].bin, '/private/runtime/lib/ld-linux-x86-64.so.2');
    assert(m.calls[0].args.includes('video/x-raw,format=RGBA,width=256,height=256,pixel-aspect-ratio=1/1'));
    assert(m.calls[0].args.includes('location=/proc/' + process.pid + '/fd/' + m.fd + '/decode-source'));
    assert.strictEqual(m.calls[0].options.env.GST_PLUGIN_SYSTEM_PATH_1_0, '');
    assert.strictEqual(m.calls[0].options.env.GST_PLUGIN_PATH_1_0, '/private/runtime/plugins');
    const pixels = Buffer.alloc(256 * 256 * 4, 255); pixels[0] = 200; pixels[3] = 128;
    m.calls[0].child.stdout.emit('data', pixels); m.calls[0].child.emit('close', 0, null);
    assert.deepStrictEqual(m.poll().artwork, { file: path.join(m.directory, 'thumbnail.rgba'), mime: 'application/x-rgba', revision: 2, width: 256, height: 256 });
    assert.strictEqual(fs.readFileSync(path.join(m.directory, 'thumbnail.rgba'))[0], 200, 'output remains straight RGBA for software renderer');
    assert.strictEqual(fs.statSync(path.join(m.directory, 'thumbnail.rgba')).mode & 0o777, 0o600);
    state(m, { revision: 3, title: 'Next song', artwork: null });
    assert.strictEqual(m.poll().artwork, null, 'old cover file is ignored after track change');
    assert.strictEqual(m.poll().title, 'Next song');
    assert(!fs.existsSync(path.join(m.directory, 'thumbnail.rgba')), 'track change removes stale decoded cover');
    state(m, { artwork: { file: '../private.png', mime: 'image/png', revision: 2, width: 1, height: 1 } });
    assert.strictEqual(m.poll().artwork, null);
    state(m, { artwork: { file: 'cover.png', mime: 'image/png', revision: 2, width: 2, height: 1 } });
    assert.strictEqual(m.poll().artwork, null, 'dimensions must match actual image');
    const wide = Buffer.from(png); wide.writeUInt32BE(4097, 16); write(m, 'cover.png', wide);
    state(m, { artwork: { file: 'cover.png', mime: 'image/png', revision: 2, width: 4097, height: 1 } });
    assert.strictEqual(m.poll().artwork, null, 'reject image resource abuse');
    write(m, 'cover.png', Buffer.alloc(2 * 1024 * 1024 + 1));
    assert.strictEqual(m.poll().artwork, null, 'reject oversized image before read');
    write(m, 'current.json', ' '.repeat(4097));
    assert.strictEqual(m.poll().title, '', 'oversized metadata is cleared');
    write(m, 'current.json', '{broken'); assert.strictEqual(m.poll().title, '');
    state(m, { revision: -1 }); assert.strictEqual(m.poll().title, '');
    state(m); fs.chmodSync(path.join(m.directory, 'current.json'), 0o644);
    assert.strictEqual(m.poll().title, '', 'metadata must remain private');
    fs.chmodSync(path.join(m.directory, 'current.json'), 0o600);

    const linked = session();
    fs.symlinkSync(path.join(m.directory, 'current.json'), path.join(linked.directory, 'current.json'));
    assert.strictEqual(linked.poll().title, '', 'never follow metadata symlink');
    linked.close();
    assert(fs.lstatSync(path.join(linked.directory, 'current.json')).isSymbolicLink(), 'cleanup does not remove suspicious replacements');
    fs.unlinkSync(path.join(linked.directory, 'current.json')); fs.rmdirSync(linked.directory);

    const hard = session();
    fs.linkSync(path.join(m.directory, 'current.json'), path.join(hard.directory, 'current.json'));
    assert.strictEqual(hard.poll().title, '', 'never read hard-linked metadata');
    hard.close(); assert(fs.existsSync(path.join(hard.directory, 'current.json')));
    fs.unlinkSync(path.join(hard.directory, 'current.json')); fs.rmdirSync(hard.directory);

    const artLink = session(); state(artLink, { artwork: { file: 'cover.png', mime: 'image/png', revision: 2, width: 1, height: 1 } });
    fs.symlinkSync(path.join(m.directory, 'cover.png'), path.join(artLink.directory, 'cover.png'));
    assert.strictEqual(artLink.poll().artwork, null, 'never follow artwork symlink');
    artLink.close(); fs.unlinkSync(path.join(artLink.directory, 'cover.png')); fs.rmdirSync(artLink.directory);

    const moved = session(); state(moved, { title: 'Original' });
    const originalPath = moved.directory + '-moved'; fs.renameSync(moved.directory, originalPath);
    const other = session(); state(other, { title: 'Replacement' });
    fs.symlinkSync(other.directory, moved.directory);
    assert.strictEqual(moved.poll().title, 'Original', 'directory replacement cannot redirect descriptor-anchored reads');
    moved.close(); assert(fs.lstatSync(moved.directory).isSymbolicLink());
    fs.unlinkSync(moved.directory); fs.rmdirSync(originalPath);

    const uid = process.getuid ? process.getuid() : 0;
    assert.throws(() => session({ uid: uid + 1 }), /invalid_audio_metadata_directory/);
    const publicDir = path.join(root, 'public'); fs.mkdirSync(publicDir, 0o755); fs.chmodSync(publicDir, 0o755);
    assert.throws(() => new AudioMetadata(publicDir), /invalid_audio_metadata_directory/); fs.rmdirSync(publicDir);
    m.close(); m.close(); assert.deepStrictEqual(m.env(), {}); assert.strictEqual(m.poll().title, '');
    assert(!fs.existsSync(m.directory), 'normal owned files are removed with session directory');

    const pending = session(); write(pending, 'cover.png', png);
    state(pending, { title: 'Before', artwork: { file: 'cover.png', mime: 'image/png', revision: 1, width: 1, height: 1 } });
    assert.strictEqual(pending.poll().artwork, null);
    const old = pending.calls[0].child;
    state(pending, { revision: 2, title: 'After', artwork: { file: 'cover.png', mime: 'image/png', revision: 2, width: 1, height: 1 } });
    assert.strictEqual(pending.poll().artwork, null);
    assert.strictEqual(old.killed, 'SIGKILL', 'a new track cancels the previous decode');
    old.stdout.emit('data', pixels); old.emit('close', 0, null);
    assert(!fs.existsSync(path.join(pending.directory, 'thumbnail.rgba')), 'late old decode cannot restore stale artwork');
    const current = pending.calls[1].child;
    current.stdout.emit('data', pixels.slice(0, pixels.length - 1)); current.emit('close', 0, null);
    assert.strictEqual(pending.poll().artwork, null, 'incomplete RGBA frame is rejected');
    assert.strictEqual(pending.calls.length, 2, 'failed artwork is not decoded repeatedly on every poll');
    state(pending, { revision: 3, title: 'Third', artwork: { file: 'cover.png', mime: 'image/png', revision: 3, width: 1, height: 1 } });
    pending.poll(); const overflow = pending.calls[2].child;
    overflow.stdout.emit('data', Buffer.alloc(256 * 256 * 4 + 1));
    assert.strictEqual(overflow.killed, 'SIGKILL', 'decoder stdout cannot exceed the one thumbnail frame');
    assert.strictEqual(pending.poll().artwork, null);
    state(pending, { revision: 4, title: 'Fourth', artwork: { file: 'cover.png', mime: 'image/png', revision: 4, width: 1, height: 1 } });
    pending.poll(); const closing = pending.calls[3].child;
    pending.close(); assert.strictEqual(closing.killed, 'SIGKILL', 'disconnect stops decoder');
    closing.stdout.emit('data', pixels); closing.emit('close', 0, null);
    assert(!fs.existsSync(pending.directory), 'decoder cannot recreate files after close');
    console.log('Audio metadata reader bounds, artwork, Unicode, ownership, links and session cleanup passed');
} finally {
    sessions.forEach(m => m.close());
    try { fs.rmdirSync(root); } catch (e) {}
}
