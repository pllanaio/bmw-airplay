'use strict';
const path = require('path');
const mgu = require('./kit/mgu');
const { BackendClient } = require('./backend_client');
const { VideoBridge } = require('./video_bridge');
const { drawHome } = require('./view');
const { LogoBridge } = require('./logo_bridge');
const { MusicArtworkBridge } = require('./music_artwork_bridge');
const { diagnose } = require('./diagnose');
require('./brand_logo').register(require('./kit/record').setImage);

mgu.run({ async start(ctx) {
    const { ui, log } = ctx;
    const receiver = new BackendClient(path.join(ctx.dataDir, 'airplay/control.sock'));
    receiver.connect();
    const video = new VideoBridge(ctx.display);
    const logo = new LogoBridge(ctx.display);
    const artwork = new MusicArtworkBridge(ctx.display, path.join(ctx.dataDir, 'airplay'));
    let state = receiver.state, notice = '', closing = false, controlsUntil = 0, diagnosis = '', diagnosedAt = 0;
    let mirrorResumeUntil = 0, disconnecting = null;
    const isAudio = next => next.mode === 'audio' || next.profile === 'audio';
    const uid = process.getuid ? process.getuid() : 0;
    const unreachable = () => !receiver.socket || receiver.socket.connecting || receiver.socket.destroyed;
    ctx.display.onPresentationInput = () => {
        controlsUntil = Date.now() + 8000;
        ctx.display.setPresentation(false);
    };
    receiver.on('state', next => {
        if (next.mode === 'waiting' && next.returnMode === 'mirror' &&
            (state.mode !== 'waiting' || state.returnMode !== 'mirror')) mirrorResumeUntil = Date.now() + 5000;
        if (isAudio(next) || next.returnMode !== 'mirror' || next.frame) mirrorResumeUntil = 0;
        state = next;
        artwork.update(isAudio(state) && state.music && state.music.artwork, state.music && state.music.epoch);
        if (!state.frame || isAudio(state)) video.detach();
        if (state.error) log.warn('AirPlay: ' + state.error);
    });
    ui.onClick('BTN_START', () => {
        if (disconnecting) return;
        notice = receiver.start('auto') ? '' : (diagnose(uid) || 'Empfangsdienst startet noch. Bitte erneut versuchen.');
    });
    ui.onClick('BTN_END_VIDEO', () => {
        if (state.mode === 'hls' || state.phase === 'loading' || state.playlistPending)
            notice = receiver.endVideo() ? '' : 'Videosteuerung noch nicht verfügbar.';
        else notice = 'Kein Video aktiv.';
    });
    const endSession = async close => {
        controlsUntil = Date.now() + 8000;
        notice = 'AirPlay-Verbindung wird getrennt …';
        if (!disconnecting) disconnecting = receiver.stop();
        try {
            await disconnecting;
            notice = '';
            if (close) { closing = true; await ui.close('MAIN'); }
        } catch (e) {
            closing = false;
            controlsUntil = Date.now() + 8000;
            notice = 'Trennen wurde nicht bestätigt. Bitte erneut versuchen.';
        } finally { disconnecting = null; }
    };
    ui.onClick('BTN_STOP', () => endSession(false));
    ui.onClick('BTN_MIRROR', () => {
        if (isAudio(state)) { notice = 'Bildschirmsynchronisierung am iPhone starten.'; return; }
        if (state.detached || state.mode === 'hls' || state.playlistPending) { notice = ''; receiver.resumeMirror(); controlsUntil = 0; }
        else notice = 'Kein Video aktiv – die Spiegelung läuft bereits.';
    });
    ui.onClick('BTN_CLOSE', () => endSession(true));
    const musicControl = action => {
        const music = state.music || {}, controls = music.controls || {};
        if (disconnecting || !isAudio(state) || !controls[action]) return;
        let value;
        if (action === 'shuffle') {
            if (music.shuffle !== 0 && music.shuffle !== 1) return;
            value = music.shuffle ? 0 : 1;
        } else if (action === 'repeat') {
            if ([0, 1, 2].indexOf(music.repeat) < 0) return;
            // Off -> repeat all -> repeat one -> off.
            value = music.repeat === 0 ? 2 : music.repeat === 2 ? 1 : 0;
        }
        notice = receiver.musicControl(action, value) ? '' : 'Musiksteuerung noch nicht verfügbar.';
    };
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
    // Losing the UI is different from pressing Trennen/Schließen. The backend
    // keeps audio reception alive and gives video UIs their reconnect grace.
    process.on('SIGTERM', () => { receiver.disconnect().then(() => process.exit(0)); });
    process.on('SIGINT', () => { receiver.disconnect().then(() => process.exit(0)); });
    process.on('exit', () => { artwork.drop(); receiver.disconnect(); });
    // 10 Hz: the switch between mirroring, a YouTube video and back is
    // picked up within ~100 ms. The video itself is drawn by the native
    // renderer, so this only re-records a small canvas.
    ctx.loop('MAIN', 10, async () => {
        const transitioning = !isAudio(state) && (state.phase === 'loading' ||
            (state.mode === 'waiting' && state.returnMode === 'mirror' && !!state.pin && !state.error &&
                !state.playlistPending && Date.now() < mirrorResumeUntil));
        const fullscreen = !isAudio(state) && (!!state.frame || transitioning) && Date.now() >= controlsUntil && video.ready();
        ctx.display.setPresentation(fullscreen);
        const size = fullscreen ? ctx.display.gpu.screen : { w: 1600, h: 520 };
        const c = ctx.canvas(size.w, size.h);
        if (!isAudio(state) && state.frame && video.attach(state.file, state.frame.generation)) {
            c.clear('#000000');
            // Native HLS frames already fit the full 1920x504 output through
            // scaling. Keep the complete frame visible in every UI layout.
            video.draw(c, 0, 0, size.w, size.h, state.frame, state.mode === 'hls' ? 'stretch' : 'contain');
        } else if (transitioning) {
            c.clear('#000000');
            logo.draw(c, size.w / 2 - 32, size.h / 2 - 70, 64, 64);
            c.text(state.phase === 'loading' ? 'Video wird geladen …' : 'Bildschirmspiegelung wird fortgesetzt …',
                size.w / 2, size.h / 2 + 32, 28, '#c0cedd', { font: 'airplay', align: 'center' });
        } else {
            // While the receiver service is unreachable, say why (every 2 s).
            if (!unreachable()) diagnosis = '';
            else if (Date.now() - diagnosedAt > 2000) { diagnosedAt = Date.now(); diagnosis = diagnose(uid); }
            drawHome(c, state, notice || diagnosis, logo, artwork, musicControl);
        }
        if (!closing) await ui.image('MAIN_GFX', c);
    });
} });
