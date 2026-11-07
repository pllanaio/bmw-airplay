'use strict';
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '../..');
const config = path.join(root, '.local/development.json');
let sdk = process.env.MGU_SDK_PATH || (fs.existsSync(config) ? JSON.parse(fs.readFileSync(config)).sdkPath : null);
if (!sdk) throw Error('Set MGU_SDK_PATH or .local/development.json sdkPath');
fs.mkdirSync(path.join(root, '.local/airplay'), { recursive: true });
if (process.platform !== 'win32') sdk = sdk.replace(/^([A-Z]):/i, (_, d) => '/mnt/' + d.toLowerCase());
const { Recorder, play, setImage } = require(path.join(sdk, 'kit/runtime/record'));
const { Canvas } = require(path.join(sdk, 'kit/runtime/canvas'));
const { drawHome } = require('../../apps/pllana_airplay/view');
require('../../apps/pllana_airplay/brand_logo').register(setImage);
const fonts = require(path.join(sdk, 'kit/runtime/fonts'));
const zlib = require('zlib');
const family = JSON.parse(fs.readFileSync(path.join(root, '.build/airplay/ui-fonts/airplay.json')));
const originalGet = fonts.get;
fonts.get = (name, size, str) => {
    if (name !== 'airplay') return originalGet(name, size, str);
    const f = family.sizes.find(f => f.size >= size) || family.sizes[family.sizes.length - 1];
    if (!f.alphaBuffer) f.alphaBuffer = zlib.inflateSync(Buffer.from(f.alpha, 'base64'));
    return Object.assign({}, f, { family: 'airplay', cacheKey: 'de-1', alpha: f.alphaBuffer });
};
for (const phase of ['stopped', 'waiting', 'error']) {
    const c = new Recorder(1600, 520);
    drawHome(c, { phase, pin: phase === 'waiting' ? '123456' : '', error: phase === 'error' ? 'receiver_failed' : null }, '');
    const image = play(c.words(), new Canvas(1600, 520));
    fs.writeFileSync(path.join(root, '.local/airplay/ui-' + phase + '.png'), image.png());
}
console.log('UI previews rendered');
