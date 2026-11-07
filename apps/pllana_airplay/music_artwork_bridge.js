'use strict';
const fs = require('fs'), path = require('path');
const { message } = require('./video_bridge');
const { setImage, imageById } = require('./kit/record');
const ID = 0x415254;

// The receiver publishes a bounded, decoded thumbnail in its private session
// directory. Encoded sender artwork never reaches the renderer protocol.
class MusicArtworkBridge {
    constructor(display, directory) {
        this.display = display; this.directory = path.resolve(directory);
        this.key = null; this.pixels = null; this.gpu = null; this.socket = null; this.uploaded = null; this.version = 0;
    }
    drop() {
        if (this.gpu && this.gpu.ready && this.gpu.sock === this.socket && this.uploaded) {
            const id = Buffer.alloc(4); id.writeUInt32LE(ID, 0);
            this.gpu._write(message(11, id));
        }
        imageById.delete(ID);
        this.key = this.pixels = this.gpu = this.socket = this.uploaded = null;
    }
    update(art, epoch) {
        if (!art || art.mime !== 'application/x-rgba' || art.width !== 256 || art.height !== 256 ||
            typeof art.file !== 'string' || !Number.isSafeInteger(art.revision) || art.revision < 0) {
            if (this.key) this.drop();
            return false;
        }
        const file = path.resolve(art.file), parent = path.dirname(file);
        if (path.dirname(parent) !== this.directory || !/^audio-meta-\d+-[a-f0-9]{24}$/.test(path.basename(parent)) ||
            path.basename(file) !== 'thumbnail.rgba') { this.drop(); return false; }
        const key = [file, epoch, art.revision].join(':');
        if (this.key === key && this.pixels) return true;
        this.drop();
        let dir, fd;
        try {
            const uid = process.getuid ? process.getuid() : 0;
            dir = fs.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
            const directory = fs.fstatSync(dir);
            if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077)) return false;
            fd = fs.openSync('/proc/self/fd/' + dir + '/thumbnail.rgba', fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const st = fs.fstatSync(fd);
            if (!st.isFile() || st.nlink !== 1 || st.uid !== uid || (st.mode & 0o077) || st.size !== 256 * 256 * 4) return false;
            const pixels = Buffer.alloc(st.size);
            if (fs.readSync(fd, pixels, 0, pixels.length, 0) !== pixels.length) return false;
            // The SDK's software image path copies opaque RGB. Composite a
            // separate copy onto the cover card; native upload keeps alpha.
            const software = Buffer.from(pixels), background = [17, 26, 38];
            for (let at = 0; at < software.length; at += 4) {
                const alpha = software[at + 3] / 255;
                for (let k = 0; k < 3; k++) software[at + k] = Math.round(software[at + k] * alpha + background[k] * (1 - alpha));
                software[at + 3] = 255;
            }
            const image = setImage(ID, 256, 256, software);
            // SDK transports cache image ID/version across frames. Removing
            // a stale image must not restart the next cover's version at one.
            image.ver = ++this.version;
            this.key = key; this.pixels = pixels;
            return true;
        } catch (e) { return false; }
        finally { if (fd !== undefined) fs.closeSync(fd); if (dir !== undefined) fs.closeSync(dir); }
    }
    draw(c, x, y, w, h) {
        if (!this.pixels) return false;
        const gpu = this.display && this.display.gpu;
        if (!gpu || !gpu.ready || !gpu.native) { c.image(ID, x, y, w, h); return true; }
        const p = gpu.placement || {}, key = [this.key, p.w, p.h, p.scale].join(':');
        if (gpu !== this.gpu || gpu.sock !== this.socket || key !== this.uploaded) {
            const head = Buffer.alloc(12), pixels = Buffer.from(this.pixels);
            head.writeUInt32LE(ID, 0); head.writeUInt32LE(256, 4); head.writeUInt32LE(256, 8);
            for (let at = 0; at < pixels.length; at += 4) {
                const alpha = pixels[at + 3] / 255;
                for (let k = 0; k < 3; k++) pixels[at + k] = Math.round(pixels[at + k] * alpha);
            }
            gpu._write(message(10, Buffer.concat([head, pixels])));
            this.gpu = gpu; this.socket = gpu.sock; this.uploaded = key;
        }
        c._grow(7); const i = c.n;
        c.u[i] = 18; c.f[i + 1] = x; c.f[i + 2] = y; c.f[i + 3] = w; c.f[i + 4] = h;
        c.f[i + 5] = 12; c.u[i + 6] = ID; c.n += 7;
        return true;
    }
}
module.exports = { MusicArtworkBridge, ID };
