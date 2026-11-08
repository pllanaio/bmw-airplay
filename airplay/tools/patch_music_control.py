"""Bind private DACP controls to the verified sender across audio/HLS. GPL-3.0-or-later."""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay music-control source: ' + old[:80])
    return text.replace(old, new)


def patch(source, ux):
    header = source / 'lib/raop.h'
    text = header.read_text()
    anchor = '    void  (*export_dacp) (void *cls, const char *active_remote, const char *dacp_id);'
    text = once(text, anchor, anchor + '''
    void (*music_control)(void *cls, void *owner, const unsigned char *remote,
                          int length, unsigned int zone, const char *id, const char *token);''')
    text = once(text, 'void raop_playlist_hold(raop_t *raop);', '''void raop_playlist_hold(raop_t *raop);
void raop_music_control_release_video(raop_t *raop);''')
    text = once(text, 'void raop_music_control_release_video(raop_t *raop);', '''void raop_music_control_release_video(raop_t *raop);
void raop_music_control_bind_video(raop_t *raop);
void raop_music_control_begin_audio(raop_t *raop);''')
    header.write_text(text)
    path = source / 'lib/raop.c'
    text = path.read_text()
    text = once(text, '    bool hls_pending;', '''    bool hls_pending;
    bool mgu_dacp_video_retained;
    void *mgu_dacp_current_owner;
    void *mgu_dacp_request_owner;
    unsigned char mgu_dacp_peer[16], mgu_dacp_video_peer[16];
    int mgu_dacp_peer_length, mgu_dacp_video_peer_length;
    unsigned int mgu_dacp_peer_zone, mgu_dacp_video_peer_zone;
    bool mgu_dacp_audio_handoff;''')
    text = once(text, '    bool have_active_remote;', '''    bool have_active_remote;
    bool mgu_pair_verified;
    bool mgu_control_published;
    char mgu_dacp_id[17];
    char mgu_active_remote[21];''')
    anchor = 'typedef struct raop_conn_s raop_conn_t;'
    text = once(text, anchor, anchor + '''

static bool mgu_music_peer_equal(const unsigned char *a, int length, unsigned int zone,
                                 const unsigned char *b, int other_length, unsigned int other_zone) {
    if ((length != 4 && length != 16) || length != other_length || memcmp(a, b, length)) return false;
    bool link_local = length == 16 && a[0] == 0xfe && (a[1] & 0xc0) == 0x80;
    return !link_local || zone == other_zone;
}
static bool mgu_music_video_active(raop_t *raop) {
    return (raop->callbacks.is_hls_active && raop->callbacks.is_hls_active(raop->callbacks.cls)) ||
        raop_playlist_waiting(raop);
}
static bool mgu_music_sender_allowed(raop_conn_t *conn) {
    raop_t *raop = conn->raop;
    return raop->mgu_dacp_audio_handoff || !mgu_music_video_active(raop) ||
        mgu_music_peer_equal(conn->remote, conn->remotelen, conn->zone_id,
            raop->mgu_dacp_video_peer, raop->mgu_dacp_video_peer_length, raop->mgu_dacp_video_peer_zone);
}
static void mgu_music_control_forget(raop_conn_t *conn, bool retain_video) {
    void *guard = raop_playlist_transition_begin(conn->raop);
    if (conn->mgu_control_published && conn->raop->callbacks.music_control &&
        conn->raop->mgu_dacp_current_owner == conn) {
        bool video = retain_video && mgu_music_video_active(conn->raop) &&
            mgu_music_peer_equal(conn->raop->mgu_dacp_peer, conn->raop->mgu_dacp_peer_length, conn->raop->mgu_dacp_peer_zone,
                conn->raop->mgu_dacp_video_peer, conn->raop->mgu_dacp_video_peer_length, conn->raop->mgu_dacp_video_peer_zone);
        /* Keep the same already-verified destination and capability token.
         * Neither an HLS request nor mDNS can substitute another target. */
        if (video) conn->raop->mgu_dacp_video_retained = true;
        else {
            conn->raop->callbacks.music_control(conn->raop->callbacks.cls, conn, NULL, 0, 0, NULL, NULL);
            conn->raop->mgu_dacp_current_owner = NULL;
            conn->raop->mgu_dacp_peer_length = 0;
            conn->raop->mgu_dacp_video_retained = false;
        }
    }
    conn->mgu_control_published = false;
    conn->mgu_dacp_id[0] = 0;
    conn->mgu_active_remote[0] = 0;
    raop_playlist_transition_end(guard);
}
static void mgu_music_control_clear(raop_conn_t *conn) {
    mgu_music_control_forget(conn, true);
}
static void mgu_music_control_capture(raop_conn_t *conn, http_request_t *request) {
    const char *id = http_request_get_header(request, "DACP-ID");
    const char *token = http_request_get_header(request, "Active-Remote");
    if (id && token && strlen(id) < sizeof conn->mgu_dacp_id && strlen(token) < sizeof conn->mgu_active_remote) {
        strcpy(conn->mgu_dacp_id, id);
        strcpy(conn->mgu_active_remote, token);
    }
}
static void mgu_music_control_audio_setup(raop_conn_t *conn, http_request_t *request, http_response_t *response) {
    raop_t *raop = conn->raop;
    if (!(conn->mgu_pair_verified || conn->authenticated) || !conn->raop_rtp ||
        !raop_rtp_is_running(conn->raop_rtp) || http_response_get_status(response) != 200 ||
        http_response_get_disconnect(response) || !raop->callbacks.music_control ||
        !mgu_music_sender_allowed(conn) ||
        (raop->callbacks.audio_stream_is_current &&
         !raop->callbacks.audio_stream_is_current(raop->callbacks.cls, conn->raop_rtp))) return;
    /* A successful selected SETUP96 is a new audio epoch even when its RTSP
     * connection/RTP object is reused. Do not inherit another app's token.
     * NULL owner explicitly invalidates any previous selected descriptor;
     * ordinary disconnect callbacks still clear only their own owner. */
    raop->callbacks.music_control(raop->callbacks.cls, NULL, NULL, 0, 0, NULL, NULL);
    raop->mgu_dacp_current_owner = NULL;
    mgu_music_control_forget(conn, false);
    raop->mgu_dacp_video_retained = false;
    mgu_music_control_capture(conn, request);
}
''')
    anchor = '    if (!conn->have_active_remote) {'
    text = once(text, anchor, '''    /* Retain bounded credentials until pair verification and audio SETUP.
     * They may arrive before authentication; never authorize controls then. */
    mgu_music_control_capture(conn, request);
''' + anchor)
    anchor = '    finish:;'
    text = once(text, anchor, '''    if (*response && http_response_get_status(*response) == 200 &&
        !http_response_get_disconnect(*response) &&
        !conn->mgu_control_published && conn->raop_rtp &&
        (conn->mgu_pair_verified || conn->authenticated) &&
        mgu_music_sender_allowed(conn) &&
        (!raop->callbacks.audio_stream_is_current ||
         raop->callbacks.audio_stream_is_current(raop->callbacks.cls, conn->raop_rtp)) &&
        conn->mgu_dacp_id[0] && conn->mgu_active_remote[0] && raop->callbacks.music_control) {
        raop->callbacks.music_control(raop->callbacks.cls, conn, conn->remote,
            conn->remotelen, conn->zone_id, conn->mgu_dacp_id, conn->mgu_active_remote);
        conn->mgu_control_published = true;
        raop->mgu_dacp_current_owner = conn;
        raop->mgu_dacp_video_retained = false;
        raop->mgu_dacp_peer_length = conn->remotelen == 4 || conn->remotelen == 16 ? conn->remotelen : 0;
        if (raop->mgu_dacp_peer_length) memcpy(raop->mgu_dacp_peer, conn->remote, raop->mgu_dacp_peer_length);
        raop->mgu_dacp_peer_zone = conn->zone_id;
    }

''' + anchor)
    anchor = '        handler(conn, request, *response, &response_data, &response_datalen);'
    text = once(text, anchor, '''        void *previous_control_owner = raop->mgu_dacp_request_owner;
        if (!hls_request) raop->mgu_dacp_request_owner = conn;
''' + anchor + '''
        if (!hls_request) raop->mgu_dacp_request_owner = previous_control_owner;''')
    anchor = '    logger_log(raop->logger, LOGGER_DEBUG, "Destroying connection");'
    text = once(text, anchor, anchor + '''
    mgu_music_control_clear(conn);''')
    # Upstream debug headers contain Active-Remote; suppress that entire header
    # block when credentials are present, regardless of the logging level.
    text = once(text, '    if (header_str && logger_debug) {',
                '    if (header_str && logger_debug && !http_request_get_header(request, "Active-Remote")) {')
    text += '''
/* A retained descriptor outlives only its still-active video session. The
 * ordinary connection-owned descriptor remains available while paired. */
void raop_music_control_release_video(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (!raop || !raop->mgu_dacp_video_retained) return;
    raop->mgu_dacp_video_retained = false;
    raop->mgu_dacp_current_owner = NULL;
    raop->mgu_dacp_peer_length = 0;
    if (raop->callbacks.music_control)
        raop->callbacks.music_control(raop->callbacks.cls, NULL, NULL, 0, 0, NULL, NULL);
}

/* Called only by an accepted native video start. The scoped request context
 * comes from the actual control handler, never from a playlist GET or mDNS. */
void raop_music_control_bind_video(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (!raop) return;
    raop_conn_t *source = raop->mgu_dacp_request_owner;
    int length = source && source->remote && (source->remotelen == 4 || source->remotelen == 16) ? source->remotelen : 0;
    raop->mgu_dacp_video_peer_length = length;
    if (length) memcpy(raop->mgu_dacp_video_peer, source->remote, length);
    raop->mgu_dacp_video_peer_zone = source ? source->zone_id : 0;
    raop->mgu_dacp_audio_handoff = false;
    if (!mgu_music_peer_equal(raop->mgu_dacp_peer, raop->mgu_dacp_peer_length, raop->mgu_dacp_peer_zone,
        raop->mgu_dacp_video_peer, length, raop->mgu_dacp_video_peer_zone)) {
        if (raop->mgu_dacp_current_owner && raop->callbacks.music_control)
            raop->callbacks.music_control(raop->callbacks.cls, NULL, NULL, 0, 0, NULL, NULL);
        raop->mgu_dacp_current_owner = NULL;
        raop->mgu_dacp_video_retained = false;
        raop->mgu_dacp_peer_length = 0;
    }
}

void raop_music_control_begin_audio(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (!raop) return;
    if (raop->mgu_dacp_current_owner && raop->callbacks.music_control)
        raop->callbacks.music_control(raop->callbacks.cls, NULL, NULL, 0, 0, NULL, NULL);
    raop->mgu_dacp_current_owner = NULL;
    raop->mgu_dacp_video_retained = false;
    raop->mgu_dacp_peer_length = 0;
    raop->mgu_dacp_video_peer_length = 0;
    raop->mgu_dacp_audio_handoff = true;
}
'''
    path.write_text(text)
    path = source / 'lib/raop_handlers.h'
    text = path.read_text()
    anchor = '        logger_log(raop->logger, LOGGER_DEBUG, "pair-verify: signature is verified");'
    text = once(text, anchor, '        conn->mgu_pair_verified = true;\n' + anchor)
    for line in ['        logger_log(raop->logger, LOGGER_DEBUG, "DACP-ID: %s", dacp_id);\n',
                 '        logger_log(raop->logger, LOGGER_DEBUG, "Active-Remote: %s", active_remote_header);\n']:
        text = once(text, line, '')
    anchor = '                    raop_rtp_start_audio(conn->raop_rtp, &remote_cport, &cport, &dport, &ct, &sr);'
    text = once(text, anchor, anchor + '\n                    mgu_music_control_audio_setup(conn, request, response);')
    anchor = '    if (teardown_96) {'
    text = once(text, anchor, '''    /* Audio or untyped TEARDOWN ends the remote-control owner even if
     * the sender keeps its TCP connection open. A video-only handoff does not. */
    if (teardown_96 || !teardown_110) mgu_music_control_clear(conn);
''' + anchor)
    anchor = '''        conn->raop_ntp = NULL;
        conn->raop_rtp = NULL;
        conn->raop_rtp_mirror = NULL;'''
    text = once(text, anchor, '''        /* A new transport SETUP cannot inherit an earlier stream's token.
         * Its own request may provide fresh credentials. */
        mgu_music_control_clear(conn);
        mgu_music_control_capture(conn, request);
''' + anchor)
    path.write_text(text)
    anchor = 'extern "C" void export_dacp(void *cls, const char *active_remote, const char *dacp_id) {'
    ux = once(ux, anchor, '#include "mgu_music_control.h"\n\n' + anchor)
    anchor = '    raop_cbs.export_dacp = export_dacp;'
    ux = once(ux, anchor, anchor + '\n    raop_cbs.music_control = mgu_music_control;')
    anchor = 'static void mgu_finish_video_origin(void) {'
    ux = once(ux, anchor, anchor + '''
    if (!raop_playlist_waiting(raop) || open_connections == 0)
        raop_music_control_release_video(raop);''')
    anchor = '    if (open_connections == 0) {'
    ux = once(ux, anchor, anchor + '''
        if (!video_renderer_is_hls_active()) raop_music_control_release_video(raop);''')
    for anchor in ['extern "C" void mgu_video_loading(void *cls) {\n    if (mgu_audio_only) return;',
                   'extern "C" void on_video_play(void *cls, const char* location, const float start_position) {\n    if (mgu_audio_only) return;']:
        ux = once(ux, anchor, anchor + '\n    raop_music_control_bind_video(raop);')
    anchor = '''    mgu_audio_mode_guard guard;
    /* Invalidate old HLS bus/EOS callbacks before requesting its teardown.'''
    ux = once(ux, anchor, '''    raop_music_control_begin_audio(raop);
''' + anchor)
    return ux
