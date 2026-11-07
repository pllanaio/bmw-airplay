'use strict';
const assert = require('assert'), vm = require('vm'), fs = require('fs'), EventEmitter = require('events');
const sockets = [], writes = [], timers = [], startupOrder = [];
let receiver, route, accept, remote, uplinkOnline = false;
class Receiver extends EventEmitter {
    constructor(options) { super(); receiver = this; this.runtime = options.runtime; this.musicDirectory = ''; this.options = options; this.state = {}; this.child = null; this.starts = 0; this.stops = 0; }
    start(options) { startupOrder.push('start'); this.child = {}; this.features = {}; this.starts++; this.lastOptions = options; const profile=options && options.profile || 'video'; this.musicDirectory=profile==='audio'?'/private/music-'+this.starts:''; this.update({phase:'waiting', profile, music:profile==='audio'?{title:'',epoch:null,controls:{}}:null,error:null}); this.emit('music-directory',this.musicDirectory); return true; }
    crash() { this.child = null; this.musicDirectory=''; this.emit('music-directory',''); this.update({phase:'error', error:'receiver_failed'}); this.emit('ended'); }
    stop() { this.stops++; if (this.onStop) { const callback = this.onStop; this.onStop = null; callback(); } this.child = null; this.musicDirectory=''; this.emit('music-directory',''); this.update({ phase:'stopped' }); this.emit('ended'); return Promise.resolve(); }
    update(fields) { Object.assign(this.state, fields); this.emit('state', this.state); }
}
class AudioRoute {
    constructor() { route = this; this.owned = false; this.available = false; }
    acquire() { if (!this.available) return Promise.reject(Error('audio_route_in_use')); this.owned = true; return Promise.resolve(); }
    release() { this.owned = false; return Promise.resolve(); }
    check() { return Promise.resolve(this.available); }
}
class MusicControls {
    constructor(options) { remote=this; this.options=options; this.actions=[]; this.nextResult=null; }
    poll() { return Promise.resolve(); }
    clear() {}
    close() { this.closed=true; }
    state(fields) { this.options.onState(fields); }
    execute(action,value,epoch) { this.actions.push({action,value,epoch}); const result=this.nextResult; this.nextResult=null; return result || Promise.resolve(); }
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
    './resolver':{refresh:()=>startupOrder.push('dns'),hasUplink:()=>uplinkOnline},fs:fakeFs,path:require('path'),'./receiver':{Receiver},
    './audio_route':{AudioRoute,AUDIO_SINK:'fakesink'},'./kit/signals':{},
    './music_controls':{MusicControls},
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
    assert.strictEqual(receiver.options.hls(), false, 'offline backend selects mirroring');
    assert.deepStrictEqual(startupOrder.slice(-2), ['dns', 'start'], 'refresh DNS before the new receiver uses a newly appeared uplink');
    uplinkOnline = true;
    assert.strictEqual(receiver.options.hls(), true, 'new sessions read the current uplink lease');
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
    assert.strictEqual(receiver.detaches, 0, 'a direct AirPlay video needs no detaching');
    receiver.update({ returnMode: 'mirror', mode: 'hls' }); receiver.emit('media', 'hls');
    assert.strictEqual(receiver.detaches, 1, 'video from mirroring is detached before an immediate app switch');
    receiver.update({ detached: true }); receiver.emit('media', 'hls');
    assert.strictEqual(receiver.detaches, 1, 'acknowledged native detachment needs no fallback signal');
    receiver.features = { nativeDetach: true };
    receiver.update({ detached: false, returnMode: 'mirror' }); receiver.emit('media', 'hls');
    assert.strictEqual(receiver.detaches, 1, 'native detection is authoritative even if the UI still remembers a prior mirror');
    receiver.update({ returnMode: 'waiting' }); receiver.emit('media', 'hls');
    assert.strictEqual(receiver.detaches, 1, 'a later direct video retains phone controls');
    receiver.features = { videoModes: true, mediaStop: true };
    receiver.update({ returnMode: 'mirror' }); receiver.emit('media', 'hls');
    assert.strictEqual(receiver.detaches, 1, 'origin-aware media controls never get the legacy detach override');
    receiver.videoEnds = 0; receiver.endVideo = () => { receiver.videoEnds++; return true; };
    const beforeVideoEnd = receiver.stops;
    s.emit('data', '{"command":"end-video"}\n'); await turn();
    assert.strictEqual(receiver.videoEnds, 1);
    assert.strictEqual(receiver.stops, beforeVideoEnd, 'ending a video does not disconnect the receiver');
    assert(route.owned, 'ending video keeps the session audio route');
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
    assert(receiver.child); assert.strictEqual(receiver.lastOptions.keepPassword, false, 'manual start uses a fresh password');
    assert.strictEqual(receiver.lastOptions.profile, 'video');
    // Switching capabilities is deliberate; retrying the selected profile is
    // only an audio-focus retry, never a receiver/password replacement.
    const beforeSwitch = receiver.stops;
    receiver.onStop = () => s3.destroy();
    s3.emit('data', '{"command":"start","profile":"audio"}\n'); await turn(); await turn();
    assert.strictEqual(receiver.stops, beforeSwitch + 1);
    assert(s3.destroyed && receiver.child, 'selected audio still starts if the UI exits while the previous profile stops');
    assert(!scheduled.some(t => t.ms === 30000), 'profile switch clears the old video grace timer');
    assert.strictEqual(receiver.lastOptions.profile, 'audio');
    assert.strictEqual(receiver.lastOptions.keepPassword, true, 'profile switch retains the pairing password');
    const audioStarts = receiver.starts;
    const audioUI = new EventEmitter(); audioUI.destroyed=false; audioUI.writableLength=0;
    audioUI.setEncoding=()=>{}; audioUI.write=data=>writes.push(JSON.parse(data)); audioUI.destroy=()=>{audioUI.destroyed=true;audioUI.emit('close');};
    accept(audioUI); audioUI.emit('data', '{"command":"start","profile":"audio"}\n'); await turn();
    assert.strictEqual(receiver.starts, audioStarts, 'same-profile retry does not restart');
    receiver.update({ music: { title:'Sender song', artist:'Sender artist', epoch:null,controls:{} } });
    remote.state({ epoch:'epoch-1',controls:{playPause:true,next:true,previous:true,shuffle:false,repeat:false},playbackState:'playing',shuffle:null,repeat:null });
    assert.strictEqual(receiver.state.music.title, 'Sender song', 'confirmed control state preserves sender metadata');
    audioUI.emit('data', '{"command":"music-control","action":"next","epoch":"epoch-1"}\n'); await turn();
    assert.deepStrictEqual(remote.actions[0], {action:'next',value:undefined,epoch:'epoch-1'});
    audioUI.emit('data', '{"command":"music-control","action":"next","epoch":"old-epoch"}\n'); await turn();
    assert.strictEqual(remote.actions.length, 1, 'stale UI commands cannot reach another sender');
    audioUI.emit('data', '{"command":"music-control","action":"shuffle","value":1,"epoch":"epoch-1"}\n'); await turn();
    assert.strictEqual(remote.actions.length, 1, 'unadvertised shuffle is never simulated locally or sent');
    let releaseCommand;
    remote.nextResult = new Promise(resolve => { releaseCommand=resolve; });
    audioUI.emit('data', '{"command":"music-control","action":"next","epoch":"epoch-1"}\n'); await turn();
    audioUI.emit('data', '{"command":"music-control","action":"previous","epoch":"epoch-1"}\n'); await turn();
    remote.state({ epoch:'epoch-2',controls:{playPause:true,next:true,previous:true,shuffle:false,repeat:false} });
    releaseCommand(); await turn(); await turn();
    assert.strictEqual(remote.actions.length, 2, 'queued controls are revalidated after a sender epoch change');
    audioUI.destroy(); await turn();
    assert(receiver.child, 'audio-only playback survives leaving the frontend');
    assert(!scheduled.some(t => t.ms === 30000), 'audio-only has no abandoned-video grace stop');
    route.available = false; timers[1](); await turn();
    assert(!route.owned);
    route.available = true; receiver.emit('media', 'audio'); await turn();
    assert(route.owned, 'audio packets can reacquire the route with no UI client');
    receiver.crash(); await turn(); fire(1000); await turn(); await turn();
    assert(receiver.child && route.owned, 'audio-only crash recovery works with no frontend');
    assert.strictEqual(receiver.lastOptions.profile, 'audio');
    assert.strictEqual(receiver.lastOptions.keepPassword, true);
    const invalid = new EventEmitter(); invalid.destroyed=false; invalid.writableLength=0;
    invalid.setEncoding=()=>{}; invalid.write=()=>{}; invalid.destroy=()=>{invalid.destroyed=true;invalid.emit('close');};
    accept(invalid); invalid.emit('data', '{"command":"start","profile":"invalid"}\n'); await turn();
    assert(invalid.destroyed, 'invalid profile is rejected without changing the active receiver');
    assert.strictEqual(receiver.starts, audioStarts + 1);
    const invalidMusic = new EventEmitter(); invalidMusic.destroyed=false; invalidMusic.writableLength=0;
    invalidMusic.setEncoding=()=>{}; invalidMusic.write=()=>{}; invalidMusic.destroy=()=>{invalidMusic.destroyed=true;invalidMusic.emit('close');};
    accept(invalidMusic); invalidMusic.emit('data', '{"command":"music-control","action":"shuffle","value":2,"epoch":"forged"}\n'); await turn();
    assert(invalidMusic.destroyed, 'the server independently rejects unallowlisted setting values');
    assert.strictEqual(remote.actions.length, 2);
    const s4 = new EventEmitter(); s4.destroyed=false; s4.writableLength=0;
    s4.setEncoding=()=>{}; s4.write=data=>writes.push(JSON.parse(data)); s4.destroy=()=>{s4.destroyed=true;s4.emit('close');};
    accept(s4);
    remote.state({ epoch:'hanging-phone',controls:{next:true} });
    remote.nextResult=new Promise(()=>{});
    s4.emit('data','{"command":"music-control","action":"next","epoch":"hanging-phone"}\n'); await turn();
    for (let index=0;index<8;index++) s4.emit('data','{"command":"music-control","action":"next","epoch":"hanging-phone"}\n');
    assert.strictEqual(receiver.state.music.controlError, 'music_control_busy', 'remote-control queue stays bounded while the phone is slow');
    s4.emit('data','{"command":"stop"}\n'); await turn();
    assert(!receiver.child && !route.owned, 'a hung phone control never delays explicit receiver/audio stop');
    fire(5500); await turn();
    assert.strictEqual(remote.actions.length, 3, 'queued controls are discarded after explicit stop');
    receiver.crash(); await turn(); assert(!scheduled.some(t => t.ms === 1000), 'explicit audio stop disables recovery');
    s4.emit('data','{"command":"start","profile":"audio"}\n'); await turn();
    assert.strictEqual(receiver.lastOptions.keepPassword, false, 'new manual audio session gets a new password');
    s4.emit('data','{"command":"start","profile":"video"}\n'); await turn(); await turn();
    assert.strictEqual(receiver.lastOptions.profile, 'video', 'audio-only can explicitly return to video');
    assert.strictEqual(receiver.lastOptions.keepPassword, true);
    s4.emit('data','{"command":"stop"}\n'); await turn();
    assert(!receiver.child); assert(!route.owned);
    receiver.crash(); await turn(); assert(!scheduled.some(t => t.ms === 1000), 'no restart after explicit stop');
    // App update: the package manager moved our socket away with the old home.
    timers[1](); await turn(); assert.strictEqual(exitCode, null, 'unchanged socket keeps the backend running');
    socketInode = 2; timers[1](); await turn(); await turn();
    assert.strictEqual(exitCode, 75, 'a replaced app restarts the backend through systemd');
    assert(remote.closed, 'backend shutdown closes remote control work');
    console.log('Busy audio startup, media reacquisition, focus loss, crash recovery, frontend grace and explicit stop passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
