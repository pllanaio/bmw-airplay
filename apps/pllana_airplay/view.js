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
    } else {
        c.roundRect(x + 21, 359, 43, 30, 8, '#d84c53');
        c.quad([[x + 39, 366], [x + 49, 374], [x + 39, 382], [x + 39, 366]], '#ffffff');
    }
    text(c, title, x + 83, 371, 27, COLORS.ink);
    text(c, sub, x + 83, 408, 22, COLORS.muted);
}
function drawHome(c, state, notice, logo) {
    c.clear(COLORS.bg);
    c.gradientRect(0, 0, 1600, 520, [[0, '#111d2c'], [0.68, COLORS.bg], [1, '#0b141d']]);
    if (logo) logo.draw(c, 38, 18, 64, 64);
    else c.image(LOGO, 38, 18, 64, 64);
    text(c, 'BMW AirPlay by pllana.io', 119, 58, 24, COLORS.blue, { spacing: 1 });
    const waiting = state.phase === 'waiting', loading = state.phase === 'loading';
    const busy = state.phase === 'starting' || state.phase === 'stopping' || state.phase === 'recovering' || loading;
    const status = state.detached ? 'Video läuft unabhängig' : loading ? 'Video wird geladen' : waiting ? 'Empfang bereit' : state.phase === 'error' ? 'Verbindung prüfen' : busy ? 'Einen Moment …' : 'Nicht verbunden';
    c.roundRect(1274, 28, 278, 44, 22, COLORS.card);
    c.circle(1298, 50, 5, waiting ? COLORS.mint : state.phase === 'error' ? '#ffb178' : COLORS.muted);
    text(c, status, 1316, 58, 22, waiting ? COLORS.mint : COLORS.muted);

    text(c, 'Dein iPhone.', 48, 156, 62, COLORS.ink);
    text(c, 'Dein BMW.', 48, 226, 62, COLORS.ink);
    text(c, 'Bild und Ton. Drahtlos auf deinem Display.', 51, 280, 28, COLORS.muted);
    modeCard(c, 48, 'Bildschirm spiegeln', 'Im iPhone-Kontrollzentrum starten', 'phone');
    modeCard(c, 540, 'YouTube übertragen', state.directVideo === false ? 'Über Bildschirmsynchronisierung' : 'AirPlay direkt in YouTube wählen', 'youtube');

    c.card(1054, 100, 498, 341, 26, [[0, '#1b2e43'], [1, '#101b29']]);
    c.strokeRoundRect(1054, 100, 498, 341, 26, 1, '#30475e');
    text(c, state.pin ? 'BMW AirPlay by pllana.io' : 'Bereit, wenn du es bist.', 1084, 151, 29, COLORS.ink);
    if (state.pin) {
        text(c, 'Am iPhone wählen und Code eingeben', 1084, 192, 23, COLORS.muted);
        const code = String(state.pin);
        const gap = 10, cell = Math.min(62, (438 - (code.length - 1) * gap) / code.length);
        const left = 1303 - (code.length * cell + (code.length - 1) * gap) / 2;
        for (let i = 0; i < code.length; i++) {
            c.roundRect(left + i * (cell + gap), 222, cell, 84, 12, '#080f19');
            text(c, code[i], left + i * (cell + gap) + cell / 2, 283, 50, '#ffffff', { align: 'center', literal: true });
        }
        text(c, 'BMW-WLAN oder gemeinsames WLAN.', 1084, 356, 23, COLORS.muted);
        text(c, state.directVideo === false ? 'Ohne Uplink: Video bleibt gespiegelt.' : 'Lautstärke wie gewohnt am iDrive.', 1084, 395, 23, COLORS.muted);
    } else {
        airplay(c, 1258, 201, 90, COLORS.blue);
        text(c, busy ? 'Verbindung wird vorbereitet.' : 'Unten „Verbinden“ drücken.', 1303, 337, 25, COLORS.ink, { align: 'center' });
        text(c, 'Am iPhone denselben Empfänger wählen.', 1303, 389, 22, COLORS.muted, { align: 'center' });
    }
    const errors = { runtime_missing: 'Empfangssoftware fehlt.', discovery_failed: 'Geräteerkennung nicht erreichbar.',
        media_unsupported: 'Dieses Video kann der Empfänger nicht abspielen.',
        media_failed: 'Video konnte nicht geladen werden. Empfang bleibt bereit.',
        receiver_failed: 'Verbindung beendet. Bitte erneut verbinden.', backend_unavailable: 'Empfangsdienst wird verbunden …',
        receiver_recovering: 'Empfang wird automatisch wiederhergestellt …' };
    text(c, notice || errors[state.error] || (state.audioError ? 'Für BMW-Ton erneut „Verbinden“ wählen.' : 'Leon Pllana IT-Solutions'), 50, 490, 24,
        notice || state.error || state.audioError ? '#ffbc8e' : COLORS.muted);
    text(c, 'pllana.io', 1552, 490, 24, COLORS.blue, { align: 'right' });
}
module.exports = { drawHome };
