package io.pllana.cast;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** Find the BMW, enter the code from the iDrive display, start/stop casting. */
public final class MainActivity extends Activity implements CastService.StatusListener, CastLog.Listener {
    private static final int REQUEST_CAPTURE = 1, REQUEST_PERMISSIONS = 2;

    private SharedPreferences prefs;
    private LinearLayout receivers;
    private TextView status;
    private EditText host, code;
    private CheckBox sound;
    private Button start, search;
    private String selectedHost;
    private TextView log;
    private int selectedPort = 7104;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("cast", MODE_PRIVATE);
        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);

        TextView title = text("PllanaCast for BMW", 28);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);
        root.addView(text("Bildschirm und Ton deines Android-Handys auf dem BMW-Display.", 15));

        root.addView(heading("1. Im Auto"));
        root.addView(text("In der App „PllanaCast for BMW“ auf „Verbinden“ drücken. Das Handy ist im BMW-WLAN, oder die HeadUnit nutzt den Hotspot dieses Handys.", 15));

        root.addView(heading("2. BMW wählen"));
        search = new Button(this);
        search.setText("BMW suchen");
        search.setOnClickListener(v -> discover());
        root.addView(search);
        receivers = new LinearLayout(this);
        receivers.setOrientation(LinearLayout.VERTICAL);
        root.addView(receivers);
        host = new EditText(this);
        host.setHint("oder Adresse eingeben, z. B. 192.168.43.123");
        host.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        host.setSingleLine(true);
        host.setText(prefs.getString("host", ""));
        root.addView(host);

        root.addView(heading("3. Code vom iDrive-Display"));
        code = new EditText(this);
        code.setHint("6-stelliger Code");
        code.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        code.setFilters(new InputFilter[] { new InputFilter.LengthFilter(8) });
        code.setTextSize(24);
        code.setGravity(Gravity.CENTER);
        root.addView(code);
        sound = new CheckBox(this);
        sound.setText("Ton übertragen");
        sound.setChecked(prefs.getBoolean("sound", true));
        root.addView(sound);

        start = new Button(this);
        start.setText("Übertragung starten");
        start.setTextSize(18);
        start.setOnClickListener(v -> toggle());
        LinearLayout.LayoutParams startParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(64));
        startParams.topMargin = dp(16);
        root.addView(start, startParams);
        status = text("", 15);
        status.setPadding(0, dp(12), 0, 0);
        root.addView(status);
        root.addView(heading("Diagnose"));
        Button copy = new Button(this);
        copy.setText("Diagnose kopieren");
        copy.setAllCaps(false);
        copy.setOnClickListener(v -> {
            android.content.ClipboardManager clipboard = getSystemService(android.content.ClipboardManager.class);
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("PllanaCast for BMW Diagnose", CastLog.text() + "\n" + status.getText()));
            status.setText(status.getText() + "\n(Diagnose kopiert)");
        });
        root.addView(copy);
        log = text("", 11);
        log.setTypeface(Typeface.MONOSPACE);
        log.setTextIsSelectable(true);
        root.addView(log);
        root.addView(text("\nHinweis: Inhalte mit Kopierschutz (z. B. manche Streamingdienste) zeigt Android bei der Bildschirmaufnahme schwarz oder stumm.", 13));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        // Edge-to-edge (Android 15): keep content clear of the system bars.
        scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        setContentView(scroll);
        // Test hook (also handy via adb): prefilled address/code, optional autostart.
        Intent launch = getIntent();
        if (state == null && launch != null && launch.hasExtra("host")) {
            host.setText(launch.getStringExtra("host"));
            if (launch.hasExtra("code")) code.setText(launch.getStringExtra("code"));
            if (launch.hasExtra("sound")) sound.setChecked(launch.getBooleanExtra("sound", true));
            if (launch.getBooleanExtra("autostart", false)) { search.post(this::toggle); return; }
        }
        discover();
    }

    @Override protected void onResume() { super.onResume(); CastService.addListener(this); CastLog.addListener(this); }
    @Override protected void onPause() { CastService.removeListener(this); CastLog.removeListener(this); super.onPause(); }
    @Override public void onLog(String text) { log.setText(text); }

    @Override
    public void onStatus(String text, boolean active) {
        status.setText(text);
        start.setText(active ? "Übertragung beenden" : "Übertragung starten");
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size) { TextView t = new TextView(this); t.setText(value); t.setTextSize(size); return t; }
    private TextView heading(String value) {
        TextView t = text(value, 18);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(18), 0, dp(4));
        return t;
    }

    private void discover() {
        search.setEnabled(false);
        search.setText("Suche …");
        new Thread(() -> {
            List<Discovery.Receiver> found = Discovery.search(this, 2500);
            runOnUiThread(() -> {
                search.setEnabled(true);
                search.setText("Erneut suchen");
                receivers.removeAllViews();
                if (found.isEmpty()) receivers.addView(text("Kein BMW gefunden. Im Auto „Verbinden“ drücken oder Adresse eingeben.", 14));
                for (Discovery.Receiver r : found) {
                    Button b = new Button(this);
                    b.setText(r.toString());
                    b.setAllCaps(false);
                    b.setOnClickListener(v -> select(r));
                    receivers.addView(b);
                }
                if (found.size() == 1) select(found.get(0));
            });
        }, "pllana-cast-search").start();
    }

    private void select(Discovery.Receiver r) {
        selectedHost = r.host; selectedPort = r.port;
        host.setText(r.host);
        status.setText("Gewählt: " + r.name);
    }

    private void toggle() {
        if (CastService.isActive()) {
            startService(new Intent(this, CastService.class).setAction(CastService.ACTION_STOP));
            return;
        }
        String address = host.getText().toString().trim();
        if (address.isEmpty()) { status.setText("Bitte zuerst einen BMW wählen oder die Adresse eingeben."); return; }
        if (!address.matches("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$")) { status.setText("Die Adresse sieht nicht wie eine IPv4-Adresse aus."); return; }
        if (!code.getText().toString().matches("^[0-9]{4,8}$")) { status.setText("Bitte den Code vom iDrive-Display eingeben."); return; }
        if (!address.equals(selectedHost)) selectedPort = 7104;
        prefs.edit().putString("host", address).putBoolean("sound", sound.isChecked()).apply();
        List<String> needed = new ArrayList<>();
        if (sound.isChecked() && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!needed.isEmpty()) { requestPermissions(needed.toArray(new String[0]), REQUEST_PERMISSIONS); return; }
        askForCapture();
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request != REQUEST_PERMISSIONS) return;
        for (int i = 0; i < permissions.length; i++)
            if (Manifest.permission.RECORD_AUDIO.equals(permissions[i]) && results[i] != PackageManager.PERMISSION_GRANTED) sound.setChecked(false);
        askForCapture();
    }

    private void askForCapture() {
        MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != REQUEST_CAPTURE) return;
        if (result != RESULT_OK || data == null) { CastLog.add("Bildschirmaufnahme abgelehnt"); status.setText("Bildschirmaufnahme wurde nicht erlaubt."); return; }
        Intent service = new Intent(this, CastService.class)
                .putExtra(CastService.EXTRA_RESULT_CODE, result)
                .putExtra(CastService.EXTRA_RESULT_DATA, data)
                .putExtra(CastService.EXTRA_HOST, host.getText().toString().trim())
                .putExtra(CastService.EXTRA_PORT, selectedPort)
                .putExtra(CastService.EXTRA_CODE, code.getText().toString())
                .putExtra(CastService.EXTRA_AUDIO, sound.isChecked() && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        startForegroundService(service);
    }
}
