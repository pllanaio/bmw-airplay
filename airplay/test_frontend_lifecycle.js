'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),vm=require('vm'),EventEmitter=require('events');
const clicks={},visible=[],focus=[];
let receiver,started,renderLoop,presented,homeFrames=0;
class BackendClient extends EventEmitter {
    constructor(){super();receiver=this;this.state={};this.stops=0;this.starts=0;}
    connect(){} start(){this.starts++;return true;} stop(){this.stops++;return Promise.resolve();} command(){}
    resumeMirror(){this.resumes=(this.resumes||0)+1;return true;}
}
const ctx={ui:{onClick:(id,fn)=>{clicks[id]=fn;},onVisible:fn=>visible.push(fn),onFocus:fn=>focus.push(fn),
    close:()=>Promise.resolve(),image:()=>Promise.resolve()},log:{info(){},warn(){}},display:{setPresentation:on=>{presented=on;}},
    loop:(name,hz,fn)=>{renderLoop=fn;},canvas:()=>({}),dataDir:'/app/data'};
const modules={path,'./kit/mgu':{run:app=>{started=app.start(ctx);}},'./backend_client':{BackendClient},
    './video_bridge':{VideoBridge:class{ready(){return true;} detach(){}}},
    './view':{drawHome(){homeFrames++;}},'./logo_bridge':{LogoBridge:class{}},
    './brand_logo':{register(){}},'./kit/record':{setImage(){}},'./diagnose':{diagnose:()=>''}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../apps/pllana_airplay/main.js'),'utf8'),{
    require:name=>{assert(modules[name],name);return modules[name];},
    process:{on(){},getuid:()=>12233},Date,Promise,console
});
Promise.resolve(started).then(async()=>{
    clicks.BTN_START();assert.strictEqual(receiver.starts,1);
    visible.forEach(fn=>fn('MAIN',false));focus.forEach(fn=>fn('MAIN',false));
    visible.forEach(fn=>fn('MAIN',true));focus.forEach(fn=>fn('MAIN',true));
    assert.strictEqual(receiver.stops,0,'CarPlay/Home/focus changes must preserve the session');
    receiver.socket={};
    receiver.emit('state',{phase:'waiting',mode:'waiting',returnMode:'mirror',pin:'123456',playlistPending:true});
    await renderLoop();
    assert.strictEqual(presented,false,'the end of the queue must not leave an endless fullscreen mirror transition');
    assert.strictEqual(homeFrames,1,'waiting for a possible next title keeps the normal controls visible');
    clicks.BTN_MIRROR();assert.strictEqual(receiver.resumes,1,'return to mirroring is available between playlist titles');
    clicks.BTN_STOP();assert.strictEqual(receiver.stops,1);
    await clicks.BTN_CLOSE();assert.strictEqual(receiver.stops,2);
    console.log('Hidden view and focus transitions preserve AirPlay; explicit stop/close end it');
}).catch(e=>{console.error(e);process.exitCode=1;});
