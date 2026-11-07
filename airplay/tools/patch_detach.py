"""Preserve the origin of independent AirPlay video playback.

Mirror transport shutdown is independent of video playback. Explicit media
stop, pause and HLS teardown remain authoritative: identical wire requests
cannot be classified as a manual action versus an app entering background.
Mirror-origin video returns to mirroring; direct video waits for another item.
Applied after patch_hls_lifecycle.
GPL-3.0-or-later like the patched UxPlay code.
"""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay source for detach patch: ' + old[:60])
    return text.replace(old, new)


HELPERS = '''static GMainLoop *gmainloop = NULL;
/* Retained from GLib loop exit through renderer rebuild and the next setup.
 * No accepted /play may be erased by the next loop's initial flag reset. */
static void *mgu_transition_guard = NULL;
/* These handlers survive renderer loop restarts. In particular SIGUSR2 must
 * never regain its process-terminating default action during a rebuild. */
static guint mgu_detach_watch_id = 0, mgu_mirror_watch_id = 0, mgu_stop_watch_id = 0;
/* The media origin is independent of the mirror transport's lifetime. */
static gint mgu_detached = 0;
static gint mgu_mirror_active = 0;
static gint mgu_return_mirror = 0;
static gint mgu_allow_mirror = 1;
static gint mgu_pending_origin = 0;
static bool mgu_is_detached(void) { return g_atomic_int_get(&mgu_detached) == 1 && video_renderer_is_hls_active(); }
static void mgu_finish_video_origin(void) {
    bool mirror = g_atomic_int_get(&mgu_return_mirror) != 0;
    g_atomic_int_set(&mgu_allow_mirror, mirror);
    g_atomic_int_set(&mgu_detached, 0);
    g_atomic_int_set(&mgu_mirror_active, 0);
    g_atomic_int_set(&mgu_pending_origin, 0);
    printf("MGU_RETURN %s\\n", mirror ? "mirror" : "waiting"); fflush(stdout);
}
static void mgu_request_video_stop(void) {
    raop_playlist_stop(raop);
    /* Also cancel a /play that has reserved HLS ownership but whose pipeline
     * has not yet been created. Stopping only the old renderer loses that stop. */
    url.erase();
    mgu_finish_video_origin();
    video_renderer_request_hls_stop();
    preserve_connections = true;
    relaunch_video = true;
    reset_loop = true;
}
static gboolean mgu_signal_detach(gpointer data) {
    (void) data;
    /* Legacy signal: video already plays independently of the mirror RTP.
     * It must never change its origin or disable the sender's controls. */
    if (video_renderer_is_hls_active()) { printf("MGU_MEDIA_BACKGROUND\\n"); fflush(stdout); }
    return TRUE;
}
static void mgu_control_video_stop(void *data) {
    bool force_mirror = GPOINTER_TO_INT(data) != 0;
    if (force_mirror) {
        g_atomic_int_set(&mgu_return_mirror, 1);
        g_atomic_int_set(&mgu_allow_mirror, 1);
        g_atomic_int_set(&mgu_detached, 0);
    }
    if (video_renderer_is_hls_active()) mgu_request_video_stop();
    else { raop_playlist_stop(raop); mgu_finish_video_origin(); }
    if (force_mirror) raop_playlist_hold(raop);
}
static gboolean mgu_signal_stop_video(gpointer data) {
    (void) data;
    raop_playlist_control(raop, mgu_control_video_stop, GINT_TO_POINTER(0));
    return TRUE;
}
static gboolean mgu_signal_resume_mirror(gpointer data) {
    (void) data;
    raop_playlist_control(raop, mgu_control_video_stop, GINT_TO_POINTER(1));
    return TRUE;
}'''


