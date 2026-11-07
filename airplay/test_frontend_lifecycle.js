'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),EventEmitter=require('events');
const clicks={},visible=[],focus=[];
let receiver,started,renderLoop,presented,musicControl,homeFrames=0,videoReady=true,clock=10000;
const signals={},profiles=[],musicCommands=[];
class BackendClient extends EventEmitter {
    constructor(){super();receiver=this;this.state={};this.stops=0;this.starts=0;}
    connect(){} start(profile){profiles.push(profile);this.starts++;return true;} stop(){this.stops++;return Promise.resolve();} command(){}
    resumeMirror(){this.resumes=(this.resumes||0)+1;return true;}
    endVideo(){this.videoEnds=(this.videoEnds||0)+1;return true;}
    disconnect(){this.disconnects=(this.disconnects||0)+1;return Promise.resolve();}
    musicControl(action,value){musicCommands.push([action,value]);return true;}
}
const ctx={ui:{onClick:(id,fn)=>{clicks[id]=fn;},onVisible:fn=>visible.push(fn),onFocus:fn=>focus.push(fn),
    close:()=>Promise.resolve(),image:()=>Promise.resolve()},log:{info(){},warn(){}},display:{setPresentation:on=>{presented=on;}},
    loop:(name,hz,fn)=>{renderLoop=fn;},canvas:()=>({}),dataDir:'/app/data'};
const modules={path,'./kit/mgu':{run:app=>{started=app.start(ctx);}},'./backend_client':{BackendClient},
    './video_bridge':{VideoBridge:class{ready(){return videoReady;} detach(){} attach(){throw Error('audio must not attach stale video');}}},
    './view':{drawHome(c,s,n,l,a,control){homeFrames++;musicControl=control;}},'./logo_bridge':{LogoBridge:class{}},
    './music_artwork_bridge':{MusicArtworkBridge:class{update(){}drop(){}}},
    './brand_logo':{register(){}},'./kit/record':{setImage(){}},'./diagnose':{diagnose:()=>''}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../apps/pllana_airplay/main.js'),'utf8'),{
    require:name=>{assert(modules[name],name);return modules[name];},
    process:{on:(name,fn)=>{signals[name]=fn;},getuid:()=>12233,exit(){}},Date:{now:()=>clock},Promise,console
});
Promise.resolve(started).then(async()=>{
    clicks.BTN_START();assert.strictEqual(receiver.starts,1);
    assert.deepStrictEqual(profiles,['video']);
    videoReady=false;clicks.BTN_START();assert.strictEqual(receiver.starts,1,'video still requires its renderer');
    clicks.BTN_AUDIO();assert.deepStrictEqual(profiles,['video','audio'],'music can start with no video renderer');
    receiver.socket={};
    receiver.emit('state',{profile:'audio',phase:'audio',mode:'audio',frame:{sequence:9}});
    await renderLoop();assert.strictEqual(presented,false,'music keeps the normal surface instead of stale fullscreen video');
    musicControl('next');assert.strictEqual(musicCommands.length,0,'unsupported sender controls are inert');
    receiver.emit('state',{profile:'audio',phase:'audio',music:{controls:{playPause:true,next:true,previous:true,shuffle:true,repeat:true},shuffle:0,repeat:0}});
    musicControl('playPause');musicControl('next');musicControl('previous');musicControl('shuffle');musicControl('repeat');
    assert.deepStrictEqual(musicCommands,[['playPause',undefined],['next',undefined],['previous',undefined],['shuffle',1],['repeat',2]]);
    receiver.emit('state',{profile:'audio',phase:'audio',music:{controls:{shuffle:true,repeat:true},shuffle:1,repeat:2}});
    musicControl('shuffle');musicControl('repeat');assert.deepStrictEqual(musicCommands.slice(-2),[['shuffle',0],['repeat',1]]);
    clicks.BTN_END_VIDEO();assert(!receiver.videoEnds,'video controls do not end a music session');
    videoReady=true;
    visible.forEach(fn=>fn('MAIN',false));focus.forEach(fn=>fn('MAIN',false));
    visible.forEach(fn=>fn('MAIN',true));focus.forEach(fn=>fn('MAIN',true));
    assert.strictEqual(receiver.stops,0,'CarPlay/Home/focus changes must preserve the session');
    receiver.emit('state',{profile:'video',mode:'hls',returnMode:'waiting'});
    clicks.BTN_END_VIDEO();assert.strictEqual(receiver.videoEnds,1,'end video preserves reception rather than disconnecting');
    assert.strictEqual(receiver.stops,0);
    receiver.socket={};
    receiver.emit('state',{phase:'waiting',mode:'waiting',returnMode:'mirror',pin:'123456',playlistPending:true});
    await renderLoop();
    assert.strictEqual(presented,false,'the end of the queue must not leave an endless fullscreen mirror transition');
    assert.strictEqual(homeFrames,2,'waiting for a possible next title keeps the normal controls visible');
    clicks.BTN_MIRROR();assert.strictEqual(receiver.resumes,1,'return to mirroring is available between playlist titles');
    receiver.emit('state',{profile:'video',phase:'mirroring',mode:'hls',returnMode:'mirror',pin:'123456'});
    receiver.emit('state',{profile:'video',phase:'waiting',mode:'waiting',returnMode:'mirror',pin:'123456'});
    clock+=6000;await renderLoop();
    assert.strictEqual(presented,false,'a phone that no longer supplies mirror frames cannot leave an endless transition');
    assert.strictEqual(homeFrames,3);
    clicks.BTN_STOP();assert.strictEqual(receiver.stops,1);
    await clicks.BTN_CLOSE();assert.strictEqual(receiver.stops,2);
    await signals.SIGTERM();signals.exit();
    assert.strictEqual(receiver.disconnects,2,'loss of the frontend closes only the UI socket');
    assert.strictEqual(receiver.stops,2,'background UI termination must not stop music');
    console.log('Hidden view and focus transitions preserve AirPlay; explicit stop/close end it');
}).catch(e=>{console.error(e);process.exitCode=1;});
