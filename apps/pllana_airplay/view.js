'use strict';
const COLORS = { bg: '#080c12', card: '#111a26', edge: '#243346', ink: '#f1f5fa', muted: '#9aaec5', blue: '#73bcff', mint: '#70e0c2' };
const { ID: LOGO } = require('./brand_logo');
function text(c, str, x, y, size, color, opts) {
    return c.text(str, x, y, size, color, Object.assign({ font: 'airplay' }, opts));
}
function airplay(c, x, y, s, color) {
    c.strokeRoundRect(x, y, s, s * 0.64, s * 0.08, 2.5, color);
    c.fillRect(x + s * 0.23, y + s * 0.49, s * 0.54, s * 0.20, COLORS.card);
    c.quad([[x + s * 0.5, y + s * 0.45], [x + s * 0.73, y + s * 0.80],
        [x + s * 0.27, y + s * 0.80], [x + s * 0.5, y + s * 0.45]], color);
}
function modeCard(c, x, title, sub, kind) {
    c.roundRect(x, 325, 474, 116, 20, COLORS.card);
    c.strokeRoundRect(x, 325, 474, 116, 20, 1, COLORS.edge);
    if (kind === 'phone') {
        c.strokeRoundRect(x + 25, 352, 27, 48, 6, 2, COLORS.blue);
        c.line(x + 34, 393, x + 43, 393, 2, COLORS.blue);
    } else if (kind === 'audio') {
        c.line(x + 34, 356, x + 58, 350, 3, COLORS.mint);
        c.line(x + 34, 356, x + 34, 390, 3, COLORS.mint);
        c.line(x + 58, 350, x + 58, 384, 3, COLORS.mint);
        c.circle(x + 28, 392, 7, COLORS.mint);
        c.circle(x + 52, 386, 7, COLORS.mint);
    } else {
        c.roundRect(x + 21, 359, 43, 30, 8, '#d84c53');
        c.quad([[x + 39, 366], [x + 49, 374], [x + 39, 382], [x + 39, 366]], '#ffffff');
    }
    text(c, title, x + 83, 371, 27, COLORS.ink);
    text(c, sub, x + 83, 408, 22, COLORS.muted);
}
function shorten(value, count) {
    const chars = Array.from(value || '');
    return chars.length > count ? chars.slice(0, count - 1).join('') + '…' : chars.join('');
}
function fit(c, value, size, width, count) {
    let result = shorten(value, count);
    if (c.textWidth) while (result.length > 1 && c.textWidth(result, size, { font: 'airplay', literal: true }) > width) {
        count--; result = shorten(value, count);
    }
    return result;
}
function musicButton(c, x, width, label, action, enabled, active, onControl) {
    const color = !enabled ? '#617184' : active ? COLORS.mint : COLORS.ink;
    c.roundRect(x, 313, width, 77, 17, active && enabled ? '#173b36' : COLORS.card);
    c.strokeRoundRect(x, 313, width, 77, 17, 1, active && enabled ? '#397f70' : COLORS.edge);
    text(c, label, x + width / 2, 359, 25, color, { align: 'center' });
    if (enabled && onControl && c.target) c.target(x, 313, width, 77, () => onControl(action), 'music-' + action, 17);
}
function drawMusic(c, state, artwork, onControl) {
    const music = state.music || {}, controls = music.controls || {};
    c.roundRect(48, 111, 300, 300, 24, COLORS.card);
    if (!artwork || !artwork.draw(c, 48, 111, 300, 300)) {
        c.line(171, 199, 221, 186, 5, COLORS.blue);
        c.line(171, 199, 171, 292, 5, COLORS.blue);
        c.line(221, 186, 221, 279, 5, COLORS.blue);
        c.circle(155, 297, 16, COLORS.blue); c.circle(205, 284, 16, COLORS.blue);
    }
    text(c, fit(c, music.title || 'Deine Musik.', 45, 1158, 46), 394, 171, 45, COLORS.ink, { literal: true });
    text(c, fit(c, music.artist || (state.connected ? 'Musik am iPhone auswählen' : state.pin ? 'AirPlay-Audio am iPhone wählen' : 'Unten „Verbinden“ drücken.'), 29, 1155, 67), 397, 224, 29, COLORS.muted, { literal: true });
    text(c, fit(c, music.album || (state.connected ? 'AirPlay-Audio verbunden' : state.pin && !music.title ? 'PllanaCast for BMW · Code ' + state.pin : ''), 25, 1155, 76), 397, 266, 25, COLORS.muted, { literal: true });
    musicButton(c, 394, 152, 'Zurück', 'previous', controls.previous, false, onControl);
    musicButton(c, 560, 194, music.playbackState === 'playing' ? 'Pause' : music.playbackState === 'paused' || music.playbackState === 'stopped' ? 'Abspielen' : 'Play / Pause', 'playPause', controls.playPause, false, onControl);
    musicButton(c, 768, 152, 'Weiter', 'next', controls.next, false, onControl);
    musicButton(c, 934, 272, 'Shuffle' + (music.shuffle === 0 ? ': aus' : music.shuffle === 1 ? ': an' : ''), 'shuffle', controls.shuffle, music.shuffle === 1, onControl);
    musicButton(c, 1220, 332, 'Repeat' + (music.repeat === 0 ? ': aus' : music.repeat === 1 ? ': ein Titel' : music.repeat === 2 ? ': alle' : ''), 'repeat', controls.repeat, music.repeat > 0, onControl);
    const available = Object.keys(controls).filter(key => controls[key]).length;
    text(c, state.sender === 'android' ? 'Wiedergabe über dein Android-Handy. Ton über deinen BMW.' : available === 5 ? 'Wiedergabe über dein iPhone. Ton über deinen BMW.' : available ? 'Weitere Funktionen kannst du am iPhone steuern.' : 'Wiedergabe am iPhone starten. Steuerung wird vom Sender freigegeben.', 397, 437, 23, COLORS.muted);
}
function drawHome(c, state, notice, logo, artwork, onControl) {
    const original = c, sy = Math.min(1, (c.h || 520) / 520);
    if (sy < 1) {
        // A short display has a smaller borderless body above the controls.
        // Compress the home/music layout too, rather than clipping its rows.
        const sized = (name, transform) => (...args) => original[name].apply(original, transform(args));
        const box = args => { args[1] *= sy; args[3] *= sy; return args; };
        c = {
            clear: color => original.clear(color),
            gradientRect: sized('gradientRect', box), fillRect: sized('fillRect', box),
            card: sized('card', args => { box(args); args[4] *= sy; return args; }),
            roundRect: sized('roundRect', args => { box(args); args[4] *= sy; return args; }),
            strokeRoundRect: sized('strokeRoundRect', args => { box(args); args[4] *= sy; args[5] *= sy; return args; }),
            line: sized('line', args => { args[1] *= sy; args[3] *= sy; args[4] *= sy; return args; }),
            circle: sized('circle', args => { args[1] *= sy; args[2] *= sy; return args; }),
            quad: (points, color) => original.quad(points.map(point => [point[0], point[1] * sy]), color),
            image: sized('image', args => { args[2] *= sy; args[4] *= sy; return args; }),
            text: sized('text', args => { args[2] *= sy; args[3] *= sy; return args; }),
        };
        if (original.target) c.target = sized('target', args => { box(args); if (args[6] !== undefined) args[6] *= sy; return args; });
        if (original.textWidth) c.textWidth = sized('textWidth', args => { args[1] *= sy; return args; });
        const imageBridge = bridge => bridge && { draw: (canvas, x, y, w, h) => bridge.draw(original, x, y * sy, w, h * sy) };
        logo = imageBridge(logo); artwork = imageBridge(artwork);
    }
    c.clear(COLORS.bg);
    c.gradientRect(0, 0, 1600, 520, [[0, '#111d2c'], [0.68, COLORS.bg], [1, '#0b141d']]);
    if (logo) logo.draw(c, 38, 18, 64, 64);
    else c.image(LOGO, 38, 18, 64, 64);
    text(c, 'PllanaCast for BMW', 119, 58, 24, COLORS.blue, { spacing: 1 });
    const audioOnly = state.mode === 'audio' || state.profile === 'audio', audioPlaying = state.phase === 'audio';
    const waiting = state.phase === 'waiting', loading = state.phase === 'loading';
    const busy = state.phase === 'starting' || state.phase === 'stopping' || state.phase === 'recovering' || loading;
    const connected = state.connected === true, android = state.sender === 'android';
    const status = state.phase === 'stopping' ? 'Wird getrennt …' : connected ? (android ? 'Mit Android verbunden' : 'Mit iPhone verbunden') : state.phase === 'error' ? 'Verbindung prüfen' : busy ? 'Einen Moment …' : waiting ? 'Empfang bereit' : 'Nicht verbunden';
    c.roundRect(1274, 28, 278, 44, 22, COLORS.card);
    c.circle(1298, 50, 5, connected ? COLORS.mint : state.phase === 'error' ? '#ffb178' : COLORS.muted);
    text(c, status, 1316, 58, 22, connected ? COLORS.mint : COLORS.muted);

    if (audioOnly) drawMusic(c, state, artwork, onControl);
    else {
    text(c, 'Dein Handy.', 48, 156, 62, COLORS.ink);
    text(c, 'Dein BMW.', 48, 226, 62, COLORS.ink);
    text(c, 'iPhone über AirPlay. Android über DLNA.', 51, 280, 28, COLORS.muted);
    modeCard(c, 48, 'Bildschirm & Videos', 'Bildschirmsynchronisierung / AirPlay', 'phone');
    modeCard(c, 540, 'Musik hören', 'Spotify oder YouTube Music', 'audio');

    c.card(1054, 100, 498, 341, 26, [[0, '#1b2e43'], [1, '#101b29']]);
    c.strokeRoundRect(1054, 100, 498, 341, 26, 1, '#30475e');
    text(c, connected ? (android ? 'Dein Android ist verbunden.' : 'Dein iPhone ist verbunden.') : state.pin ? 'PllanaCast for BMW' : 'Bereit, wenn du es bist.', 1084, 151, 29, COLORS.ink);
    if (connected) {
        const media = state.mode === 'hls' ? (loading ? 'Video wird geladen …' : 'Video läuft') : state.mode === 'mirror' && state.frame ? 'Bildschirmspiegelung aktiv' : 'Wartet auf Musik oder Video';
        text(c, media, 1084, 194, 25, COLORS.mint);
        airplay(c, 1258, 225, 90, COLORS.mint);
        text(c, android ? 'Wiedergabe vom Android-Handy.' : 'AirPlay bleibt verbunden.', 1303, 356, 25, COLORS.ink, { align: 'center' });
        text(c, android ? 'Am Handy steuern oder beenden.' : 'Musik oder Video am iPhone starten.', 1303, 395, 22, COLORS.muted, { align: 'center' });
    } else if (state.pin) {
        text(c, audioOnly ? 'Am iPhone als Audioausgabe wählen' : 'Am iPhone wählen und Code eingeben', 1084, 192, 23, COLORS.muted);
        const code = String(state.pin);
        const gap = 10, cell = Math.min(62, (438 - (code.length - 1) * gap) / code.length);
        const left = 1303 - (code.length * cell + (code.length - 1) * gap) / 2;
        for (let i = 0; i < code.length; i++) {
            c.roundRect(left + i * (cell + gap), 222, cell, 84, 12, '#080f19');
            text(c, code[i], left + i * (cell + gap) + cell / 2, 283, 50, '#ffffff', { align: 'center', literal: true });
        }
        text(c, 'BMW-WLAN oder gemeinsames WLAN.', 1084, 356, 23, COLORS.muted);
        text(c, state.directVideo === false ? 'Ohne Uplink: Video bleibt gespiegelt.' : 'Android: „PllanaCast for BMW“ + Code', 1084, 395, 23, COLORS.muted);
    } else {
        airplay(c, 1258, 201, 90, COLORS.blue);
        text(c, busy ? 'Verbindung wird vorbereitet.' : 'Unten „Verbinden“ drücken.', 1303, 337, 25, COLORS.ink, { align: 'center' });
        text(c, 'Am iPhone denselben Empfänger wählen.', 1303, 389, 22, COLORS.muted, { align: 'center' });
    }
    }
    const errors = { runtime_missing: 'Empfangssoftware fehlt.', discovery_failed: 'Geräteerkennung nicht erreichbar.',
        media_unsupported: 'Dieses Video kann der Empfänger nicht abspielen.',
        media_failed: 'Video konnte nicht geladen werden. Empfang bleibt bereit.',
        receiver_failed: 'Verbindung beendet. Bitte erneut verbinden.', backend_unavailable: 'Empfangsdienst wird verbunden …',
        disconnect_failed: 'AirPlay konnte nicht vollständig getrennt werden. Erneut „Trennen“ wählen.',
        video_viewport_failed: 'Videoausgabe konnte nicht angepasst werden. Erneut „Verbinden“ wählen.',
        receiver_recovering: 'Empfang wird automatisch wiederhergestellt …',
        music_control_failed: 'Musiksteuerung nicht erreichbar. Am iPhone weiter steuern.' };
    const controlErrors = { music_control_failed: 'Musiksteuerung nicht erreichbar. Am iPhone weiter steuern.',
        music_control_busy: 'Musiksteuerung beschäftigt. Kurz warten.', music_control_stale: 'Musikverbindung wird aktualisiert.' };
    const controlError = audioOnly && state.music && controlErrors[state.music.controlError];
    text(c, notice || errors[state.viewportError] || errors[state.error] || controlError || (state.audioError ? 'Für BMW-Ton erneut „Verbinden“ wählen.' : !connected && state.p2pText || 'Leon Pllana IT-Solutions'), 50, 490, 24,
        notice || state.viewportError || state.error || state.audioError || controlError ? '#ffbc8e' : COLORS.muted);
    text(c, 'pllana.io', 1552, 490, 24, COLORS.blue, { align: 'right' });
}
module.exports = { drawHome };
