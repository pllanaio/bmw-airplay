'use strict';
const { message } = require('./video_bridge');
const brand = require('./brand_logo');
// Native mgu-render image 10 / draw op 18 use a different layout to SDK images.
class LogoBridge {
    constructor(display) { this.display = display; this.key = null; this.gpu = null; this.socket = null; }
    draw(c, x, y, w, h) {
        const gpu = this.display && this.display.gpu;
        if (!gpu || !gpu.ready || !gpu.native) { c.image(brand.ID, x, y, w, h); return; }
        const p = gpu.placement || {}, key = [p.w, p.h, p.scale].join(':');
        if (gpu !== this.gpu || gpu.sock !== this.socket || key !== this.key) {
            const head = Buffer.alloc(12), pixels = Buffer.from(brand.pixels);
            head.writeUInt32LE(brand.ID, 0); head.writeUInt32LE(128, 4); head.writeUInt32LE(128, 8);
            for (let at = 0; at < pixels.length; at += 4) {
                const alpha = pixels[at + 3] / 255;
                for (let k = 0; k < 3; k++) pixels[at + k] = Math.round(pixels[at + k] * alpha);
            }
            gpu._write(message(10, Buffer.concat([head, pixels])));
            this.gpu = gpu; this.socket = gpu.sock; this.key = key;
        }
        c._grow(7); const i = c.n;
        c.u[i] = 18; c.f[i + 1] = x; c.f[i + 2] = y; c.f[i + 3] = w; c.f[i + 4] = h;
        c.f[i + 5] = 0; c.u[i + 6] = brand.ID; c.n += 7;
    }
}
module.exports = { LogoBridge };