def patch(ux, source):
    ux = once(ux, 'static GMainLoop *gmainloop = NULL;', HELPERS)
    anchor = '    guint sighup_watch_id = g_unix_signal_add(SIGHUP, (GSourceFunc) sigint_callback, (gpointer) loop);'
    ux = once(ux, anchor, anchor + '''
    if (!mgu_detach_watch_id) mgu_detach_watch_id = g_unix_signal_add(SIGUSR1, (GSourceFunc) mgu_signal_detach, NULL);
    if (!mgu_mirror_watch_id) mgu_mirror_watch_id = g_unix_signal_add(SIGUSR2, (GSourceFunc) mgu_signal_resume_mirror, NULL);
    if (!mgu_stop_watch_id) mgu_stop_watch_id = g_unix_signal_add(SIGWINCH, (GSourceFunc) mgu_signal_stop_video, NULL);
    printf("MGU_FEATURES detach\\nMGU_FEATURES native-detach\\nMGU_FEATURES video-modes\\nMGU_FEATURES media-stop\\n"); fflush(stdout);''')
    anchor = 'static void cleanup() {'
    ux = once(ux, anchor, anchor + '''
    if (mgu_detach_watch_id > 0) g_source_remove(mgu_detach_watch_id);
    if (mgu_mirror_watch_id > 0) g_source_remove(mgu_mirror_watch_id);
    if (mgu_stop_watch_id > 0) g_source_remove(mgu_stop_watch_id);
    mgu_detach_watch_id = mgu_mirror_watch_id = mgu_stop_watch_id = 0;''')
    ux = once(ux, 'static void main_loop()  {', '''static void main_loop()  {
    if (!mgu_transition_guard) mgu_transition_guard = raop_playlist_transition_begin(raop);''')
    ux = once(ux, '    g_main_loop_run(loop);', '''    raop_playlist_transition_end(mgu_transition_guard);
    mgu_transition_guard = NULL;
    g_main_loop_run(loop);
    mgu_transition_guard = raop_playlist_transition_begin(raop);''')
    ux = once(ux, '''        if (reset_httpd) {
            raop_stop_httpd(raop);
        }''', '''        if (reset_httpd) {
            /* Joining the HTTP thread must never hold its control guard. */
            raop_playlist_transition_end(mgu_transition_guard);
            mgu_transition_guard = NULL;
            raop_stop_httpd(raop);
            mgu_transition_guard = raop_playlist_transition_begin(raop);
        }''')
    ux = once(ux, '''    } else {
        LOGI("Stopping RAOP Server...");''', '''    } else {
        raop_playlist_transition_end(mgu_transition_guard);
        mgu_transition_guard = NULL;
        LOGI("Stopping RAOP Server...");''')
    for anchor in [
        'extern "C" void audio_process (void *cls, raop_ntp_t *ntp, audio_decode_struct *data) {',
        'extern "C" void audio_get_format (void *cls, unsigned char *ct, unsigned short *spf, bool *usingScreen, bool *isMedia, uint64_t *audioFormat) {',
        'extern "C" int video_set_codec(void *cls, video_codec_t codec) {',
    ]:
        # A stale mirror must not take over after a direct video is stopped.
        value = ' return 0;' if 'int video_set_codec' in anchor else ' return;'
        ux = once(ux, anchor, anchor + '\n    if (!g_atomic_int_get(&mgu_allow_mirror))' + value)
    anchor = 'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {\n    if (video_renderer_is_hls_active()) return;'
    ux = once(ux, anchor, anchor + '\n    if (!g_atomic_int_get(&mgu_allow_mirror)) return;\n    g_atomic_int_set(&mgu_mirror_active, 1);')
    anchor = 'extern "C" void on_video_play(void *cls, const char* location, const float start_position) {\n    video_renderer_begin_hls_transition();'
    ux = once(ux, anchor, '''extern "C" void on_video_play(void *cls, const char* location, const float start_position) {
    bool pending_origin = g_atomic_int_compare_and_exchange(&mgu_pending_origin, 1, 0);
    if (!pending_origin) video_renderer_begin_hls_transition();
    g_atomic_int_set(&mgu_detached, g_atomic_int_get(&mgu_mirror_active) || (pending_origin && g_atomic_int_get(&mgu_return_mirror)));
    g_atomic_int_set(&mgu_return_mirror, g_atomic_int_get(&mgu_detached));
    printf("MGU_ORIGIN %s\\n", g_atomic_int_get(&mgu_return_mirror) ? "mirror" : "direct");
    printf("MGU_MODE hls\\n"); fflush(stdout);
''')
    anchor = 'extern "C" void video_reset(void *cls, reset_type_t type) {'
    ux = once(ux, anchor, anchor + '''
    if (type == RESET_TYPE_HLS_SHUTDOWN) {
        /* End this item without removing the receiver's PTTH/control links. */
        if (video_renderer_is_hls_active()) mgu_request_video_stop();
        else { raop_playlist_stop(raop); mgu_finish_video_origin(); }
        return;
    }
    if (type == RESET_TYPE_HLS_EOS) mgu_finish_video_origin();
    if (type == RESET_TYPE_NOHOLD ||
        (type == RESET_TYPE_RTP_SHUTDOWN && !video_renderer_is_hls_active())) {
        g_atomic_int_set(&mgu_detached, 0);
        g_atomic_int_set(&mgu_mirror_active, 0);
    }''')
    anchor = '    if (open_connections == 0) {'
    ux = once(ux, anchor, anchor + '''
        if (!video_renderer_is_hls_active()) g_atomic_int_set(&mgu_mirror_active, 0);''')
    anchor = 'extern "C" bool mgu_hls_active(void *cls) { (void) cls; return video_renderer_is_hls_active(); }'
    ux = once(ux, anchor, anchor + '''
extern "C" bool mgu_hls_detached(void *cls) { (void) cls; return mgu_is_detached(); }
extern "C" void mgu_video_loading(void *cls) {
    (void) cls;
    bool continuation = raop_playlist_continue_detached(raop);
    g_atomic_int_set(&mgu_detached, g_atomic_int_get(&mgu_mirror_active) || continuation);
    g_atomic_int_set(&mgu_return_mirror, g_atomic_int_get(&mgu_detached));
    g_atomic_int_set(&mgu_pending_origin, 1);
    /* Reserve this generation before FCUP playlists arrive. A paused/loading
     * item keeps its intent, and the old pipeline's EOS cannot finish it. */
    video_renderer_begin_hls_transition();
    printf("MGU_ORIGIN %s\\n", g_atomic_int_get(&mgu_return_mirror) ? "mirror" : "direct"); fflush(stdout);
}
extern "C" void mgu_mirror_start(void *cls) {
    (void) cls;
    /* Only a fresh SETUP is explicit mirroring intent. Late RTP/codec packets
     * from a suspended transport must not leave direct-video waiting mode. */
    if (!video_renderer_is_hls_active()) g_atomic_int_set(&mgu_allow_mirror, 1);
}''')
    anchor = '    raop_cbs.is_hls_active = mgu_hls_active;'
    ux = once(ux, anchor, anchor + '\n    raop_cbs.is_hls_detached = mgu_hls_detached;\n    raop_cbs.video_mirror_start = mgu_mirror_start;\n    raop_cbs.on_video_loading = mgu_video_loading;')
    header = source / 'lib/raop.h'
    header.write_text(once(header.read_text(), '    bool  (*is_hls_active)(void *cls);',
                           '    bool  (*is_hls_active)(void *cls);\n    bool  (*is_hls_detached)(void *cls);\n    void  (*video_mirror_start)(void *cls);\n    void  (*on_video_loading)(void *cls);'))
    raop_handlers = source / 'lib/raop_handlers.h'
    raop_handlers.write_text(once(raop_handlers.read_text(), '                // Mirroring', '''                // Mirroring
                if (raop->callbacks.video_mirror_start) raop->callbacks.video_mirror_start(raop->callbacks.cls);'''))
    raop_handlers.write_text(once(raop_handlers.read_text(), '''        if (hls_count) {
            raop->callbacks.video_reset(raop->callbacks.cls, RESET_TYPE_HLS_SHUTDOWN);''', '''        /* RAOP teardown ends only mirror/audio transport. A media control
         * connection can explicitly end HLS, including before its first GET. */
        if (conn->connection_type != CONNECTION_TYPE_RAOP &&
            (hls_count || (raop->callbacks.is_hls_active && raop->callbacks.is_hls_active(raop->callbacks.cls)))) {
            raop->callbacks.video_reset(raop->callbacks.cls, RESET_TYPE_HLS_SHUTDOWN);'''))
    handlers = source / 'lib/http_handlers.h'
    handlers.write_text(once(handlers.read_text(), '''        if (id == raop->current_video) {
            raop->current_video = -1;''', '''        if (id == raop->current_video) {
            /* Keep local playlist routes valid when the phone backgrounds. */
            if (!raop->callbacks.is_hls_detached || !raop->callbacks.is_hls_detached(raop->callbacks.cls))
                raop->current_video = -1;'''))
    handlers.write_text(once(handlers.read_text(), '''    set_next_media_uri_id(airplay_video, 0);
    fcup_request((void *) conn, playback_location, apple_session_id, get_next_FCUP_RequestID(airplay_video));''', '''    if (raop->callbacks.on_video_loading) raop->callbacks.on_video_loading(raop->callbacks.cls);
    set_next_media_uri_id(airplay_video, 0);
    fcup_request((void *) conn, playback_location, apple_session_id, get_next_FCUP_RequestID(airplay_video));'''))
    handlers.write_text(once(handlers.read_text(), '        float start_pos = get_start_position_seconds(airplay_video);', '''        float start_pos = get_start_position_seconds(airplay_video);
        if (raop->callbacks.on_video_loading) raop->callbacks.on_video_loading(raop->callbacks.cls);'''))
    anchor = '''extern "C" float on_video_playlist_remove (void *cls) {
    double duration, position, seek_start, seek_end;
    float rate;
    bool buffer_empty, buffer_full;'''
    ux = once(ux, anchor, anchor + '''
    if (mgu_is_detached()) {
        video_get_playback_info(&duration, &position, &seek_start, &seek_end, &rate, &buffer_empty, &buffer_full);
        /* playlistRemove alone is also sent as background queue cleanup.
         * Explicit /stop, rate=0 and HLS TEARDOWN still control playback. */
        printf("MGU_PLAYLIST_CLEANUP\\n"); fflush(stdout);
        return (float) position;
    }''')
    ux = once(ux, '    video_renderer_request_hls_stop();\n    return (float) position;',
              '    mgu_request_video_stop();\n    return (float) position;')
    ux = once(ux, ''' extern "C" void on_video_stop(void *cls) {
    LOGI("**************************on_video_stop\\n");
    video_renderer_request_hls_stop();''', ''' extern "C" void on_video_stop(void *cls) {
    LOGI("**************************on_video_stop\\n");
    mgu_request_video_stop();''')
    # The main loop can also rebuild after a local stop or a new /play. It
    # needs the same exclusion as the EOS callback: HTTP control must return
    # 503 instead of waiting on renderer teardown and starving local HLS GETs.
    ux = once(ux, '''        if (use_video && (close_window || preserve_connections || full_video_reset)) {
            video_renderer_destroy();''', '''        if (use_video && (close_window || preserve_connections || full_video_reset)) {
            raop_playlist_control(raop, [](void *) {
            video_renderer_destroy();''')
    ux = once(ux, '''            full_video_reset = false;
            video_renderer_start();
        }''', '''            full_video_reset = false;
            video_renderer_start();
            }, NULL);
        }''')
    return ux
