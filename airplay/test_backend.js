'use strict';
const assert = require('assert'), vm = require('vm'), fs = require('fs'), EventEmitter = require('events');
const sockets = [], writes = [], timers = [];
let receiver, route, accept;
class Receiver extends EventEmitter {
    constructor() { super(); receiver = this; this.state = {}; this.child = null; this.starts = 0; this.stops = 0; }
    start(options) { this.child = {}; this.starts++; this.lastOptions = options; this.update({phase:'waiting', error:null}); return true; }
    crash() { this.child = null; this.update({phase:'error', error:'receiver_failed'}); this.emit('ended'); }
    stop() { this.child = null; this.stops++; return Promise.resolve(); }
    update(fields) { Object.assign(this.state, fields); this.emit('state', this.state); }
}
class AudioRoute {
    constructor() { route = this; this.owned = false; this.available = false; }
    acquire() { if (!this.available) return Promise.reject(Error('audio_route_in_use')); this.owned = true; return Promise.resolve(); }
    release() { this.owned = false; return Promise.resolve(); }
    check() { return Promise.resolve(this.available); }
}
const scheduled = [];
const fakeSetTimeout = (fn, ms) => { const t = { fn, ms }; scheduled.push(t); return t; };
const fakeClearTimeout = t => { const i = scheduled.indexOf(t); if (i >= 0) scheduled.splice(i, 1); };
const fire = ms => { const t = scheduled.find(x => x.ms === ms); assert(t, 'timer ' + ms + ' scheduled'); fakeClearTimeout(t); t.fn(); };
const server = new EventEmitter();
server.listen = (p, cb) => cb(); server.close = () => {};
let socketInode = 1, exitCode = null;
const fakeFs = {existsSync:()=>true,lstatSync:()=>({isSocket:()=>true,uid:12233}),unlinkSync:()=>{},writeFileSync:()=>{},chmodSync:()=>{},
    statSync:p=>({dev:1,ino:/control\.sock$/.test(p)?socketInode:7,mtime:new Date(0)})};
const modules = {
    './resolver':{refresh:()=>{}},fs:fakeFs,path:require('path'),'./receiver':{Receiver},
    './audio_route':{AudioRoute,AUDIO_SINK:'fakesink'},'./kit/signals':{},
    net:{createServer:cb=>{accept=cb; return server;}}
};
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'../apps/pllana_airplay/backend.js'),'utf8'), {
    require:name=>{assert(modules[name],name); return modules[name];},
    __dirname:'/app/source/javascript',__filename:'/app/source/javascript/backend.js',Buffer,Promise,Date,JSON,Error,
    process:{getuid:()=>12233,env:{},on:()=>{},exit:code=>{exitCode=code;}},
    setInterval:fn=>{timers.push(fn); return {unref:()=>{}};},clearInterval:()=>{},setTimeout:fakeSetTimeout,clearTimeout:fakeClearTimeout
});
const turn = () => new Promise(resolve=>setImmediate(resolve));
(async()=>{
    const s = new EventEmitter(); s.destroyed=false; s.writableLength=0;
    s.setEncoding=()=>{}; s.write=data=>writes.push(JSON.parse(data));
    s.destroy=()=>{s.destroyed=true;s.emit('close');};
    accept(s);
    s.emit('data','{"command":"start"}\n'); await turn();
    assert(receiver.child,'busy BMW audio must not prevent receiver discovery');
    assert.strictEqual(receiver.state.phase,'waiting');
    assert.strictEqual(receiver.state.audio,false);
    assert.strictEqual(receiver.state.audioError,'audio_unavailable');
    route.available=true; receiver.emit('media'); await turn();
    assert(route.owned); assert.strictEqual(receiver.state.audio,true);
    route.available=false; timers[1](); await turn();
    assert(receiver.child,'losing audio focus must preserve AirPlay');
    assert(!route.owned);
    route.available=true; s.emit('data','{"command":"start"}\n'); await turn();
    assert.strictEqual(receiver.starts,1,'retry audio without replacing receiver/password');
    // Video started from mirroring is detached from the phone once it plays.
    receiver.detaches = 0; receiver.detach = () => { receiver.detaches++; return true; };
    receiver.update({ returnMode: 'waiting', mode: 'hls' }); receiver.emit('media', 'hls');
    assert(!scheduled.some(t => t.ms === 1500), 'a direct AirPlay video needs no detaching');
    receiver.update({ returnMode: 'mirror', mode: 'hls' }); receiver.emit('media', 'hls');
    fire(1500); assert.strictEqual(receiver.detaches, 1, 'video from mirroring is detached');
    receiver.resumes = 0; receiver.resumeMirror = () => { receiver.resumes++; return true; };
    s.emit('data', '{"command":"resume-mirror"}\n'); await turn(); assert.strictEqual(receiver.resumes, 1);
    receiver.update({ returnMode: 'waiting', mode: 'waiting' });
    // Native receiver crash: automatic restart with the known password.
    receiver.crash(); await turn();
    assert.strictEqual(receiver.state.phase, 'recovering');
    fire(1000); await turn(); await turn();
    assert(receiver.child, 'crashed receiver restarts automatically');
    assert.strictEqual(receiver.lastOptions && receiver.lastOptions.keepPassword, true, 'restart keeps the password');
    receiver.crash(); await turn(); assert(scheduled.some(t => t.ms === 2000), 'second failure backs off');
    fire(2000); await turn(); await turn(); assert(receiver.child);
    // Frontend vanishes (stalled app, app manager restart): keep the session.
    const stopsBefore = receiver.stops;
    s.destroy(); await turn();
    assert(receiver.child, 'frontend loss does not end AirPlay immediately');
    assert.strictEqual(receiver.stops, stopsBefore);
    const s2 = new EventEmitter(); s2.destroyed=false; s2.writableLength=0;
    s2.setEncoding=()=>{}; s2.write=data=>writes.push(JSON.parse(data)); s2.destroy=()=>{s2.destroyed=true;s2.emit('close');};
    accept(s2); await turn();
    assert(!scheduled.some(t => t.ms === 30000), 'reconnecting frontend cancels the grace stop');
    assert(receiver.child);
    // Without a reconnect the grace period ends the receiver.
    s2.destroy(); await turn(); fire(30000); await turn(); await turn();
    assert(!receiver.child, 'grace period ends an abandoned session');
    const s3 = new EventEmitter(); s3.destroyed=false; s3.writableLength=0;
    s3.setEncoding=()=>{}; s3.write=data=>writes.push(JSON.parse(data)); s3.destroy=()=>{s3.destroyed=true;s3.emit('close');};
    accept(s3); s3.emit('data','{"command":"start"}\n'); await turn();
    assert(receiver.child); assert.strictEqual(receiver.lastOptions, undefined, 'manual start uses a fresh password');
    s3.emit('data','{"command":"stop"}\n'); await turn();
    assert(!receiver.child); assert(!route.owned);
    receiver.crash(); await turn(); assert(!scheduled.some(t => t.ms === 1000), 'no restart after explicit stop');
    // App update: the package manager moved our socket away with the old home.
    timers[1](); await turn(); assert.strictEqual(exitCode, null, 'unchanged socket keeps the backend running');
    socketInode = 2; timers[1](); await turn(); await turn();
    assert.strictEqual(exitCode, 75, 'a replaced app restarts the backend through systemd');
    console.log('Busy audio startup, media reacquisition, focus loss, crash recovery, frontend grace and explicit stop passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
