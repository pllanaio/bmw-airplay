"""Bind a private DACP descriptor to a verified RAOP audio owner. GPL-3.0-or-later."""


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
    header.write_text(text)
    path = source / 'lib/raop.c'
    text = path.read_text()
    text = once(text, '    bool have_active_remote;', '''    bool have_active_remote;
    bool mgu_pair_verified;
    bool mgu_control_published;
    char mgu_dacp_id[17];
    char mgu_active_remote[21];''')
    anchor = 'typedef struct raop_conn_s raop_conn_t;'
    text = once(text, anchor, anchor + '''

static void mgu_music_control_clear(raop_conn_t *conn) {
    if (conn->mgu_control_published && conn->raop->callbacks.music_control)
        conn->raop->callbacks.music_control(conn->raop->callbacks.cls, conn, NULL, 0, 0, NULL, NULL);
    conn->mgu_control_published = false;
    conn->mgu_dacp_id[0] = 0;
    conn->mgu_active_remote[0] = 0;
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
        (raop->callbacks.audio_stream_is_current &&
         !raop->callbacks.audio_stream_is_current(raop->callbacks.cls, conn->raop_rtp))) return;
    /* A successful selected SETUP96 is a new audio epoch even when its RTSP
     * connection/RTP object is reused. Do not inherit another app's token.
     * NULL owner explicitly invalidates any previous selected descriptor;
     * ordinary disconnect callbacks still clear only their own owner. */
    raop->callbacks.music_control(raop->callbacks.cls, NULL, NULL, 0, 0, NULL, NULL);
    mgu_music_control_clear(conn);
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
        (!raop->callbacks.audio_stream_is_current ||
         raop->callbacks.audio_stream_is_current(raop->callbacks.cls, conn->raop_rtp)) &&
        conn->mgu_dacp_id[0] && conn->mgu_active_remote[0] && raop->callbacks.music_control) {
        raop->callbacks.music_control(raop->callbacks.cls, conn, conn->remote,
            conn->remotelen, conn->zone_id, conn->mgu_dacp_id, conn->mgu_active_remote);
        conn->mgu_control_published = true;
    }

''' + anchor)
    anchor = '    logger_log(raop->logger, LOGGER_DEBUG, "Destroying connection");'
    text = once(text, anchor, anchor + '''
    mgu_music_control_clear(conn);''')
    # Upstream debug headers contain Active-Remote; suppress that entire header
    # block when credentials are present, regardless of the logging level.
    text = once(text, '    if (header_str && logger_debug) {',
                '    if (header_str && logger_debug && !http_request_get_header(request, "Active-Remote")) {')
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
    return ux
