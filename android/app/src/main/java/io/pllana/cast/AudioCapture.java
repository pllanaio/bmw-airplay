package io.pllana.cast;

import android.annotation.SuppressLint;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.util.Log;

/**
 * Sound that other apps play (AudioPlaybackCapture, Android 10+), as PCM
 * S16LE 48 kHz stereo in 20 ms blocks. Apps that forbid capture (some
 * streaming services with DRM) stay silent; the picture still works.
 */
final class AudioCapture {
    private static final String TAG = "pllanaCast";
    private static final int RATE = 48000, BLOCK = RATE / 50 * 4;

    private final CastConnection connection;
    private AudioRecord record;
    private Thread thread;
    private volatile boolean running;

    AudioCapture(CastConnection connection) { this.connection = connection; }

    @SuppressLint("MissingPermission")
    boolean start(MediaProjection projection) {
        try {
            AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();
            AudioFormat format = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                    .build();
            int minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            record = new AudioRecord.Builder()
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(Math.max(minimum * 2, BLOCK * 8))
                    .setAudioPlaybackCaptureConfig(config)
                    .build();
            if (record.getState() != AudioRecord.STATE_INITIALIZED) { release(); return false; }
            record.startRecording();
        } catch (Exception e) {
            Log.w(TAG, "audio capture unavailable", e);
            release();
            return false;
        }
        running = true;
        thread = new Thread(this::loop, "pllana-cast-audio");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
        return true;
    }

    private void loop() {
        byte[] block = new byte[BLOCK];
        long blockUs = 20_000;
        while (running) {
            int filled = 0;
            while (running && filled < BLOCK) {
                int n = record.read(block, filled, BLOCK - filled);
                if (n <= 0) { if (n < 0) running = false; break; }
                filled += n;
            }
            if (filled == BLOCK) {
                // Same monotonic clock as the video frames (System.nanoTime).
                long pts = System.nanoTime() / 1000 - blockUs;
                connection.send(CastConnection.TYPE_AUDIO, false, pts, block, 0, BLOCK);
            }
        }
    }

    void stop() {
        running = false;
        if (thread != null) { try { thread.join(300); } catch (InterruptedException ignored) { } thread = null; }
        release();
    }

    private void release() {
        if (record != null) {
            try { record.stop(); } catch (IllegalStateException ignored) { }
            record.release();
            record = null;
        }
    }
}
