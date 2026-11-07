'use strict';
// Exercise the real private decoder and descriptor-anchored artwork reader.
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const { AudioMetadata } = require('../apps/pllana_airplay/audio_metadata');
const runtime = path.resolve(__dirname, '../.build/airplay/runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-artwork-runtime-'));
const sessions = [];
const turn = () => new Promise(resolve => setTimeout(resolve, 25));

async function decode(format, mime) {
    const image = cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'color=c=red:s=64x32', '-frames:v', '1', '-threads', '1', '-c:v', format === 'png' ? 'png' : 'mjpeg',
        '-f', 'image2pipe', 'pipe:1'], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const metadata = new AudioMetadata(root, { runtime });
    sessions.push(metadata);
    const file = 'cover.' + format;
    fs.writeFileSync(path.join(metadata.directory, file), image, { mode: 0o600 });
    fs.writeFileSync(path.join(metadata.directory, 'current.json'), JSON.stringify({
        revision: 1, title: 'Synthetic ' + format, artist: 'Local decoder test', album: 'Fixture',
        artwork: { file, mime, revision: 1, width: 64, height: 32 },
    }), { mode: 0o600 });
    let state;
    const deadline = Date.now() + 6000;
    do {
        state = metadata.poll();
        if (state.artwork) break;
        await turn();
    } while (Date.now() < deadline);
    assert(state.artwork, format + ' must decode with the actual bundled runtime');
    assert.strictEqual(state.artwork.width, 256);
    assert.strictEqual(state.artwork.height, 256);
    assert.strictEqual(state.artwork.mime, 'application/x-rgba');
    const pixels = fs.readFileSync(state.artwork.file);
    assert.strictEqual(pixels.length, 256 * 256 * 4);
    const center = (128 * 256 + 128) * 4;
    assert(pixels[center] > 200 && pixels[center + 1] < 40 && pixels[center + 2] < 40,
        format + ' decoded center must retain the synthetic red source');
    assert.strictEqual(pixels[center + 3], 255);
    assert.strictEqual(fs.statSync(state.artwork.file).mode & 0o077, 0, 'decoded artwork stays private');
    metadata.close();
    assert(!fs.existsSync(metadata.directory), 'decoder/session files are removed on close');
}

(async () => {
    try {
        await decode('png', 'image/png');
        await decode('jpg', 'image/jpeg');
        console.log('Private-runtime PNG/JPEG artwork decode, RGBA pixels, permissions and cleanup passed');
    } finally {
        sessions.forEach(metadata => metadata.close());
        fs.rmdirSync(root);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
