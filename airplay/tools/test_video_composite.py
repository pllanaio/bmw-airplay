"""Check real HLS output after actual VideoBridge and mgu-render composition.

Run after build_runtime.py. --app-root may name the JavaScript directory of an
extracted Store app, so the recorded commands come from the packaged bridge.
The renderer is compiled without patches from the pinned Store checkout.
Mesa's surfaceless EGL reads the final framebuffer; checking only I420 caps or
the PLACE message would miss a second aspect-preserving fit in OP_VIDEO.
"""
from pathlib import Path
import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.build/airplay/video-composite'
STORE_REV = '8cfae23db27e51d86f84e65b13ce0592668d8df9'
CASES = [('screen-720', (1920, 720), None),
         ('screen-504', (1920, 504), None),
         ('normal-card', (1600, 520), None),
         ('borderless-body', (1600, 560), None),
         ('enter-fullscreen', (1600, 560), (1920, 720)),
         ('restore-controls', (1920, 720), (1600, 560))]

# Use the actual app bridge, capturing the same native message/command bytes
# that its existing GPU connection receives. No replacement OP_VIDEO logic.
RECORD = r'''
const fs = require('fs'), path = require('path');
const app = process.argv[1], frame = process.argv[2], output = process.argv[3];
const w = Number(process.argv[4]), h = Number(process.argv[5]);
const header = fs.readFileSync(frame).slice(0, 64);
const source = { width: header.readUInt32LE(8), height: header.readUInt32LE(12) };
const bridgeModule = require(path.join(app, 'video_bridge'));
const message = bridgeModule.message;
const messages = [message(1, Buffer.from('airplay-composite-test\0proto=mgu-render/1'))];
const place = Buffer.alloc(28);
[0, 0, w, h].forEach((value, i) => place.writeInt32LE(value, i * 4));
place.writeFloatLE(1, 16);
messages.push(message(2, place));
const gpu = { ready: true, native: true, info: { video: true }, sock: {},
    placement: { w, h, scale: 1 }, _write: bytes => messages.push(bytes) };
const bridge = new bridgeModule.VideoBridge({ gpu });
if (!bridge.attach(frame, 'composite')) throw Error('native video attachment failed');
const bytes = new ArrayBuffer(4096);
const canvas = { n: 2, u: new Uint32Array(bytes), f: new Float32Array(bytes),
    _grow: function (count) { if (this.n + count > this.u.length) throw Error('recording overflow'); },
    clip: function (x, y, w, h) { this.u[this.n++] = 13; [x,y,w,h].forEach(v => { this.f[this.n++] = v; }); return this; },
    noclip: function () { this.u[this.n++] = 14; return this; } };
canvas.u[0] = 1; canvas.u[1] = 0x000000ff;
bridge.draw(canvas, 0, 0, w, h, source, 'stretch');
messages.push(message(7, Buffer.from(canvas.u.slice(0, canvas.n).buffer)));
fs.writeFileSync(output, Buffer.concat(messages));
'''


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def build_renderer(store):
    revision = subprocess.check_output(['git', '-C', str(store), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != STORE_REV:
        raise RuntimeError('Composite renderer must use pinned Store source ' + STORE_REV)
    source = store / 'native/mgu-render'
    generated = WORK / 'renderer/protocol'
    generated.mkdir(parents=True, exist_ok=True)
    protocol = []
    for name in ['ivi-application', 'ivi-controller', 'wayland-drm']:
        xml = source / 'protocol' / (name + '.xml')
        run(['wayland-scanner', 'client-header', xml, generated / (name + '-client-protocol.h')])
        code = generated / (name + '-protocol.c')
        run(['wayland-scanner', 'private-code', xml, code])
        protocol.append(code)
    binary = WORK / 'renderer/mgu-render'
    run(['gcc', '-O2', '-g0', '-Wall', '-Wextra', '-Wno-unused-parameter',
         '-Wno-misleading-indentation', '-Werror', '-std=gnu11',
         '-I' + str(source / 'src'), '-I' + str(generated),
         *sorted((source / 'src').glob('*.c')), *protocol, '-o', binary,
         '-lwayland-client', '-lwayland-egl', '-lEGL', '-lGLESv2', '-lm', '-ldl'])
    return binary


def read_frame(path):
    data = path.read_bytes()
    if len(data) < 64:
        raise RuntimeError('Retained native video has no complete header: ' + str(path))
    header = struct.unpack_from('<16I', data)
    magic, version, width, height, sequence, slot, slots, matrix, full = header[:9]
    if magic != 0x4656474d or version != 1 or not sequence or not (0 <= slot < slots <= 4):
        raise RuntimeError('Invalid retained native video: ' + str(path))
    if not (16 <= width <= 2048 and 16 <= height <= 2048) or (width | height) & 1:
        raise RuntimeError('Invalid retained native dimensions: ' + str(path))
    size = width * height * 3 // 2
    frame = data[64 + slot * size:64 + (slot + 1) * size]
    if len(frame) != size:
        raise RuntimeError('Incomplete retained native pixels: ' + str(path))
    return width, height, matrix, full, frame


def rgb(frame, x, y):
    width, height, matrix, full, pixels = frame
    x = min(width - 1, max(0, x))
    y = min(height - 1, max(0, y))
    luma = pixels[y * width + x] / 255
    chroma = (y // 2) * (width // 2) + x // 2
    u = pixels[width * height + chroma] / 255 - 128 / 255
    v = pixels[width * height * 5 // 4 + chroma] / 255 - 128 / 255
    if not full:
        luma = (luma - 16 / 255) * 255 / 219
        u *= 255 / 224
        v *= 255 / 224
    if matrix:
        values = [luma + 1.5748 * v, luma - .187324 * u - .468124 * v, luma + 1.8556 * u]
    else:
        values = [luma + 1.402 * v, luma - .344136 * u - .714136 * v, luma + 1.772 * u]
    return [round(max(0, min(1, value)) * 255) for value in values]


def check_pixels(pam, frame, width, height):
    data = pam.read_bytes()
    start = data.index(b'ENDHDR\n') + 7
    header = data[:start].decode('ascii')
    actual = tuple(int(re.search(key + r' (\d+)', header)[1]) for key in ['WIDTH', 'HEIGHT', 'DEPTH'])
    if actual != (width, height, 4) or len(data) - start != width * height * 4:
        raise AssertionError('Unexpected real renderer framebuffer: ' + str(actual))
    pixels = memoryview(data)[start:]
    empty = 0
    first = None
    for y in range(height):
        for x in range(width):
            at = (y * width + x) * 4
            if max(pixels[at:at + 3]) <= 4:
                empty += 1
                if first is None:
                    first = [x, y]
    if empty:
        raise AssertionError('%dx%d actual composition has %d empty pixels; first at %s' %
                             (width, height, empty, first))
    # Compare all corners, edge midpoints and center to the actual native
    # frame. Native HLS tests separately prove its source-corner pattern.
    for y in [8, height // 2, height - 9]:
        for x in [8, width // 2, width - 9]:
            expected = rgb(frame, int((x + .5) * frame[0] / width), int((y + .5) * frame[1] / height))
            at = (y * width + x) * 4
            observed = list(pixels[at:at + 3])
            if any(abs(a - b) > 10 for a, b in zip(expected, observed)):
                raise AssertionError('Composited source point %d,%d: expected %s, got %s' %
                                     (x, y, expected, observed))
    return {'width': width, 'height': height, 'emptyPixels': empty,
            'nativeWidth': frame[0], 'nativeHeight': frame[1], 'sourcePoints': 9}


def composite(binary, app, retained, width, height, name):
    frame = read_frame(retained)
    # The renderer's actual file validation is part of this test, too.
    shared = Path('/dev/shm/mgu-video-composite-%d' % os.getpid())
    recording = WORK / (name + '.bin')
    pam = WORK / (name + '.pam')
    try:
        shutil.copyfile(retained, shared)
        shared.chmod(0o600)
        run(['node', '-e', RECORD, app, shared, recording, width, height])
        run([binary, '--replay', recording, '--out', pam],
            env=dict(os.environ, LIBGL_ALWAYS_SOFTWARE='1', EGL_PLATFORM='surfaceless'), timeout=20)
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', pam,
             '-frames:v', '1', WORK / (name + '.png')])
        result = check_pixels(pam, frame, width, height)
        print('Real mgu-render composition: %s, complete source, no empty viewport pixels' % name, flush=True)
        return dict(result, name=name)
    finally:
        shared.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store-root', type=Path, default=ROOT / '.local/airplay/store-validator')
    parser.add_argument('--app-root', type=Path, default=ROOT / 'apps/pllana_airplay')
    parser.add_argument('--frame', type=Path, help='check an already retained native fixture instead of running HLS')
    parser.add_argument('--retained-dir', type=Path, help='compose every actual frame listed in an existing frames.json')
    parser.add_argument('--viewport', default='1920x720', help='target for --frame')
    parser.add_argument('--case', action='append', choices=[case[0] for case in CASES],
                        help='run selected cases (the default runs the complete matrix)')
    parser.add_argument('--compose-only', action='store_true',
                        help='reuse retained native frames to check a newly packaged app bridge')
    args = parser.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    binary = build_renderer(args.store_root.resolve())
    app = args.app_root.resolve()
    if not (app / 'video_bridge.js').is_file():
        raise RuntimeError('--app-root must contain the actual app video_bridge.js')
    if args.frame:
        width, height = map(int, args.viewport.split('x'))
        results = [composite(binary, app, args.frame.resolve(), width, height, 'retained-' + args.viewport)]
    elif args.retained_dir:
        results = compose_retained(binary, app, args.retained_dir.resolve(), 'retained')
    else:
        results = []
        # Each target uses six different source aspects. These are actual
        # decoder/filter output frames, not synthetic files sized to make the
        # renderer pass. The native fixture also checks source-corner pixels.
        for index, (name, initial, resized) in enumerate(CASES):
            if args.case and name not in args.case:
                continue
            directory = WORK / name
            command = [sys.executable, ROOT / 'airplay/tools/test_hls.py',
                       '--viewport', '%dx%d' % initial, '--retain-dir', directory]
            if resized:
                # The production probe reacts to subsequent video buffers.
                # This exercises a playing pipeline, without promising that
                # an unchanged paused image can renegotiate by itself.
                command += ['--resize', '%dx%d' % resized]
            else:
                command += ['--stretch']
            if index == 0:
                command += ['--resets', '100']
            if not args.compose_only:
                run(command, cwd=ROOT, timeout=360)
            results += compose_retained(binary, app, directory, name, resized or initial,
                                        1 if resized else 6)
    (WORK / 'metrics.json').write_text(json.dumps(results, indent=2) + '\n')
    print('%d actual HLS → VideoBridge → mgu-render framebuffer cases passed' % len(results), flush=True)


def compose_retained(binary, app, directory, prefix, expected_target=None, expected_count=None):
    retained = json.loads((directory / 'frames.json').read_text())
    if not retained:
        raise AssertionError('Native HLS retained no real output frames')
    if expected_count is not None and len(retained) != expected_count:
        raise AssertionError('Native HLS retained an incomplete source-aspect matrix')
    results = []
    for entry in retained:
        source = entry['source']
        width, height = entry['viewport']
        if expected_target and (width, height) != expected_target:
            raise AssertionError('Retained viewport does not match the requested app viewport')
        name = '%s-%dx%d-to-%dx%d' % (prefix, *source, width, height)
        result = composite(binary, app, Path(entry['file']), width, height, name)
        results.append(dict(result, sourceWidth=source[0], sourceHeight=source[1]))
    return results


if __name__ == '__main__':
    main()
