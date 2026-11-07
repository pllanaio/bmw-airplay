# BMW AirPlay by pllana.io

Native MGU/iDrive7 receiver by **Leon Pllana IT-Solutions · [pllana.io](https://pllana.io)**.

This is the compact implementation note. The detailed, version-specific
project status is in [STATUS.md](STATUS.md); the architecture, test evidence
and Store integration are documented separately.

## Use

1. Open **BMW AirPlay by pllana.io** on the MGU, select **Verbinden**.
2. For screen mirroring, select **BMW AirPlay by pllana.io** in the iPhone Control Centre's
   screen mirroring menu. Enter the six-digit code shown by the MGU.
3. For YouTube HLS, select the AirPlay destination from the YouTube app's
   playback/casting menu. This is a separate playback mode: the receiver fetches
   the video, so other iPhone apps can remain usable during playback. The MGU
   needs Internet access through the configured shared MGU uplink.

Photos, mirrored images and videos use the entire 1920×720 renderer surface.
The original aspect ratio is preserved; black margins are possible. A touch or
controller action reveals the normal controls for eight seconds. **Trennen**
ends reception and releases the app's audio connection. Opening CarPlay or Home
hides the AirPlay picture while preserving the receiver session. The iDrive volume remains
under the user's control.

## Implementation

App 0.2.6 uses native runtime 0.2.4. Automatic CarPlay suppression from
0.2.5 was removed at the user's explicit request. No CarPlay device-control
methods or corresponding proxy permissions remain. Disconnect CarPlay manually
in iDrive before using AirPlay; this is the vehicle-tested working path.

**Vehicle-specific finding:** stopping the stock carplay.service on this MGU
caused CarPlay and mediaddpserver crash entries followed by a head-unit restart.
That diagnostic path is retired. Do not stop the stock CarPlay daemon.

The actual network is iPhone Personal Hotspot → MGU WiFi uplink on wlan0
(addresses are assigned by the hotspot), tested with iOS 27.0.2. The BMW AP
on wlan_bridge is separate. The user has confirmed both mirror → YouTube
video → mirror and direct YouTube playback while the phone app is backgrounded
with 0.2.4, when CarPlay is disconnected. Cross-app handoff and cinematic
sources still require explicit retesting. A later media-download failure
also exposed a remaining native recovery crash, which is not yet resolved.

- UxPlay 1.73.7, pinned source revision, with `-hls 2` enabled. The receiver
  suppresses the `hlsdemux2` factory so playbin2 consistently uses `hlsdemux`.
- HLS uses explicit native I420 output and the same SmartX 8-channel, 48 kHz,
  S16LE audio pipeline as mirroring. HLS frame output is limited to 1280×720;
  the native renderer scales it to the screen without distortion.
- HLS starts with a three-second / four-MiB network buffer and a 2500-kbit/s
  connection hint. A client resume request waits for prebuffering to finish;
  buffering completion respects an explicit user pause.
- Incoming mirror video/audio and mirror pause/reset events cannot take over
  an active HLS renderer. Mirror SETUP cannot delete its playlists, and its
  feedback timeout cannot reset the HLS control channel.
- Each cached HLS video gets separate local playlist URLs. Requests for the old
  video remain associated with it while the next video's metadata is loading.
- Version 0.2.4 synchronizes native audio/video teardown with concurrent RTP
  delivery. Late bus events are ignored after their renderer is removed.
- A busy BMW audio route does not block AirPlay discovery. Audio is retried
  on an explicit start or incoming media; losing audio focus preserves the
  network session.
- Standard unprotected HTTP/HLS/MP4 play requests are accepted alongside the
  YouTube FCUP exchange. Synthetic master URLs with AirPlay subtitle metadata
  use a canonical local playlist path. App-specific compatibility remains
  subject to live testing.
- The app prefers the installed Store renderer at /run/mgu-render/render.sock.
  Its fresh compositor layer lists avoid overwriting layers added by other
  programs. The older SDK renderer remains a fallback. No CarPlay service or
  global compositor configuration is changed.
- Frame file identity and renderer placement are tracked, so recreated HLS
  transports and orientation changes do not retain a stale native file handle.
- Fullscreen is a reversible extension to the app's private SDK copy. Normal
  SDK chrome and controls are restored on input or disconnect.
- The runtime declares Internet access for the receiver UID through MGU Deploy's
  supported `internet`/`uids` metadata. No global routing policy is replaced.
- A private mount namespace supplies uplink DNS only to the backend and its
  children. The global BMW resolver is unchanged. Root is dropped before Node
  or any decoder runs. No decoder capabilities remain.
- HTTPS uses a bundled CA store with certificate validation enabled.
- Dedicated German font atlases provide UTF-8 umlauts and ß. The original SDK
  files remain untouched. Branding and the original logo are in `airplay/branding`.
- The OAP app icon is 140×140 pixels to fit BMW's selection frame. Native image
  message 10 and the native variant of draw opcode 18 render the in-app logo.
- The normal header covers the underlying BMW title up to the status icons.
  The native back column is covered below the header, including its touch area;
  Home and the controller's back action remain available.

## Validation

Local tests cover audio connection ownership/restoration, Node-8 receiver
lifecycle, native file replacement/reconnects, reversible full-screen layout,
German glyphs, I420 strides, repeated portrait/landscape renegotiation, and
synthetic HLS with decoded audio/video over HTTP and HTTPS. The HTTPS test
rejects an untrusted certificate before accepting that same stream when its
certificate is explicitly trusted.

The user confirmed mirror → YouTube video → mirror, direct YouTube AirPlay,
and direct playback while YouTube is backgrounded with native runtime 0.2.4
after manually disconnecting CarPlay. Systematic rotation, full-screen photo,
cross-app and cinematic-source retests remain open. The download-error recovery
crash is unresolved. Local tests alone do not establish compatibility with every
app version. DRM-protected services are outside the supported playback path.
