'use strict';
const assert = require('assert'), vm = require('vm'), fs = require('fs'), EventEmitter = require('events');
const sockets = [], writes = [], timers = [];
let receiver, route, accept;
class Receiver extends EventEmitter {
    constructor() { super(); receiver = this; this.state = {}; this.child = null; this.starts = 0; this.stops = 0; }
    start() { this.child = {}; this.starts++; this.update({phase:'waiting'}); return true; }
    stop() { this.child = null; this.stops++; return Promise.resolve(); }
    update(fields) { Object.assign(this.state, fields); this.emit('state', this.state); }
}
class AudioRoute {
    constructor() { route = this; this.owned = false; this.available = false; }
    acquire() { if (!this.available) return Promise.reject(Error('audio_route_in_use')); this.owned = true; return Promise.resolve(); }
    release() { this.owned = false; return Promise.resolve(); }
    check() { return Promise.resolve(this.available); }
}
const server = new EventEmitter();
server.listen = (p, cb) => cb(); server.close = () => {};
const fakeFs = {existsSync:()=>true,lstatSync:()=>({isSocket:()=>true,uid:12233}),unlinkSync:()=>{},writeFileSync:()=>{},chmodSync:()=>{}};
const modules = {
    './resolver':{refresh:()=>{}},fs:fakeFs,path:require('path'),'./receiver':{Receiver},
    './audio_route':{AudioRoute,AUDIO_SINK:'fakesink'},'./kit/signals':{},
    net:{createServer:cb=>{accept=cb; return server;}}
};
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'../apps/pllana_airplay/backend.js'),'utf8'), {
    require:name=>{assert(modules[name],name); return modules[name];},
    __dirname:'/app/source/javascript',Buffer,Promise,Date,JSON,Error,
    process:{getuid:()=>12233,env:{},on:()=>{},exit:()=>{}},
    setInterval:fn=>{timers.push(fn); return {unref:()=>{}};},clearInterval:()=>{},setTimeout,clearTimeout
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
    s.emit('data','{"command":"stop"}\n'); await turn();
    assert(!receiver.child); assert(!route.owned);
    console.log('Busy audio startup, media reacquisition, focus loss and explicit stop passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
