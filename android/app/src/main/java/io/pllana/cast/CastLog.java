package io.pllana.cast;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

/** Short diagnosis log shown in the app (and copyable) so a failed cast can be explained. */
final class CastLog {
    interface Listener { void onLog(String text); }

    private static final ArrayDeque<String> lines = new ArrayDeque<>();
    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());

    static void add(String line) {
        Log.i("pllanaCast", line);
        String stamped = new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date()) + " " + line;
        String text;
        synchronized (lines) {
            lines.addLast(stamped);
            while (lines.size() > 80) lines.removeFirst();
            text = String.join("\n", lines);
        }
        main.post(() -> { for (Listener l : listeners) l.onLog(text); });
    }

    static void error(String what, Throwable t) {
        add(what + ": " + t.getClass().getSimpleName() + (t.getMessage() == null ? "" : " – " + t.getMessage()));
    }

    static String text() { synchronized (lines) { return String.join("\n", lines); } }
    static void addListener(Listener l) { listeners.add(l); l.onLog(text()); }
    static void removeListener(Listener l) { listeners.remove(l); }
}
