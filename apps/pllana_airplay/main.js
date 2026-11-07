'use strict';
const path = require('path');
const mgu = require('./kit/mgu');
const { BackendClient } = require('./backend_client');
const { VideoBridge } = require('./video_bridge');
const { drawHome } = require('./view');
const { LogoBridge } = require('./logo_bridge');
require('./brand_logo').register(require('./kit/record').setImage);

mgu.run({ async start(ctx) {
    const { ui, log } = ctx;
    const receiver = new BackendClient(path.join(ctx.dataDir, 'airplay/control.sock'));
    receiver.connect();
    const video = new VideoBridge(ctx.display);
    const logo = new LogoBridge(ctx.display);
    let state = receiver.state, notice = '', closing = false, controlsUntil = 0;
    ctx.display.onPresentationInput = () => {
        controlsUntil = Date.now() + 8000;
        ctx.display.setPresentation(false);
    };
    receiver.on('state', next => {
        state = next;
        if (!state.frame) video.detach();
        if (state.error) log.warn('AirPlay: ' + state.error);
    });
    ui.onClick('BTN_START', () => {
        if (!video.ready()) { notice = 'Videoausgabe noch nicht verfügbar'; return; }
        notice = receiver.start() ? '' : 'Empfangsdienst startet noch. Bitte erneut versuchen.';
    });
    ui.onClick('BTN_STOP', () => { notice = ''; receiver.stop(); });
    ui.onClick('BTN_CLOSE', async () => { closing = true; await receiver.stop(); await ui.close('MAIN'); });
    // The BMW renderer owns display focus. CarPlay, a call, or Home may hide
    // this view without ending the phone's AirPlay session.
    ui.onVisible((name, on) => {
        if (name !== 'MAIN') return;
        if (on) closing = false;
        log.info('AirPlay view: ' + (on ? 'visible' : 'hidden'));
    });
    if (ui.onFocus) ui.onFocus((name, on) => {
        if (name === 'MAIN') log.info('AirPlay focus: ' + (on ? 'foreground' : 'background'));
    });
    process.on('SIGTERM', () => { receiver.destroy().then(() => process.exit(0)); });
    process.on('SIGINT', () => { receiver.destroy().then(() => process.exit(0)); });
    process.on('exit', () => receiver.command('stop'));
    ctx.loop('MAIN', 4, async () => {
        const transitioning = state.phase === 'loading' ||
            (state.mode === 'waiting' && state.returnMode === 'mirror' && !!state.pin && !state.error);
        const fullscreen = (!!state.frame || transitioning) && Date.now() >= controlsUntil && video.ready();
        ctx.display.setPresentation(fullscreen);
        const size = fullscreen ? ctx.display.gpu.screen : { w: 1600, h: 520 };
        const c = ctx.canvas(size.w, size.h);
        if (state.frame && video.attach(state.file, state.frame.generation)) {
            c.clear('#000000');
            // The native renderer fits the latest frame, including orientation
            // changes between backend polls. Never lock it into the old aspect.
            video.draw(c, 0, 0, size.w, size.h);
        } else if (transitioning) {
            c.clear('#000000');
            logo.draw(c, size.w / 2 - 32, size.h / 2 - 70, 64, 64);
            c.text(state.phase === 'loading' ? 'Video wird geladen …' : 'Bildschirmspiegelung wird fortgesetzt …',
                size.w / 2, size.h / 2 + 32, 28, '#c0cedd', { font: 'airplay', align: 'center' });
        } else {
            drawHome(c, state, notice, logo);
        }
        if (!closing) await ui.image('MAIN_GFX', c);
    });
} });
