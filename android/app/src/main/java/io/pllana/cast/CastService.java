package io.pllana.cast;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;

import java.util.concurrent.CopyOnWriteArrayList;

/** Foreground service holding the screen capture and the connection. */
public final class CastService extends Service {
    static final String EXTRA_RESULT_CODE = "resultCode", EXTRA_RESULT_DATA = "resultData", EXTRA_HOST = "host",
            EXTRA_PORT = "port", EXTRA_CODE = "code", EXTRA_AUDIO = "audio";
    static final String ACTION_STOP = "io.pllana.cast.STOP";
    private static final String CHANNEL = "cast", TAG = "pllanaCast";

    /** Status for the activity (same process). */
    interface StatusListener { void onStatus(String status, boolean active); }
    private static final CopyOnWriteArrayList<StatusListener> listeners = new CopyOnWriteArrayList<>();
    private static volatile String status = "";
    private static volatile boolean active;
    static void addListener(StatusListener l) { listeners.add(l); l.onStatus(status, active); }
    static void removeListener(StatusListener l) { listeners.remove(l); }
    static boolean isActive() { return active; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private CastConnection connection;
    private ScreenEncoder encoder;
    private AudioCapture audio;
    private DisplayManager.DisplayListener rotation;
    private volatile boolean stopping;

    private void publish(String text, boolean on) {
        status = text; active = on;
        main.post(() -> { for (StatusListener l : listeners) l.onStatus(text, on); });
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) { shutdown("Beendet"); return START_NOT_STICKY; }
        CastLog.add("Start: Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + "), " + Build.MANUFACTURER + " " + Build.MODEL);
        if (projection != null) return START_NOT_STICKY;
        // Android 14+: the foreground service must run before the projection starts.
        Notification notification = notification("Verbinde mit dem BMW …");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(1, notification);
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        Intent data = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class) : intent.getParcelableExtra(EXTRA_RESULT_DATA);
        try { projection = manager.getMediaProjection(intent.getIntExtra(EXTRA_RESULT_CODE, 0), data); }
        catch (RuntimeException e) { CastLog.error("MediaProjection", e); projection = null; }
        if (projection == null) { shutdown("Bildschirmaufnahme nicht erlaubt"); return START_NOT_STICKY; }
        CastLog.add("Bildschirmaufnahme erlaubt");
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { CastLog.add("Android hat die Aufnahme beendet"); main.post(() -> shutdown("Aufnahme beendet")); }
            @Override public void onCapturedContentVisibilityChanged(boolean visible) { CastLog.add("Geteilter Inhalt " + (visible ? "sichtbar" : "verdeckt")); }
            @Override public void onCapturedContentResize(int width, int height) {
                // Single-app sharing (Android 14+): follow the app window size.
                ScreenEncoder e = encoder;
                if (e != null && width > 0 && height > 0) new Thread(() -> e.resize(width, height)).start();
            }
        }, main);
        final String host = intent.getStringExtra(EXTRA_HOST), code = intent.getStringExtra(EXTRA_CODE);
        final int port = intent.getIntExtra(EXTRA_PORT, 7104);
        final boolean withAudio = intent.getBooleanExtra(EXTRA_AUDIO, true);
        publish("Verbinde mit dem BMW …", true);
        new Thread(() -> {
            try { run(host, port, code, withAudio); }
            catch (Throwable t) { CastLog.error("Unerwarteter Fehler", t); main.post(() -> shutdown("Fehler: " + t.getClass().getSimpleName())); }
        }, "pllana-cast-start").start();
        return START_NOT_STICKY;
    }

    private Point screenSize() {
        DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        Display display = dm.getDisplay(Display.DEFAULT_DISPLAY);
        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        return new Point(metrics.widthPixels, metrics.heightPixels);
    }

    private void run(String host, int port, String code, boolean withAudio) {
        Point size = screenSize();
        int[] target = ScreenEncoder.target(size.x, size.y);
        CastLog.add("Bildschirm " + size.x + "×" + size.y + " → " + target[0] + "×" + target[1] + ", verbinde " + host + ":" + port);
        connection = new CastConnection();
        try {
            connection.connect(this, host, port, code, Build.MANUFACTURER + " " + Build.MODEL, withAudio, target[0], target[1], new CastConnection.Listener() {
                @Override public void onStopRequested() { main.post(() -> shutdown("Im Auto beendet")); }
                @Override public void onClosed(String reason) { main.post(() -> shutdown("stopped_by_car".equals(reason) ? "Im Auto beendet" : "Verbindung getrennt")); }
                @Override public void onKeyFrameNeeded() { ScreenEncoder e = encoder; if (e != null) e.requestKeyFrame(); }
            });
        } catch (CastConnection.RejectedException e) {
            CastLog.add("Vom Auto abgelehnt: " + e.code);
            String text = "code_wrong".equals(e.code) ? "Falscher Code – bitte den Code vom iDrive-Display eingeben"
                    : "busy".equals(e.code) ? "Ein anderes Handy überträgt gerade"
                    : "not_ready".equals(e.code) ? "Im Auto zuerst „Verbinden“ drücken"
                    : "too_many_attempts".equals(e.code) ? "Zu viele Versuche – eine Minute warten"
                    : "Abgelehnt: " + e.code;
            main.post(() -> shutdown(text));
            return;
        } catch (Exception e) {
            CastLog.error("Verbindung", e);
            main.post(() -> shutdown("BMW nicht erreichbar (" + e.getClass().getSimpleName() + ")"));
            return;
        }
        CastLog.add("Mit " + connection.receiverName() + " verbunden, Code akzeptiert");
        if (stopping) { connection.close("stopped"); return; }
        try {
            encoder = new ScreenEncoder(projection, connection, getResources().getDisplayMetrics().densityDpi);
            encoder.start(size.x, size.y);
        } catch (Exception e) {
            CastLog.error("Videokodierung", e);
            main.post(() -> shutdown("Videokodierung nicht verfügbar"));
            return;
        }
        boolean sound = withAudio && (audio = new AudioCapture(connection)).start(projection);
        CastLog.add(withAudio ? (sound ? "Ton wird übertragen" : "Ton nicht verfügbar (App verbietet Mitschnitt oder keine Berechtigung)") : "Ton aus");
        startTicker(withAudio && sound);
        main.post(this::watchRotation);
        String name = connection.receiverName().isEmpty() ? "BMW" : connection.receiverName();
        String text = "Überträgt an " + name + (withAudio && !sound ? " (ohne Ton)" : "");
        publish(text, true);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(1, notification(text));
    }

    /** Once per second: what is sent and what the car shows. */
    private void startTicker(boolean sound) {
        final long[] last = { 0, 0, 0, -1 };
        Runnable tick = new Runnable() {
            @Override public void run() {
                CastConnection c = connection; ScreenEncoder e = encoder;
                if (c == null || e == null || stopping) return;
                long sent = c.framesSent.get(), bytes = c.bytesSent.get(), encoded = e.encoded, shown = c.carShown;
                String car = shown < 0 ? "Auto: noch keine Rückmeldung" : shown == 0 ? "Auto: wartet auf Bild"
                        : "Auto zeigt " + Math.max(0, shown - Math.max(0, last[3])) + " B/s (" + c.carWidth + "×" + c.carHeight + ")";
                String text = "Überträgt an " + (c.receiverName().isEmpty() ? "BMW" : c.receiverName()) + "\n" + e.width() + "×" + e.height()
                        + " · kodiert " + (encoded - last[0]) + " B/s · gesendet " + (sent - last[1]) + " B/s · " + ((bytes - last[2]) * 8 / 1000) + " kbit/s"
                        + (c.framesDropped.get() > 0 ? " · verworfen " + c.framesDropped.get() : "") + "\n" + car + (sound ? " · Ton an" : " · ohne Ton");
                if (encoded == 0 && last[0] == 0 && sent == 0) text += "\nAchtung: Android liefert noch kein Bild";
                last[0] = encoded; last[1] = sent; last[2] = bytes; last[3] = shown;
                publish(text, true);
                main.postDelayed(this, 1000);
            }
        };
        main.postDelayed(tick, 1000);
    }

    private void watchRotation() {
        DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        rotation = new DisplayManager.DisplayListener() {
            @Override public void onDisplayAdded(int id) { }
            @Override public void onDisplayRemoved(int id) { }
            @Override public void onDisplayChanged(int id) {
                if (id != Display.DEFAULT_DISPLAY || encoder == null) return;
                Point size = screenSize();
                ScreenEncoder e = encoder;
                new Thread(() -> e.resize(size.x, size.y)).start();
            }
        };
        dm.registerDisplayListener(rotation, main);
    }

    private Notification notification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Übertragung", NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, CastService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_upload)
                .setContentTitle("PllanaCast for BMW")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Beenden", stop).build())
                .build();
    }

    private void shutdown(String reason) {
        if (stopping) return;
        stopping = true;
        CastLog.add("Beendet: " + reason);
        if (rotation != null) { ((DisplayManager) getSystemService(Context.DISPLAY_SERVICE)).unregisterDisplayListener(rotation); rotation = null; }
        final ScreenEncoder e = encoder; final AudioCapture a = audio; final CastConnection c = connection; final MediaProjection p = projection;
        encoder = null; audio = null; connection = null; projection = null;
        new Thread(() -> {
            if (a != null) a.stop();
            if (e != null) e.stop();
            if (c != null) c.close("stopped");
            if (p != null) try { p.stop(); } catch (RuntimeException ignored) { }
        }).start();
        publish(reason, false);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() { shutdown(status.isEmpty() ? "Beendet" : status); super.onDestroy(); }
}
