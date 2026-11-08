"""Report real sender sessions, independently of probes and local HLS GETs.

Verified/password-authenticated RTSP transports and accepted legacy media
requests own a session. An established reverse channel may retain that same
peer/session between videos; opening an arbitrary TCP connection cannot.
Only booleans are exposed to the UI. Applied after the music-control patch.
GPL-3.0-or-later.
"""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected connection-status source: ' + old[:80])
    return text.replace(old, new)


HELPERS = '''
static pthread_mutex_t mgu_session_publish_mutex = PTHREAD_MUTEX_INITIALIZER;
static bool mgu_session_uuid(const char *value) {
    if (!value || strlen(value) != 36) return false;
    for (int i = 0; i < 36; i++) {
        char c = value[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
}
static bool mgu_session_peer(raop_conn_t *a, raop_conn_t *b) {
    return a->remote && b->remote && (a->remotelen == 4 || a->remotelen == 16) &&
        a->remotelen == b->remotelen && a->zone_id == b->zone_id && !memcmp(a->remote, b->remote, a->remotelen);
}
static bool mgu_session_owns(raop_conn_t *conn) {
    return conn->mgu_session_transports || conn->mgu_session_media ||
        (conn->mgu_session_reverse && conn->mgu_session_attached);
}
static void mgu_session_refresh(raop_t *raop) {
    /* Registry operations run on HTTPD's single connection/control thread.
     * The public snapshot is atomic because GLib also announces it on rebuild. */
    raop_conn_t *head = raop->mgu_session_connections;
    for (raop_conn_t *target = head; target; target = target->mgu_session_next) {
        if (!target->mgu_session_reverse || target->mgu_session_attached) continue;
        for (raop_conn_t *owner = head; owner; owner = owner->mgu_session_next) {
            if (owner == target || !mgu_session_peer(owner, target)) continue;
            bool same_session = owner->mgu_session_id[0] && target->mgu_session_id[0] &&
                !strcmp(owner->mgu_session_id, target->mgu_session_id);
            if (same_session && mgu_session_owns(owner)) {
                target->mgu_session_attached = true; break;
            }
        }
    }
    int connected = 0;
    for (raop_conn_t *conn = head; conn; conn = conn->mgu_session_next)
        if (mgu_session_owns(conn)) { connected = 1; break; }
    pthread_mutex_lock(&mgu_session_publish_mutex);
    int previous = __atomic_exchange_n(&raop->mgu_session_connected, connected, __ATOMIC_ACQ_REL);
    if (previous != connected && raop->callbacks.session_status)
        raop->callbacks.session_status(raop->callbacks.cls, connected != 0);
    pthread_mutex_unlock(&mgu_session_publish_mutex);
}
static void mgu_session_register(raop_conn_t *conn) {
    conn->mgu_session_next = conn->raop->mgu_session_connections;
    conn->raop->mgu_session_connections = conn;
}
static void mgu_session_forget(raop_conn_t *conn) {
    raop_conn_t **at = &conn->raop->mgu_session_connections;
    while (*at && *at != conn) at = &(*at)->mgu_session_next;
    if (*at) *at = conn->mgu_session_next;
    conn->mgu_session_next = NULL;
    mgu_session_refresh(conn->raop);
}
static void mgu_session_transport(raop_conn_t *conn, unsigned int kind) {
    /* Pairing probes and unauthenticated SETUPs never hide the pairing code. */
    if (!conn->mgu_pair_verified && !conn->authenticated) return;
    conn->mgu_session_transports |= kind;
    mgu_session_refresh(conn->raop);
}
static void mgu_session_reverse(raop_conn_t *conn) {
    if (!mgu_session_uuid(conn->client_session_id)) { mgu_session_refresh(conn->raop); return; }
    conn->mgu_session_reverse = true;
    memcpy(conn->mgu_session_id, conn->client_session_id, sizeof conn->mgu_session_id);
    mgu_session_refresh(conn->raop);
}
static void mgu_session_media(raop_conn_t *conn) {
    /* Legacy /play has no pair-verify exchange. Count its accepted media,
     * rather than a /server-info probe or the player's local playlist GET. */
    int id = conn->raop->current_video;
    if (id < 0 || id >= MAX_AIRPLAY_VIDEO || !conn->raop->airplay_video[id]) return;
    const char *session = get_apple_session_id(conn->raop->airplay_video[id]);
    conn->mgu_session_media = true;
    if (mgu_session_uuid(session)) memcpy(conn->mgu_session_id, session, sizeof conn->mgu_session_id);
    mgu_session_refresh(conn->raop);
}
static void mgu_session_teardown(raop_conn_t *conn, bool audio, bool mirror) {
    if (audio) conn->mgu_session_transports &= ~1U;
    if (mirror) conn->mgu_session_transports &= ~2U;
    if (!audio && !mirror) {
        conn->mgu_session_transports = 0;
        conn->mgu_session_media = conn->mgu_session_reverse = conn->mgu_session_attached = false;
    }
    mgu_session_refresh(conn->raop);
}
'''


