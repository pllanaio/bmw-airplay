'use strict';
const assert = require('assert');
const path = require('path');
// Run after build_app.py; this exercises the privately patched SDK copy.
const kit = process.env.MGU_PRESENTATION_KIT || path.resolve(__dirname, '../dist/pllana_airplay/source/javascript/kit');
const { Display } = require(path.join(kit, 'display'));
const d = Object.create(Display.prototype);
Object.assign(d, { gpu: { ready: true, native: true, screen: { w: 1920, h: 504 }, place: p => { d.sent = p; } },
    settings: { get: () => 'full' }, screen: { bar: true }, recorders: new Map(), log: { info() {} },
    _grab() {}, _hmiBar() {}, _layoutChanged() {}, own: () => false, buttons: () => [] });
d._place();
const normal = Object.assign({}, d.sent);
d.setPresentation(true);
assert.deepStrictEqual(d.sent, { x: 0, y: 0, w: 1920, h: 504, scale: 1, ox: 0, oy: 0, full: true });
let input = 0;
d.onPresentationInput = () => input++;
d._touch(1, 100, 100); assert.strictEqual(input, 0);
d._touch(3, 100, 100); assert.strictEqual(input, 1, 'touch restores controls without pressing a hidden button');
d.ccuLast = { k: 0, pb: 0, df: 0 };
d._ccu({ frontRotaryEncoderOperation: 1, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
assert.strictEqual(input, 2, 'controller restores controls without forwarding hidden input');
d.setPresentation(false); assert.deepStrictEqual(d.sent, normal, 'normal layout is restored');
d.gpu.screen = { w: 1920, h: 720 };
d.setPresentation(true);
assert.deepStrictEqual(d.sent, { x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0, full: true },
    'presentation follows actual GPU bounds rather than a fixed display height');
d.setPresentation(false);
// MAIN uses the app's private borderless native layout, preserving its own
// bottom controls and input routing instead of exposing the HMI title/column.
const { Recorder } = require(path.join(kit, 'record'));
const G = require(path.join(kit, 'gauges'));
const screen = require(path.join(kit, 'app-spec.json')).screens[0];
assert.strictEqual(screen.borderless, true);
assert.notStrictEqual(screen.chrome, false, 'borderless layout must keep the native video/input protocol');
const b = Object.create(Display.prototype), clicks = [];
Object.assign(b, { gpu: { ready: true, native: true, touch: true, screen: { w: 1920, h: 720 },
    place: p => { b.sent = p; }, claim: r => { b.claimed = r; } },
    settings: { get: () => 'standard' }, screen, spec: { title: screen.title }, recorders: new Map(),
    labels: {}, ownHidden: new Set(), barOff: 0, pageTargets: [], pageScroll: false,
    log: { info() {}, error(e) { throw e; } }, _grab() {}, _hmiBar() {}, _layoutChanged() {}, _repaint() {},
    _click: id => clicks.push(id), theme: () => ({ bg:'#050b16', text:'#ffffff', dim:'#aabbcc', accent:'#198dcc' }) });
b._place();
assert.deepStrictEqual(b.sent, { x: 0, y: 0, w: 1920, h: 720, scale: 1.2, ox: 0, oy: 0, full: true });
assert.deepStrictEqual(b.contentSize(), { w: 1600, h: 560 });
assert.strictEqual(b.headH(), 0);
assert.strictEqual(b.own(), true);
assert.strictEqual(b.ownable(), true);
const labels = [], menus = [];
let transparentClears = 0, headers = 0;
const oldClear = Recorder.prototype.clear, oldText = Recorder.prototype.text, oldHeader = G.header, oldMenu = G.menuBar;
Recorder.prototype.clear = function (color) { transparentClears++; return oldClear.call(this, color); };
Recorder.prototype.text = function (text) { labels.push(String(text)); return oldText.apply(this, arguments); };
G.header = function () { headers++; return oldHeader.apply(this, arguments); };
G.menuBar = function (c, t, x, y, w, h, buttons) { menus.push({ x,y,w,h,buttons }); return oldMenu.apply(this, arguments); };
try { b._drawChrome(new Recorder(1600, 560)); }
finally { Recorder.prototype.clear = oldClear; Recorder.prototype.text = oldText; G.header = oldHeader; G.menuBar = oldMenu; }
assert.strictEqual(headers, 0, 'the private layout draws no SDK title or status header');
assert.strictEqual(transparentClears, 0, 'no transparent clear exposes the HMI left/top strips');
assert.strictEqual(menus.length, 1);
assert.deepStrictEqual([menus[0].x,menus[0].y,menus[0].w,menus[0].h], [0,672,1920,48]);
assert.deepStrictEqual(labels, screen.buttons.map(button => button[1].toUpperCase()), 'only the five bottom labels are drawn');
b._claimTabs([], null);
assert.deepStrictEqual(b.claimed, [{ i:undefined,x:0,y:0,w:1600,h:600 }], 'touch includes the complete body and bottom menu');
const buttons = b.buttons();
assert.strictEqual(buttons.length, 5); assert.strictEqual(buttons[0].x, 0);
assert.strictEqual(buttons[4].x + buttons[4].w, 1920, 'all five bottom controls fit the owned viewport');
const first = buttons[0];
b._touch(1, (first.x + first.w / 2) / b.place.scale, 696 / b.place.scale);
b._touch(3, (first.x + first.w / 2) / b.place.scale, 696 / b.place.scale);
assert.deepStrictEqual(clicks, [first.id], 'bottom touch still invokes its exact button');
b.ccuLast = { k:0,pb:0,df:0 };
for (let i=1;i<=5;i++) b._ccu({ frontRotaryEncoderOperation:i, frontRotaryEncoderPushButton:0, frontRotaryEncoderDeflection:0 });
assert.strictEqual(b.focused, buttons[4].id, 'all five controls remain reachable by iDrive');
b._ccu({ frontRotaryEncoderOperation:5, frontRotaryEncoderPushButton:1, frontRotaryEncoderDeflection:0 });
assert.strictEqual(clicks[1], buttons[4].id, 'iDrive press invokes the focused bottom control');
const last = buttons[4];
b._touch(1, (last.x + last.w / 2) / b.place.scale, 696 / b.place.scale);
b._touch(3, (last.x + last.w / 2) / b.place.scale, 696 / b.place.scale);
assert.strictEqual(clicks[2], last.id, 'the rightmost control is directly touchable without scrolling');
b.setPresentation(true); assert.deepStrictEqual(b.contentSize(), { w:1920,h:720 });
b.setPresentation(false); assert.deepStrictEqual(b.contentSize(), { w:1600,h:560 });
b.gpu.screen = {w:1920,h:504}; b._place();
assert.deepStrictEqual(b.contentSize(), {w:1600,h:380}); assert.strictEqual(b.ownable(), true);
b.gpu.ready = false; assert.strictEqual(b.contentSize(), null, 'unavailable native mode lets the caller use its compatibility size');
const font = require(path.join(kit, 'fonts/airplay.json'));
for (const size of font.sizes) for (const ch of 'äöüÄÖÜß„“…') assert(size.glyphs[ch.codePointAt(0)], 'missing glyph ' + ch);
console.log('Native borderless body, no HMI header/left holes, five touch/iDrive controls, dynamic content size and reversible fullscreen passed');
