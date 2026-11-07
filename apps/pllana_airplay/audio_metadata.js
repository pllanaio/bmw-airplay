'use strict';
const childProcess = require('child_process'), crypto = require('crypto'), fs = require('fs'), path = require('path');

const MAX_JSON = 4096, MAX_ART = 2 * 1024 * 1024, MAX_DIMENSION = 4096;
const KNOWN_FILES = ['current.json', 'current.json.tmp', 'cover.jpg', 'cover.png', 'cover.jpg.tmp', 'cover.png.tmp',
    'cover.tmp', 'thumbnail.rgba', 'thumbnail.rgba.tmp', 'decode-source', 'decode-source.tmp',
    'control.json', 'control.json.tmp', 'control.tmp', 'gst-registry.bin'];
const THUMB_SIDE = 256, THUMB_BYTES = THUMB_SIDE * THUMB_SIDE * 4;

function empty() { return { revision: 0, title: '', artist: '', album: '', artwork: null }; }
function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
function text(value) {
    return Array.from(value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ').trim()).slice(0, 256).join('');
}
function dimensions(bytes, mime) {
    let width, height;
    if (mime === 'image/png') {
        if (bytes.length < 33 || bytes.slice(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
            bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
        width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    } else if (mime === 'image/jpeg') {
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
        let at = 2;
        while (at < bytes.length) {
            if (bytes[at++] !== 0xff) return null;
            while (at < bytes.length && bytes[at] === 0xff) at++;
            if (at >= bytes.length) return null;
            const marker = bytes[at++];
            if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null;
            if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (at + 2 > bytes.length) return null;
            const length = bytes.readUInt16BE(at);
            if (length < 2 || length > bytes.length - at) return null;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].indexOf(marker) >= 0) {
                if (length < 8) return null;
                height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5);
                break;
            }
            at += length;
        }
    } else return null;
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > 16777216) return null;
    return { width, height };
}

