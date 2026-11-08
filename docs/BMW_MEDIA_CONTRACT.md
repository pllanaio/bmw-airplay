# BMW media integration contract

The current app plays through the existing `OAPGenericMedia` AudioManager source.
That speaker connection does not register AirPlay as a BMW media provider and
does not publish its track into the instrument cluster.

The available sources verify these consumer interfaces:

| Interface / instance | Verified operation |
| --- | --- |
| `de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer` / `CarPlayMedia` | Read `currentItemMetadata`, `currentItemTime`, `playerState` |
| Same interface / `OapGenericMedia` | Existing BMW player accepts `playFile`, `sendButtonEvent`, `setTime` |
| `de.bmw.infotainment.hmi.hmimediastate.HmiMediaState` | Public applications inspect its fields; no writer contract is provided |
| `de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer` | Public applications inspect its fields; no provider registration contract is provided |

`sendButtonEvent` sends a command **to BMW's existing player**. It does not
subscribe an external AirPlay player to steering-wheel commands. Reading the
CarPlay title likewise does not authorize replacing its metadata. No service
name, method number, enum value or cluster publication method is guessed.

`bmw_media.js` can collect a bounded static schema report from the installed
master catalog and generated MainApp definitions, saving it only in the app's
private data directory. It reads no current song/phone values, calls no SOME/IP
methods and offers no vehicle services. It requires no new SOME/IP permissions.
The report retains exact method arguments, fields, referenced data types and
named enum values for review. It explicitly leaves media-provider, steering
and native cluster integration unverified; a suggestive setter or method name
does not enable them.

`inspectBmwContracts()` shares a single catalog read with the CarPlay-focus
inspector and includes that inspector's bounded unsupported-capability report.
Descriptions, examples, defaults, cached values and deployment addresses are
excluded; typed RPC arguments and named enum constants are retained.

The optional `inspect_bmw_contracts.js` runner saves the combined report into an existing
private output directory and prints only a short unsupported-capability
summary. `loadBmwCatalog()` is shared by the read-only CarPlay-focus inspector;
the raw static graph stays internal. The capture is a diagnostic artifact,
not a provider implementation or a feature-support claim.

The missing verified contract must establish source registration/withdrawal,
source selection and AudioManager ownership, incoming transport commands,
metadata/artwork publication and the cluster's selected-source behavior.
Commands must be routed only to the current authenticated AirPlay epoch when
AirPlay owns the media route. CarPlay's own source and metadata must remain
untouched when CarPlay is selected. A real sender's DACP `nextitem`/`previtem`
is the supported AirPlay transport; no unsupported reverse-channel command or
synthetic end-of-track is substituted.

Sources used (no proprietary SDK/catalog is included in this repository):

- [Car Lyrics README](https://github.com/arefahmad/idrive7-apps/blob/9828f6579bbf5c7b78aa4c3133c13a41c2f1a293/apps/aref_carlyrics/README.md) and [read-only NowPlaying implementation](https://github.com/arefahmad/idrive7-apps/blob/9828f6579bbf5c7b78aa4c3133c13a41c2f1a293/apps/aref_carlyrics/car/nowplaying.js).
- [Media Client's OAP player consumer](https://github.com/leschi/mgu-media-client/blob/4cfaa8dfa7193c39e268d2a45fd4357bf796fc00/apps/media/oapmedia.js).
- [Public SDK catalog reader](https://github.com/cauliflowermossgrape/idrive7-apps/blob/180537a0bdf39163046a6855e7928eb35bb47c7b/kit/tools/sigdoc.py): `interfaces`, `datatypes`, `instanceIDs`, fields' `dataRef/getter/notifier`, and struct/enum/array/typedef shapes.
- [Existing-player controls](https://github.com/nickgcode/idrive7-apps/blob/3f54a5a4fe4a6625b4e23db02790f27836c15b3b/apps/ng_spotify/car/car_player.js), which explicitly distinguishes schema-named controls from its guesses. This app does not adopt those guesses.

Tests use artificial schema fixtures to check capture boundaries and refusal to
claim capabilities. They do not qualify steering-wheel or cluster behavior on
a BMW.


For CarPlay coexistence, a second verified contract must describe display and
media focus acquisition/release, ownership tokens, the selected source and
higher-priority events such as calls or OEM surfaces. The generic OAP app
visibility callback does not identify why an app lost focus. Automatically
reopening the app after every hidden event would also override a deliberate
user switch. Neither the renderer's surface gate nor a `sendButtonEvent`
consumer call establishes the required ownership contract.

Wireless CarPlay can also compete with MGU-Uplink for WLAN hardware. Display
focus arbitration cannot resolve an unavailable radio/interface. Wired versus
wireless CarPlay must therefore be recorded with any on-vehicle result.
