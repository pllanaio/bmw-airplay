Music controls use DACP from the current, verified RAOP audio connection. A
private, mode 0600 descriptor contains its numeric peer address, DACP-ID and
Active-Remote credential. Those fields never enter the public UI state or
diagnostics. Closing that owning connection invalidates the descriptor; a
stale connection cannot clear a newer owner's controls.

The helper resolves only `iTunes_Ctrl_<DACP-ID>._dacp._tcp.local.` through the
existing BMW mDNS daemon. The returned high TCP port is used at the original
paired peer address. Hostnames, URLs and commands from metadata are ignored.
IPv4 targets must be private/link-local; IPv6 must be ULA or scoped link-local.
Loopback, multicast and
Internet hosts are rejected. Network setup permits only this app UID's TCP
egress to local WLAN destinations on ports 1024–65535.

The fixed routes are `playpause`, `nextitem`, `previtem`, and
`setproperty?dacp.shufflestate=0|1` / `setproperty?dacp.repeatstate=0|1|2` under
`/ctrl-int/1/`, authenticated with the private `Active-Remote` header. Repeat
values mean off, one track and all tracks respectively. Commands are bounded,
serialized and tied to a session epoch. The client follows no redirects.

A valid `playstatusupdate?revision-number=1` response establishes a reachable,
authenticated DACP service before ordinary transport buttons are enabled.
Shuffle and repeat additionally require real `cash`/`carp` values and the
corresponding available-state masks `caas`/`caar`. A change is displayed only
after a fresh sender response confirms it. Rejected or unconfirmed actions
are disabled for that session. Senders that provide audio/artwork without
DACP or without these capabilities retain playback and show unavailable
controls. A particular iPhone application's support requires a device test.

Protocol references used for implementation (the app does not vendor their
source):

- [Shairport Sync DACP client](https://github.com/mikebrady/shairport-sync/blob/master/dacp.c): paired-peer address, service port and Active-Remote request; revision 1 polling; play, shuffle and repeat status values.
- [OwnTone DACP server](https://github.com/owntone/owntone-server/blob/master/src/httpd_dacp.c): exact transport/setproperty routes, repeat values and `caas=2` / `caar=6` advertised masks.
- [OwnTone property table](https://github.com/owntone/owntone-server/blob/master/src/dacp_prop.gperf): shuffle/repeat property names and setters.
- [Pinned UxPlay RAOP handler](https://github.com/FDH2/UxPlay/blob/df67c212a433cf6dda3676dd40c097900d24e645/lib/raop.c): DACP-ID/Active-Remote headers and connection peer ownership.