class AudioMetadata {
    constructor(dataDir, options) {
        options = options || {};
        this.uid = options && options.uid !== undefined ? options.uid : process.getuid ? process.getuid() : 0;
        this.closed = false; this.decode = null; this.ready = null; this.failedKey = null;
        this.runtime = options.runtime || path.join(__dirname, 'runtime');
        this.spawn = options.spawn || childProcess.spawn;
        this.processEnv = options.env || {};
        const base = fs.lstatSync(dataDir);
        if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== this.uid || (base.mode & 0o077))
            throw Error('invalid_audio_metadata_directory');
        this.directory = path.join(path.resolve(dataDir), 'audio-meta-' + process.pid + '-' + crypto.randomBytes(12).toString('hex'));
        fs.mkdirSync(this.directory, 0o700);
        try {
            this.fd = fs.openSync(this.directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
            const st = fs.fstatSync(this.fd);
            if (!st.isDirectory() || st.uid !== this.uid || (st.mode & 0o077)) throw Error('invalid_audio_metadata_directory');
            this.identity = { dev: st.dev, ino: st.ino };
        } catch (e) {
            if (this.fd !== undefined) fs.closeSync(this.fd);
            try { fs.rmdirSync(this.directory); } catch (ignore) {}
            throw e;
        }
    }
    env() { return this.closed ? {} : { MGU_AUDIO_METADATA_DIR: this.directory, MGU_MUSIC_DIR: this.directory }; }
    // The open directory descriptor keeps a path replacement from redirecting
    // reads into another directory. The receiver and UI run as the same UID.
    file(name) { return '/proc/self/fd/' + this.fd + '/' + name; }
    read(name, limit) {
        let fd;
        try {
            const dir = fs.fstatSync(this.fd);
            if (!dir.isDirectory() || dir.uid !== this.uid || (dir.mode & 0o077)) return null;
            fd = fs.openSync(this.file(name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const st = fs.fstatSync(fd);
            if (!st.isFile() || st.nlink !== 1 || st.uid !== this.uid || (st.mode & 0o077) || st.size < 1 || st.size > limit) return null;
            const bytes = Buffer.alloc(st.size);
            if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return null;
            return bytes;
        } catch (e) { return null; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    remove(name) {
        try {
            const file = this.file(name), st = fs.lstatSync(file);
            if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === this.uid) fs.unlinkSync(file);
        } catch (e) {}
    }
    write(name, bytes) {
        const temporary = name + '.tmp';
        this.remove(temporary);
        let fd;
        try {
            fd = fs.openSync(this.file(temporary), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
            let at = 0;
            while (at < bytes.length) {
                const count = fs.writeSync(fd, bytes, at, bytes.length - at);
                if (count <= 0) throw Error('audio_artwork_write_failed');
                at += count;
            }
            fs.closeSync(fd); fd = undefined;
            fs.renameSync(this.file(temporary), this.file(name));
            return true;
        } catch (e) { this.remove(temporary); return false; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    cancelDecode() {
        const job = this.decode;
        this.decode = null;
        if (!job) return;
        clearTimeout(job.timer);
        try { job.child.kill('SIGKILL'); } catch (e) {}
    }
    clearArtwork() {
        this.cancelDecode(); this.ready = null; this.failedKey = null;
        this.remove('thumbnail.rgba'); this.remove('decode-source');
    }
    startDecode(key, bytes, art) {
        this.cancelDecode(); this.ready = null; this.remove('thumbnail.rgba');
        if (!this.write('decode-source', bytes)) { this.failedKey = key; return; }
        const env = Object.assign({}, process.env, this.processEnv, {
            GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_PLUGIN_PATH_1_0: path.join(this.runtime, 'plugins'),
            GST_REGISTRY: path.join(this.directory, 'gst-registry.bin'), GST_REGISTRY_FORK: 'no',
            LD_LIBRARY_PATH: path.join(this.runtime, 'lib'), GST_DEBUG: '0', GST_DEBUG_NO_COLOR: '1',
            GIO_MODULE_DIR: path.join(this.runtime, 'gio'),
        });
        let child;
        try {
            child = this.spawn(path.join(this.runtime, 'lib/ld-linux-x86-64.so.2'), [
                '--library-path', path.join(this.runtime, 'lib'), path.join(this.runtime, 'bin/gst-launch-1.0'), '-q',
                'filesrc', 'location=/proc/' + process.pid + '/fd/' + this.fd + '/decode-source', '!', 'decodebin', '!',
                'videoconvertscale', 'add-borders=true', '!', 'video/x-raw,format=RGBA,width=256,height=256,pixel-aspect-ratio=1/1', '!',
                'fdsink', 'fd=1',
            ], { env, cwd: this.directory, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) { this.failedKey = key; return; }
        const job = { key, child, chunks: [], length: 0, timer: null };
        this.decode = job;
        const fail = () => {
            if (this.decode !== job) return;
            this.failedKey = key; this.cancelDecode();
        };
        job.timer = setTimeout(fail, 3000);
        if (!child.stdout) { fail(); return; }
        child.stdout.on('data', chunk => {
            if (this.decode !== job) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (job.length + bytes.length > THUMB_BYTES) { fail(); return; }
            job.chunks.push(bytes); job.length += bytes.length;
        });
        child.once('error', fail);
        child.once('close', (code, signal) => {
            if (this.decode !== job) return;
            clearTimeout(job.timer); this.decode = null;
            if (this.closed || code !== 0 || signal || job.length !== THUMB_BYTES) { this.failedKey = key; return; }
            const pixels = Buffer.concat(job.chunks, job.length);
            if (!this.write('thumbnail.rgba', pixels)) { this.failedKey = key; return; }
            this.ready = { key, artwork: { file: path.join(this.directory, 'thumbnail.rgba'), mime: 'application/x-rgba',
                revision: art.revision, width: THUMB_SIDE, height: THUMB_SIDE } };
            this.remove('decode-source');
        });
    }
    poll() {
        if (this.closed) return empty();
        const bytes = this.read('current.json', MAX_JSON);
        if (!bytes) { this.clearArtwork(); return empty(); }
        let metadata;
        try { metadata = JSON.parse(bytes.toString('utf8')); } catch (e) { this.clearArtwork(); return empty(); }
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !revision(metadata.revision) ||
            typeof metadata.title !== 'string' || typeof metadata.artist !== 'string' || typeof metadata.album !== 'string') { this.clearArtwork(); return empty(); }
        const result = { revision: metadata.revision, title: text(metadata.title), artist: text(metadata.artist), album: text(metadata.album), artwork: null };
        const art = metadata.artwork;
        if (!art || typeof art !== 'object' || !revision(art.revision) ||
            (art.file !== 'cover.jpg' && art.file !== 'cover.png') ||
            art.mime !== (art.file === 'cover.png' ? 'image/png' : 'image/jpeg')) { this.clearArtwork(); return result; }
        const image = this.read(art.file, MAX_ART), size = image && dimensions(image, art.mime);
        if (!size || size.width !== art.width || size.height !== art.height) { this.clearArtwork(); return result; }
        const key = JSON.stringify([result.title, result.artist, result.album, art.revision, crypto.createHash('sha256').update(image).digest('hex')]);
        if (this.ready && this.ready.key === key) result.artwork = this.ready.artwork;
        else if ((!this.decode || this.decode.key !== key) && this.failedKey !== key) this.startDecode(key, image, art);
        return result;
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        this.cancelDecode();
        try {
            const dir = fs.fstatSync(this.fd);
            if (dir.isDirectory() && dir.uid === this.uid && !(dir.mode & 0o077)) {
                KNOWN_FILES.forEach(name => this.remove(name));
                try {
                    const current = fs.lstatSync(this.directory);
                    if (current.isDirectory() && !current.isSymbolicLink() && current.uid === this.uid &&
                        current.dev === this.identity.dev && current.ino === this.identity.ino) fs.rmdirSync(this.directory);
                } catch (e) {}
            }
        } finally { fs.closeSync(this.fd); this.fd = undefined; }
    }
}
module.exports = { AudioMetadata };
