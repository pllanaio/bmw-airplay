'use strict';
const assert = require('assert');
const { drawHome } = require('../apps/pllana_airplay/view');
const targets = [], labels = [], actions = [];
const c = { clear() {}, gradientRect() {}, image() {}, roundRect() {}, strokeRoundRect() {}, circle() {}, line() {},fillRect(){},quad(){},card(){},
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
for(const mode of ['waiting','mirror','hls','audio']) {
    labels.length=0;
    drawHome(c,{profile:'auto',connected:true,phase:'waiting',mode,pin:'123456',music:{}},'',null,null,()=>{});
    assert(labels.includes('Mit iPhone verbunden'),'connected status remains clear between '+mode+' items');
    assert(!labels.includes('Empfang bereit'),'active connection is not shown as merely ready');
    assert(!labels.some(label=>String(label).indexOf('Code')>=0),'connected state hides the pairing instruction');
    assert(!labels.some(label=>/^[123456]$/.test(label)),'connected state hides PIN digits');
}
labels.length=0;
drawHome(c,{profile:'auto',connected:false,phase:'waiting',mode:'waiting',pin:'123456'},'',null,null,()=>{});
assert(labels.includes('Empfang bereit'));assert(labels.includes('1'),'pairing code returns after the phone disconnects');
const compactTargets=[],compactText=[],compactCover=[];
const compact=Object.assign({},c,{h:380,text:(value,x,y,size)=>compactText.push({value,y,size}),target:(x,y,w,h)=>compactTargets.push({y,h})});
drawHome(compact,state,'',null,{draw(canvas,x,y,w,h){compactCover.push({y,h});return true;}},()=>{});
assert.strictEqual(compactTargets.length,5);
assert(compactTargets.every(target=>target.y>=0&&target.y+target.h<=380),'all short-screen controls remain visible and touchable');
assert(compactCover.every(cover=>cover.y>=0&&cover.y+cover.h<=380),'complete cover remains inside the short body');
assert(compactText.every(text=>text.y<=380),'status, metadata and footer are not clipped on a 504-high screen');
console.log('Audio controls and connected/ready views with pairing code only while disconnected passed');
