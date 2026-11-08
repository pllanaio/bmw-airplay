'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),EventEmitter=require('events');
const clicks={},visible=[],focus=[];
let receiver,started,renderLoop,presented,musicControl,lastNotice,homeFrames=0,videoReady=true,clock=10000,closedViews=0,stopResult=null,videoDraws=0;
const signals={},profiles=[],musicCommands=[],startViewports=[],viewports=[];
class BackendClient extends EventEmitter {
    constructor(){super();receiver=this;this.state={};this.stops=0;this.starts=0;}
    connect(){} start(profile,viewport){profiles.push(profile);startViewports.push([viewport.width,viewport.height]);this.starts++;return true;} stop(){this.stops++;return stopResult||Promise.resolve();} command(){}
    setVideoViewport(width,height){viewports.push([width,height]);return true;}
    resumeMirror(){this.resumes=(this.resumes||0)+1;return true;}
    endVideo(){this.videoEnds=(this.videoEnds||0)+1;return true;}
    disconnect(){this.disconnects=(this.disconnects||0)+1;return Promise.resolve();}
    musicControl(action,value){musicCommands.push([action,value]);return true;}
}
const ctx={ui:{onClick:(id,fn)=>{clicks[id]=fn;},onVisible:fn=>visible.push(fn),onFocus:fn=>focus.push(fn),
    close:()=>{closedViews++;return Promise.resolve();},image:()=>Promise.resolve()},log:{info(){},warn(){}},display:{gpu:{screen:{w:1920,h:504}},setPresentation:on=>{presented=on;}},
    loop:(name,hz,fn)=>{renderLoop=fn;},canvas:()=>({clear(){},text(){}}),dataDir:'/app/data'};
ctx.display.contentSize=()=>({w:1600,h:Math.floor((ctx.display.gpu.screen.h-48)/(ctx.display.gpu.screen.w/1600))});
const modules={path,'./kit/mgu':{run:app=>{started=app.start(ctx);}},'./backend_client':{BackendClient},
    './video_bridge':{VideoBridge:class{ready(){return videoReady;} detach(){} attach(){return true;}draw(){videoDraws++;}}},
    './view':{drawHome(c,s,n,l,a,control){homeFrames++;musicControl=control;lastNotice=n;}},'./logo_bridge':{LogoBridge:class{draw(){}}},
    './music_artwork_bridge':{MusicArtworkBridge:class{update(){}drop(){}}},
    './brand_logo':{register(){}},'./kit/record':{setImage(){}},'./diagnose':{diagnose:()=>''}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../apps/pllana_airplay/main.js'),'utf8'),{
    require:name=>{assert(modules[name],name);return modules[name];},
    process:{on:(name,fn)=>{signals[name]=fn;},getuid:()=>12233,exit(){}},Date:{now:()=>clock},Promise,console
});
Promise.resolve(started).then(async()=>{
    clicks.BTN_START();assert.strictEqual(receiver.starts,1);
    assert.deepStrictEqual(profiles,['auto']);
    assert.deepStrictEqual(startViewports,[[1920,504]],'start sends the renderer screen instead of a fixed output height');
    videoReady=false;clicks.BTN_START();assert.strictEqual(receiver.starts,2,'automatic audio reception can start with no video renderer');
    assert.deepStrictEqual(profiles,['auto','auto']);assert.strictEqual(clicks.BTN_AUDIO,undefined,'no manual mode selection is required');
    receiver.socket={};
    receiver.emit('state',{profile:'auto',phase:'audio',mode:'audio',frame:{sequence:9}});
    await renderLoop();assert.strictEqual(presented,false,'music keeps the normal surface instead of stale fullscreen video');
    assert.strictEqual(videoDraws,0,'automatic audio ignores stale video frames');
    musicControl('next');assert.strictEqual(musicCommands.length,0,'unsupported sender controls are inert');
    receiver.emit('state',{profile:'auto',mode:'audio',phase:'audio',music:{controls:{playPause:true,next:true,previous:true,shuffle:true,repeat:true},shuffle:0,repeat:0}});
    musicControl('playPause');musicControl('next');musicControl('previous');musicControl('shuffle');musicControl('repeat');
    assert.deepStrictEqual(musicCommands,[['playPause',undefined],['next',undefined],['previous',undefined],['shuffle',1],['repeat',2]]);
    receiver.emit('state',{profile:'auto',mode:'audio',phase:'audio',music:{controls:{shuffle:true,repeat:true},shuffle:1,repeat:2}});
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
    receiver.emit('state',{profile:'auto',phase:'mirroring',mode:'hls',frame:{generation:'new-video',width:1920,height:504}});
    await renderLoop();assert.strictEqual(presented,true);assert.strictEqual(videoDraws,1,'automatic video switches to fullscreen');
    assert.deepStrictEqual(viewports[viewports.length-1],[1920,504]);
    ctx.display.gpu.screen.h=720;
    await renderLoop();assert.strictEqual(videoDraws,1,'504-high output cannot be shown letterboxed in a 720-high viewport');
    assert.deepStrictEqual(viewports[viewports.length-1],[1920,720]);
    receiver.emit('state',{profile:'auto',phase:'mirroring',mode:'hls',frame:{generation:'new-video',width:1920,height:720}});
    await renderLoop();assert.strictEqual(videoDraws,2,'the fully rescaled frame fills the actual screen');
    ctx.display.onPresentationInput();await renderLoop();assert.strictEqual(presented,false);
    assert.deepStrictEqual(viewports[viewports.length-1],[1600,560],'borderless controls layout uses the complete body above the bottom menu');
    assert.strictEqual(videoDraws,2,'old fullscreen aspect is not shown with new margins');
    receiver.emit('state',{profile:'auto',phase:'mirroring',mode:'hls',frame:{generation:'new-video',width:1600,height:560}});
    await renderLoop();assert.strictEqual(videoDraws,3);
    receiver.emit('state',{profile:'auto',phase:'audio',mode:'audio',frame:{generation:'old-video'}});
    await renderLoop();assert.strictEqual(presented,false);assert.strictEqual(videoDraws,3,'audio returns to music without drawing the old video');
    await clicks.BTN_STOP();assert.strictEqual(receiver.stops,1);
    let confirmStop;
    stopResult=new Promise(resolve=>{confirmStop=resolve;});
    const closePending=clicks.BTN_CLOSE();assert.strictEqual(receiver.stops,2);assert.strictEqual(closedViews,0,'close waits for actual disconnection acknowledgement');
    confirmStop();await closePending;assert.strictEqual(closedViews,1);
    stopResult=Promise.reject(Error('receiver_stop_failed'));
    await clicks.BTN_CLOSE();assert.strictEqual(closedViews,1,'failed disconnect must keep the UI open');
    await renderLoop();assert(/nicht bestätigt/.test(lastNotice),'failed disconnect is visible and retryable');
    stopResult=null;
    await clicks.BTN_STOP();assert.strictEqual(receiver.stops,4,'failed stop can be retried');
    await signals.SIGTERM();signals.exit();
    assert.strictEqual(receiver.disconnects,2,'loss of the frontend closes only the UI socket');
    assert.strictEqual(receiver.stops,4,'background UI termination must not stop music');
    console.log('Automatic audio/video UI switching, acknowledged stop/close and visible retry on disconnect failure passed');
}).catch(e=>{console.error(e);process.exitCode=1;});
