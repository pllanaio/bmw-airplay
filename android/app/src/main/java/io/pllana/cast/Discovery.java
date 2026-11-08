package io.pllana.cast;

import android.content.Context;
import android.net.wifi.WifiManager;

import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Finds BMW AirPlay receivers with SSDP (the same discovery the car's DLNA
 * renderer answers). Searches on every IPv4 interface, so it works both when
 * the phone is in the BMW WLAN and when the head unit uses the phone's
 * hotspot.
 */
final class Discovery {
    static final String TARGET = "urn:pllana-io:device:CastReceiver:1";

    static final class Receiver {
        final String name, host; final int port;
        Receiver(String name, String host, int port) { this.name = name; this.host = host; this.port = port; }
        @Override public String toString() { return name + " (" + host + ")"; }
    }

    static List<Receiver> search(Context context, int millis) {
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi == null ? null : wifi.createMulticastLock("pllana-cast-discovery");
        Map<String, Receiver> found = new LinkedHashMap<>();
        List<MulticastSocket> sockets = new ArrayList<>();
        try {
            if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
            byte[] search = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: " + TARGET + "\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII);
            InetAddress group = InetAddress.getByName("239.255.255.250");
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback() || !nif.supportsMulticast()) continue;
                boolean ipv4 = false;
                for (InetAddress a : Collections.list(nif.getInetAddresses())) if (a instanceof Inet4Address) ipv4 = true;
                if (!ipv4) continue;
                try {
                    MulticastSocket socket = new MulticastSocket(new InetSocketAddress(0));
                    socket.setNetworkInterface(nif);
                    socket.setTimeToLive(2);
                    socket.setSoTimeout(200);
                    socket.send(new DatagramPacket(search, search.length, group, 1900));
                    sockets.add(socket);
                } catch (Exception ignored) { /* interface not usable */ }
            }
            long end = System.currentTimeMillis() + millis, resend = System.currentTimeMillis() + 800;
            byte[] buffer = new byte[2048];
            while (System.currentTimeMillis() < end && !sockets.isEmpty()) {
                for (MulticastSocket socket : sockets) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    try { socket.receive(packet); } catch (SocketTimeoutException e) { continue; }
                    Receiver receiver = parse(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8), packet.getAddress().getHostAddress());
                    if (receiver != null) found.put(receiver.host + ":" + receiver.port, receiver);
                }
                if (System.currentTimeMillis() > resend) {
                    resend = Long.MAX_VALUE;
                    for (MulticastSocket socket : sockets) try { socket.send(new DatagramPacket(search, search.length, group, 1900)); } catch (Exception ignored) { }
                }
            }
        } catch (Exception ignored) {
        } finally {
            for (MulticastSocket socket : sockets) socket.close();
            if (lock != null && lock.isHeld()) lock.release();
        }
        return new ArrayList<>(found.values());
    }

    static Receiver parse(String response, String from) {
        if (!response.startsWith("HTTP/1.1 200")) return null;
        String st = null, port = null, name = null;
        for (String line : response.split("\r?\n")) {
            int at = line.indexOf(':');
            if (at <= 0) continue;
            String key = line.substring(0, at).trim().toUpperCase(Locale.ROOT), value = line.substring(at + 1).trim();
            if (key.equals("ST")) st = value;
            else if (key.equals("X-PLLANA-CAST")) port = value;
            else if (key.equals("X-PLLANA-NAME")) name = value;
        }
        if (!TARGET.equals(st) || port == null) return null;
        try {
            int p = Integer.parseInt(port);
            if (p < 1 || p > 65535) return null;
            return new Receiver(name == null || name.isEmpty() ? "BMW" : name, from, p);
        } catch (NumberFormatException e) { return null; }
    }
}
