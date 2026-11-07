'use strict';
// mgu-render/1 message 13 and draw op 19; uses the SDK's existing GPU connection.
function message(type, payload) {
    const b = Buffer.alloc(8 + ((payload.length + 3) & ~3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4); payload.copy(b, 8);
    return b;
}
class VideoBridge {
    constructor(display) { this.display = display; this.gpu = null; this.socket = null; this.file = ''; }
    ready() {
        const gpu = this.display && this.display.gpu;
        return !!(gpu && gpu.ready && gpu.native && gpu.info && gpu.info.video);
    }
    attach(file, generation) {
        const gpu = this.display && this.display.gpu;
        if (!this.ready()) { this.gpu = null; this.socket = null; this.file = ''; return false; }
        // PLACE can discard native video resources; HLS transitions can replace
        // the file at the same pathname. Both require defining the video again.
        const p = gpu.placement || {};
        const layout = [p.w, p.h, p.scale].join(':');
        if (gpu === this.gpu && gpu.sock === this.socket && this.file === file &&
            generation === this.generation && layout === this.layout) return true;
        const name = Buffer.from(file, 'utf8'), payload = Buffer.alloc(4 + name.length);
        payload.writeUInt32LE(1, 0); name.copy(payload, 4);
        gpu._write(message(13, payload));
        this.gpu = gpu; this.socket = gpu.sock; this.file = file;
        this.generation = generation; this.layout = layout;
        return true;
    }
    detach() {
        if (this.gpu && this.gpu.ready && this.gpu.sock === this.socket) {
            const id = Buffer.alloc(4); id.writeUInt32LE(1, 0); this.gpu._write(message(14, id));
        }
        this.gpu = null; this.socket = null; this.file = '';
    }
    draw(canvas, x, y, w, h) {
        canvas._grow(7); const i = canvas.n;
        canvas.u[i] = 19;
        canvas.f[i + 1] = x; canvas.f[i + 2] = y; canvas.f[i + 3] = w; canvas.f[i + 4] = h;
        canvas.f[i + 5] = 0; canvas.u[i + 6] = 1; canvas.n += 7;
    }
}
module.exports = { VideoBridge, message };
