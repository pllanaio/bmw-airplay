'use strict';
const assert = require('assert');
const { drawHome } = require('../apps/pllana_airplay/view');
const targets = [], labels = [], actions = [];
const c = { clear() {}, gradientRect() {}, image() {}, roundRect() {}, strokeRoundRect() {}, circle() {}, line() {},
    text: value => labels.push(value), target: (x, y, w, h, run, key) => targets.push({ run, key }) };
let artDraws = 0;
const state = { profile: 'auto', mode: 'audio', phase: 'audio', pin: '123456', music: { title: 'Testtitel', artist: 'Interpret', album: 'Album',
    playbackState: 'playing', shuffle: 1, repeat: 2, controls: { playPause: true, next: true, previous: true, shuffle: true, repeat: true } } };
drawHome(c, state, '', null, { draw() { artDraws++; return true; } }, action => actions.push(action));
assert.strictEqual(artDraws, 1); assert(labels.includes('Testtitel')); assert(labels.includes('Interpret')); assert(labels.includes('Album'));
assert(labels.includes('Pause')); assert(labels.includes('Shuffle: an')); assert(labels.includes('Repeat: alle'));
assert.deepStrictEqual(targets.map(t => t.key), ['music-previous', 'music-playPause', 'music-next', 'music-shuffle', 'music-repeat']);
targets.forEach(t => t.run()); assert.deepStrictEqual(actions, ['previous', 'playPause', 'next', 'shuffle', 'repeat']);
targets.length = 0; labels.length = 0;
drawHome(c, { profile: 'audio', phase: 'waiting', pin: '123456', music: {} }, '', null, null, () => {});
assert.strictEqual(targets.length, 0, 'unconfirmed controls have no input targets');
assert(labels.some(label => label.indexOf('Code 123456') >= 0), 'audio pairing code remains visible before metadata arrives');
assert(!labels.includes('Testtitel'), 'old track is not retained');
console.log('Audio cover, now-playing labels and five sender-gated touch/controller targets passed');
