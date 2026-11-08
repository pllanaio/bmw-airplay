package io.pllana.cast;

import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Screen -> VirtualDisplay -> H.264 (MediaCodec, surface input) -> connection.
 * The picture is scaled into 1280x720 (portrait too); rotation or
 * a resized single-app capture reconfigures the encoder without asking the
 * user again (the VirtualDisplay is resized, never recreated).
 */
final class ScreenEncoder {
    private static final String TAG = "pllanaCast";
    private static final int LONG_EDGE = 1280, SHORT_EDGE = 720, FPS = 30, BITRATE = 6_000_000;

    private final MediaProjection projection;
    private final CastConnection connection;
    private final int densityDpi;
    private VirtualDisplay display;
    private MediaCodec codec;
    private Surface surface;
    private Thread drain;
    private volatile boolean running;
    private int width, height;
    /** Diagnosis counters. */
    volatile long encoded, keyFrames, configs;
    volatile String codecName = "";

    ScreenEncoder(MediaProjection projection, CastConnection connection, int densityDpi) {
        this.projection = projection;
        this.connection = connection;
        this.densityDpi = densityDpi;
    }

    /**
     * Encoder size for a source size: fits into 1280x720 in both orientations
     * (portrait becomes e.g. 320x720), like iPhone mirroring, whose frame
     * sizes the BMW renderer is proven with. Multiples of 16.
     */
    static int[] target(int sourceWidth, int sourceHeight) {
        int maxW = LONG_EDGE, maxH = SHORT_EDGE;
        double scale = Math.min(1.0, Math.min((double) maxW / sourceWidth, (double) maxH / sourceHeight));
        int w = Math.max(160, (int) Math.floor(sourceWidth * scale / 16) * 16);
        int h = Math.max(160, (int) Math.floor(sourceHeight * scale / 16) * 16);
        return new int[] { w, h };
    }

    synchronized void start(int sourceWidth, int sourceHeight) throws IOException {
        int[] size = target(sourceWidth, sourceHeight);
        width = size[0]; height = size[1];
        openCodec();
        display = projection.createVirtualDisplay("pllana Cast", width, height, densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null);
        startDrain();
    }

    synchronized void resize(int sourceWidth, int sourceHeight) {
        int[] size = target(sourceWidth, sourceHeight);
        if (!running || (size[0] == width && size[1] == height)) return;
        CastLog.add("Größe " + width + "×" + height + " → " + size[0] + "×" + size[1]);
        stopDrain();
        display.setSurface(null);
        releaseCodec();
        width = size[0]; height = size[1];
        try {
            openCodec();
            display.resize(width, height, densityDpi);
            display.setSurface(surface);
            startDrain();
        } catch (IOException | RuntimeException e) {
            CastLog.error("Encoder-Neustart", e);
            connection.close("encoder");
        }
    }

    int width() { return width; }
    int height() { return height; }

    private void openCodec() throws IOException {
        MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        format.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR);
        // A still screen produces no frames; repeat the last one so the car
        // always has a current picture and regular key frames.
        format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 250_000);
        format.setInteger(MediaFormat.KEY_PRIORITY, 0);
        format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) format.setInteger(MediaFormat.KEY_LATENCY, 1);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        } catch (RuntimeException e) {
            // Some encoders reject optional keys; retry with the essentials.
            CastLog.error("Encoder-Optionen abgelehnt, Basisformat", e);
            codec.release();
            MediaFormat basic = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
            basic.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            basic.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE);
            basic.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
            basic.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
            basic.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 250_000);
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            codec.configure(basic, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        }
        surface = codec.createInputSurface();
        codec.start();
        try { codecName = codec.getName(); } catch (RuntimeException ignored) { }
        CastLog.add("Encoder " + codecName + " " + width + "×" + height);
    }

    private void startDrain() {
        running = true;
        final MediaCodec current = codec;
        drain = new Thread(() -> drainLoop(current), "pllana-cast-encoder");
        drain.setPriority(Thread.MAX_PRIORITY);
        drain.start();
    }

    private void drainLoop(MediaCodec current) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] scratch = new byte[256 * 1024];
        while (running) {
            int index;
            try { index = current.dequeueOutputBuffer(info, 20_000); }
            catch (IllegalStateException e) { if (running) CastLog.error("Encoder", e); return; }
            if (index < 0) continue;
            ByteBuffer buffer = current.getOutputBuffer(index);
            if (buffer != null && info.size > 0) {
                if (scratch.length < info.size) scratch = new byte[info.size * 2];
                buffer.position(info.offset);
                buffer.get(scratch, 0, info.size);
                boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                if (config) { if (configs++ == 0) CastLog.add("Erste Codec-Konfiguration (" + info.size + " Bytes)"); }
                else { if (encoded++ == 0) CastLog.add("Erstes Bild kodiert" + (key ? " (Keyframe)" : " (kein Keyframe!)")); if (key) keyFrames++; }
                connection.send(config ? CastConnection.TYPE_CONFIG : CastConnection.TYPE_VIDEO, key, info.presentationTimeUs, scratch, 0, info.size);
            }
            current.releaseOutputBuffer(index, false);
        }
    }

    /** Asks the encoder for an immediate key frame (after dropped frames). */
    void requestKeyFrame() {
        MediaCodec current = codec;
        if (current == null) return;
        Bundle params = new Bundle();
        params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try { current.setParameters(params); } catch (IllegalStateException ignored) { }
    }

    private void stopDrain() {
        running = false;
        if (drain != null) {
            try { drain.join(500); } catch (InterruptedException ignored) { }
            drain = null;
        }
    }

    private void releaseCodec() {
        if (codec != null) {
            try { codec.stop(); } catch (IllegalStateException ignored) { }
            codec.release();
            codec = null;
        }
        if (surface != null) { surface.release(); surface = null; }
    }

    synchronized void stop() {
        stopDrain();
        if (display != null) { display.release(); display = null; }
        releaseCodec();
    }
}