def patch(source, ux):
    path = source / 'lib/raop.h'
    text = path.read_text()
    anchor = '    void  (*conn_destroy)(void *cls);'
    text = once(text, anchor, anchor + '\n    void (*session_status)(void *cls, bool connected);')
    anchor = 'RAOP_API int raop_is_running(raop_t *raop);'
    text = once(text, anchor, 'RAOP_API bool raop_session_is_connected(raop_t *raop);\nRAOP_API void raop_session_announce(raop_t *raop);\n' + anchor)
    path.write_text(text)

    path = source / 'lib/raop.c'
    text = path.read_text()
    text = once(text, 'struct raop_s {', '''struct raop_conn_s;
struct raop_s {
    struct raop_conn_s *mgu_session_connections;
    int mgu_session_connected;''')
    text = once(text, 'struct raop_conn_s {', '''struct raop_conn_s {
    struct raop_conn_s *mgu_session_next;
    unsigned int mgu_session_transports;
    bool mgu_session_media, mgu_session_reverse, mgu_session_attached;
    char mgu_session_id[37];''')
    anchor = 'typedef struct raop_conn_s raop_conn_t;'
    text = once(text, anchor, anchor + '\n' + HELPERS)
    text = once(text, '    return conn;', '    mgu_session_register(conn);\n    return conn;')
    anchor = '    logger_log(raop->logger, LOGGER_DEBUG, "Destroying connection");'
    text = once(text, anchor, anchor + '\n    mgu_session_forget(conn);')
    anchor = 'int\nraop_is_running(raop_t *raop) {'
    text = once(text, anchor, '''bool raop_session_is_connected(raop_t *raop) {
    return raop && __atomic_load_n(&raop->mgu_session_connected, __ATOMIC_ACQUIRE) != 0;
}
void raop_session_announce(raop_t *raop) {
    /* Serialize the snapshot with transitions: it must never print a stale
     * connected after HTTPD has already announced disconnected. */
    pthread_mutex_lock(&mgu_session_publish_mutex);
    if (raop && raop->callbacks.session_status)
        raop->callbacks.session_status(raop->callbacks.cls, raop_session_is_connected(raop));
    pthread_mutex_unlock(&mgu_session_publish_mutex);
}

''' + anchor)
    path.write_text(text)

    path = source / 'lib/raop_handlers.h'
    text = path.read_text()
    anchor = '                    raop_rtp_mirror_start(conn->raop_rtp_mirror, &dport, raop->clientFPSdata);'
    text = once(text, anchor, anchor + '\n                    if (raop_rtp_mirror_is_running(conn->raop_rtp_mirror)) mgu_session_transport(conn, 2U);')
    anchor = '                    raop_rtp_start_audio(conn->raop_rtp, &remote_cport, &cport, &dport, &ct, &sr);'
    text = once(text, anchor, anchor + '\n                    if (raop_rtp_is_running(conn->raop_rtp)) mgu_session_transport(conn, 1U);')
    anchor = '    http_response_add_header(response, "Connection", "close");'
    text = once(text, anchor, '    mgu_session_teardown(conn, teardown_96, teardown_110);\n' + anchor)
    # A request may contain both streams. Upstream's else-if stopped only
    # audio while leaving mirror RTP alive, contradicting the completed route.
    text = once(text, '    } else if (teardown_110) {', '    }\n    if (teardown_110) {')
    text = once(text, '''    } else {
        /* Destroy our sessions */''', '''    } else if (!teardown_96) {
        /* Destroy our sessions */''')
    path.write_text(text)

    # The build copies helper headers after patching. Instrument its include
    # site instead, keeping the shared source helper untouched.
    path = source / 'lib/raop.c'
    text = path.read_text()
    text = once(text, '    httpd_cbs.conn_reverse_ready = &mgu_reverse_bind;',
                '    httpd_cbs.conn_reverse_ready = &mgu_session_reverse_ready;')
    anchor = '#include "mgu_reverse.h"'
    text = once(text, anchor, anchor + '''
static void mgu_session_reverse_ready(void *ptr) {
    raop_conn_t *conn = ptr;
    raop_conn_t *old = conn->raop->mgu_reverse_owner;
    bool continuation = old && old != conn && old->mgu_session_reverse && old->mgu_session_attached &&
        mgu_session_peer(old, conn) && mgu_session_uuid(conn->client_session_id) &&
        !strcmp(old->mgu_session_id, conn->client_session_id);
    if (old && old != conn) {
        old->mgu_session_reverse = old->mgu_session_attached = false;
    }
    mgu_reverse_bind(ptr);
    if (continuation) conn->mgu_session_attached = true;
    mgu_session_reverse(ptr);
}''')
    path.write_text(text)

    # The playlist wrapper commits accepted UUID and legacy/direct media in
    # mgu_playlist.h, which the builder copies later. Wrap its original handler
    # return sites via the outer dispatch after the request fully succeeds.
    path = source / 'lib/raop.c'
    text = path.read_text()
    anchor = '    finish:;'
    text = once(text, anchor, '''    if (*response && http_response_get_status(*response) == 200 && !strcmp(method, "POST")) {
        bool media_request = !strcmp(url, "/play");
        if (!strcmp(url, "/action")) {
            plist_t root = mgu_request_plist(request);
            char *type = root ? mgu_item_string(root, "type") : NULL;
            media_request = type && (!strcmp(type, "playlistInsert") || !strcmp(type, "unhandledURLResponse"));
            plist_mem_free(type); if (root) plist_free(root);
        }
        if (media_request) mgu_session_media(conn);
    }

''' + anchor)
    path.write_text(text)

    path = source / 'lib/raop_rtp_mirror.h'
    original = source.parents[1].parent / '.local/airplay/UxPlay/lib/raop_rtp_mirror.h'
    text = original.read_text()
    anchor = 'void raop_rtp_mirror_stop(raop_rtp_mirror_t *raop_rtp_mirror);'
    text = once(text, anchor, 'int raop_rtp_mirror_is_running(raop_rtp_mirror_t *raop_rtp_mirror);\n' + anchor)
    path.write_text(text)
    path = source / 'lib/raop_rtp_mirror.c'
    text = path.read_text()
    anchor = 'void raop_rtp_mirror_stop(raop_rtp_mirror_t *raop_rtp_mirror) {'
    text = once(text, anchor, '''int raop_rtp_mirror_is_running(raop_rtp_mirror_t *raop_rtp_mirror) {
    MUTEX_LOCK(raop_rtp_mirror->run_mutex);
    int running = raop_rtp_mirror->running;
    MUTEX_UNLOCK(raop_rtp_mirror->run_mutex);
    return running;
}

''' + anchor)
    path.write_text(text)

    anchor = '    raop_cbs.conn_destroy = conn_destroy;'
    ux = once(ux, anchor, anchor + '\n    raop_cbs.session_status = mgu_session_status;')
    anchor = 'extern "C" void conn_init (void *cls) {'
    ux = once(ux, anchor, '''extern "C" void mgu_session_status(void *cls, bool connected) {
    (void) cls;
    printf("MGU_SESSION %s\\n", connected ? "connected" : "disconnected"); fflush(stdout);
}

''' + anchor)
    anchor = 'MGU_FEATURES full-disconnect\\n'
    ux = once(ux, anchor, anchor + 'MGU_FEATURES session-status\\n')
    anchor = '    g_main_loop_run(loop);'
    ux = once(ux, anchor, '    raop_session_announce(raop);\n' + anchor)
    return ux
