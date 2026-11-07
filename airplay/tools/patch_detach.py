"""Detached video: a video started from screen mirroring keeps playing on the
head unit while the iPhone is used for something else.

With mirroring active, leaving the video app makes iOS stop, pause or remove
the AirPlay video. Detect the mirror origin inside the native receiver, before
loading starts, so even an immediate app switch cannot cancel it. Phone
requests are ignored until the video ends or SIGUSR2 ("resume mirroring")
arrives; mirror audio is muted meanwhile (mirror video is already held back
while HLS owns the screen). Applied after patch_hls_lifecycle.
GPL-3.0-or-later like the patched UxPlay code.
"""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay source for detach patch: ' + old[:60])
    return text.replace(old, new)


HELPERS = '''static GMainLoop *gmainloop = NULL;
/* MGU detached video: 1 while an HLS video plays on independently of the phone. */
static gint mgu_detached = 0;
static gint mgu_mirror_active = 0;
static bool mgu_is_detached(void) { return g_atomic_int_get(&mgu_detached) == 1 && video_renderer_is_hls_active(); }
static gboolean mgu_signal_detach(gpointer data) {
    (void) data;
    if (video_renderer_is_hls_active()) {
        g_atomic_int_set(&mgu_detached, 1);
        printf("MGU_MEDIA_DETACHED\\n"); fflush(stdout);
    }
    return TRUE;
}
static gboolean mgu_signal_resume_mirror(gpointer data) {
    (void) data;
    g_atomic_int_set(&mgu_detached, 0);
    if (video_renderer_is_hls_active()) video_renderer_request_hls_stop();
    return TRUE;
}'''


def patch(ux, source):
    ux = once(ux, 'static GMainLoop *gmainloop = NULL;', HELPERS)
    anchor = '    guint sighup_watch_id = g_unix_signal_add(SIGHUP, (GSourceFunc) sigint_callback, (gpointer) loop);'
    ux = once(ux, anchor, anchor + '''
    g_unix_signal_add(SIGUSR1, (GSourceFunc) mgu_signal_detach, NULL);
    g_unix_signal_add(SIGUSR2, (GSourceFunc) mgu_signal_resume_mirror, NULL);
    printf("MGU_FEATURES detach\\nMGU_FEATURES native-detach\\n"); fflush(stdout);''')
    anchor = 'extern "C" void audio_process (void *cls, raop_ntp_t *ntp, audio_decode_struct *data) {'
    ux = once(ux, anchor, anchor + '\n    if (mgu_is_detached()) return; /* phone sounds must not cover the video */')
    anchor = 'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {\n    if (video_renderer_is_hls_active()) return;'
    ux = once(ux, anchor, anchor + '\n    g_atomic_int_set(&mgu_mirror_active, 1);')
    anchor = 'extern "C" void on_video_play(void *cls, const char* location, const float start_position) {\n    video_renderer_begin_hls_transition();'
    ux = once(ux, anchor, anchor + '''
    g_atomic_int_set(&mgu_detached, g_atomic_int_get(&mgu_mirror_active));
    printf("MGU_MODE hls\\n"); fflush(stdout);
    if (mgu_is_detached()) { printf("MGU_MEDIA_DETACHED\\n"); fflush(stdout); }''')
    anchor = 'extern "C" void video_reset(void *cls, reset_type_t type) {'
    ux = once(ux, anchor, anchor + '''
    if (type == RESET_TYPE_HLS_SHUTDOWN && mgu_is_detached()) {
        printf("MGU_PHONE_STOP_IGNORED\\n"); fflush(stdout); return;
    }
    if (type == RESET_TYPE_HLS_EOS || type == RESET_TYPE_NOHOLD ||
        (type == RESET_TYPE_RTP_SHUTDOWN && !video_renderer_is_hls_active())) {
        g_atomic_int_set(&mgu_detached, 0);
        g_atomic_int_set(&mgu_mirror_active, 0);
    }''')
    anchor = '    if (open_connections == 0) {'
    ux = once(ux, anchor, anchor + '''
        if (!video_renderer_is_hls_active()) g_atomic_int_set(&mgu_mirror_active, 0);''')
    anchor = 'extern "C" bool mgu_hls_active(void *cls) { (void) cls; return video_renderer_is_hls_active(); }'
    ux = once(ux, anchor, anchor + '\nextern "C" bool mgu_hls_detached(void *cls) { (void) cls; return mgu_is_detached(); }')
    anchor = '    raop_cbs.is_hls_active = mgu_hls_active;'
    ux = once(ux, anchor, anchor + '\n    raop_cbs.is_hls_detached = mgu_hls_detached;')
    header = source / 'lib/raop.h'
    header.write_text(once(header.read_text(), '    bool  (*is_hls_active)(void *cls);',
                           '    bool  (*is_hls_active)(void *cls);\n    bool  (*is_hls_detached)(void *cls);'))
    handlers = source / 'lib/http_handlers.h'
    handlers.write_text(once(handlers.read_text(), '''        if (id == raop->current_video) {
            raop->current_video = -1;''', '''        if (id == raop->current_video) {
            /* Keep local playlist routes valid when the phone backgrounds. */
            if (!raop->callbacks.is_hls_detached || !raop->callbacks.is_hls_detached(raop->callbacks.cls))
                raop->current_video = -1;'''))
    anchor = 'extern "C" void on_video_rate(void *cls, const float rate) {'
    ux = once(ux, anchor, anchor + '''
    if (rate == 0.0f && mgu_is_detached()) { printf("MGU_PHONE_PAUSE_IGNORED\\n"); fflush(stdout); return; }''')
    anchor = '''extern "C" float on_video_playlist_remove (void *cls) {
    double duration, position, seek_start, seek_end;
    float rate;
    bool buffer_empty, buffer_full;'''
    ux = once(ux, anchor, anchor + '''
    if (mgu_is_detached()) {
        video_get_playback_info(&duration, &position, &seek_start, &seek_end, &rate, &buffer_empty, &buffer_full);
        printf("MGU_PHONE_STOP_IGNORED\\n"); fflush(stdout);
        return (float) position;
    }''')
    anchor = ' extern "C" void on_video_stop(void *cls) {'
    ux = once(ux, anchor, anchor + '''
    if (mgu_is_detached()) { printf("MGU_PHONE_STOP_IGNORED\\n"); fflush(stdout); return; }''')
    return ux
