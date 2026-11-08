package io.pllana.cast;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import org.json.JSONObject;

/**
 * Connection to the BMW AirPlay receiver (protocol pllana-cast/1, TCP 7104).
 *
 * Handshake (JSON lines): the receiver sends {proto, name, nonce}; the phone
 * answers {proto, device, auth = HMAC-SHA256(code, nonce), audio, width,
 * height}; the receiver replies {ok:true} or {ok:false, error}. Afterwards the
 * phone sends frames: u8 type, u8 flags, u16 0, u32 length, u64 ptsUs, payload
 * (1 = H.264 config, 2 = H.264 access unit, 4 = PCM S16LE 48 kHz stereo,
 * 5 = keepalive). The receiver may send {type:"stop"}.
 */
final class CastConnection {
    static final String PROTOCOL = "pllana-cast/1";
    static final int TYPE_CONFIG = 1, TYPE_VIDEO = 2, TYPE_AUDIO = 4, TYPE_KEEPALIVE = 5;
    /** Above this backlog, non-key video frames are dropped to keep latency low. */
    private static final long MAX_BACKLOG = 768 * 1024;

    interface Listener {
        void onStopRequested();
        void onClosed(String reason);
        void onKeyFrameNeeded();
    }

    static final class RejectedException extends IOException {
        final String code;
        RejectedException(String code) { super(code); this.code = code; }
    }

    private static final class Frame {
        final byte[] data; final boolean droppable;
        Frame(byte[] data, boolean droppable) { this.data = data; this.droppable = droppable; }
    }

    private final Socket socket = new Socket();
    private final LinkedBlockingDeque<Frame> queue = new LinkedBlockingDeque<>();
    private final AtomicLong backlog = new AtomicLong();
    private volatile boolean open;
    private volatile boolean dropping;
    /** Diagnosis counters. */
    final AtomicLong bytesSent = new AtomicLong(), framesSent = new AtomicLong(), framesDropped = new AtomicLong();
    volatile long carShown = -1; volatile int carWidth, carHeight;
    private Listener listener;
    private String receiverName = "";

    String receiverName() { return receiverName; }

    void connect(String host, int port, String code, String device, boolean audio, int width, int height, Listener listener) throws IOException {
        this.listener = listener;
        socket.connect(new InetSocketAddress(host, port), 5000);
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(15000);
        InputStream in = socket.getInputStream();
        JSONObject hello = readLine(in);
        if (hello.has("ok") && !hello.optBoolean("ok")) throw new RejectedException(hello.optString("error", "refused"));
        if (!PROTOCOL.equals(hello.optString("proto"))) throw new RejectedException("protocol");
        receiverName = hello.optString("name", "");
        String nonce = hello.optString("nonce");
        try {
            JSONObject answer = new JSONObject();
            answer.put("proto", PROTOCOL);
            answer.put("device", device);
            answer.put("auth", hmac(code, nonce));
            answer.put("audio", audio);
            answer.put("width", width);
            answer.put("height", height);
            OutputStream out = socket.getOutputStream();
            out.write((answer.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (org.json.JSONException e) { throw new IOException(e); }
        JSONObject reply = readLine(in);
        if (!reply.optBoolean("ok")) throw new RejectedException(reply.optString("error", "refused"));
        socket.setSoTimeout(0);
        open = true;
        Thread writer = new Thread(this::writeLoop, "pllana-cast-writer");
        writer.setPriority(Thread.MAX_PRIORITY);
        writer.start();
        new Thread(this::readLoop, "pllana-cast-reader").start();
        new Thread(this::keepAlive, "pllana-cast-keepalive").start();
    }

    static String hmac(String code, String nonce) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(code.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(nonce.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format("%02x", b & 0xff));
            return hex.toString();
        } catch (Exception e) { throw new IOException(e); }
    }

    private static JSONObject readLine(InputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) throw new IOException("closed");
            if (c == '\n') break;
            if (line.length() > 4096) throw new IOException("line too long");
            line.append((char) c);
        }
        try { return new JSONObject(line.toString()); } catch (org.json.JSONException e) { throw new IOException("protocol"); }
    }

    void send(int type, boolean key, long ptsUs, byte[] payload, int offset, int length) {
        if (!open) return;
        boolean droppable = type == TYPE_VIDEO && !key;
        if (type == TYPE_VIDEO) {
            if (dropping && !key) { framesDropped.incrementAndGet(); return; }
            if (droppable && backlog.get() > MAX_BACKLOG) {
                framesDropped.incrementAndGet();
                // Skip until the next key frame, which the encoder sends now.
                dropping = true;
                if (listener != null) listener.onKeyFrameNeeded();
                return;
            }
            if (key) dropping = false;
        }
        if (type == TYPE_AUDIO && backlog.get() > MAX_BACKLOG * 2) return;
        byte[] frame = new byte[16 + length];
        frame[0] = (byte) type;
        frame[1] = (byte) (key ? 1 : 0);
        frame[4] = (byte) (length >>> 24); frame[5] = (byte) (length >>> 16); frame[6] = (byte) (length >>> 8); frame[7] = (byte) length;
        for (int i = 0; i < 8; i++) frame[8 + i] = (byte) (ptsUs >>> (56 - 8 * i));
        System.arraycopy(payload, offset, frame, 16, length);
        backlog.addAndGet(frame.length);
        if (type == TYPE_VIDEO) framesSent.incrementAndGet();
        queue.offer(new Frame(frame, droppable));
    }

    private void writeLoop() {
        try (OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024)) {
            while (open) {
                Frame frame = queue.poll(500, TimeUnit.MILLISECONDS);
                if (frame == null) continue;
                out.write(frame.data);
                backlog.addAndGet(-frame.data.length);
                bytesSent.addAndGet(frame.data.length);
                if (queue.isEmpty()) out.flush();
            }
        } catch (Exception e) {
            if (open) CastLog.error("Senden abgebrochen", e);
            close("network");
        }
    }

    private void readLoop() {
        try {
            InputStream in = socket.getInputStream();
            while (open) {
                JSONObject message = readLine(in);
                if ("status".equals(message.optString("type"))) {
                    carShown = message.optLong("shown", -1);
                    carWidth = message.optInt("width"); carHeight = message.optInt("height");
                    continue;
                }
                if ("stop".equals(message.optString("type"))) {
                    if (listener != null) listener.onStopRequested();
                    close("stopped_by_car");
                    return;
                }
            }
        } catch (IOException e) {
            if (open) CastLog.error("Verbindung vom Auto getrennt", e);
            close("disconnected");
        }
    }

    private void keepAlive() {
        byte[] empty = new byte[0];
        while (open) {
            send(TYPE_KEEPALIVE, false, 0, empty, 0, 0);
            try { Thread.sleep(2000); } catch (InterruptedException e) { return; }
        }
    }

    void close(String reason) {
        boolean was = open;
        open = false;
        try { socket.close(); } catch (IOException ignored) { }
        queue.clear();
        if (was && listener != null) listener.onClosed(reason);
    }
}
