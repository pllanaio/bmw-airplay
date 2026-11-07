'use strict';
const assert = require('assert');
// Run after build_app.py; this exercises the privately patched SDK copy.
const { Display } = require('../dist/pllana_airplay/source/javascript/kit/display');
const d = Object.create(Display.prototype);
Object.assign(d, { gpu: { ready: true, native: true, screen: { w: 1920, h: 720 }, place: p => { d.sent = p; } },
    settings: { get: () => 'full' }, screen: { bar: true }, recorders: new Map(), log: { info() {} },
    _grab() {}, _hmiBar() {}, _layoutChanged() {}, own: () => false, buttons: () => [] });
d._place();
const normal = Object.assign({}, d.sent);
d.setPresentation(true);
assert.deepStrictEqual(d.sent, { x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0, full: true });
let input = 0;
d.onPresentationInput = () => input++;
d._touch(1, 100, 100); assert.strictEqual(input, 0);
d._touch(3, 100, 100); assert.strictEqual(input, 1, 'touch restores controls without pressing a hidden button');
d.ccuLast = { k: 0, pb: 0, df: 0 };
d._ccu({ frontRotaryEncoderOperation: 1, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
assert.strictEqual(input, 2, 'controller restores controls without forwarding hidden input');
d.setPresentation(false); assert.deepStrictEqual(d.sent, normal, 'normal layout is restored');
const font = require('../dist/pllana_airplay/source/javascript/kit/fonts/airplay.json');
for (const size of font.sizes) for (const ch of 'äöüÄÖÜß„“…') assert(size.glyphs[ch.codePointAt(0)], 'missing glyph ' + ch);
console.log('Native 1920x720 fullscreen, control restoration and German glyphs passed');
