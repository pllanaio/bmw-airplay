"""Keep AirPlay control sessions alive at VOD end and handle sender playlistInsert.

Applied after patch_detach and patch_reverse. Sender owns the actual YouTube
queue; only explicit item requests are started. GPL-3.0-or-later.
"""
from pathlib import Path


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay playlist source: ' + old[:80])
    return text.replace(old, new)


def patch(source, ux, video):
    raop_path = source / 'lib/raop.c'
    raop = raop_path.read_text()
    raop = once(raop, '    int current_video;', '''    int current_video;
    bool mgu_terminal, mgu_terminal_detached, mgu_continue_detached, mgu_inserting, mgu_playlist_cancelled, mgu_accept_after_stop;
    int mgu_action_at_end;
    double mgu_active_start;
    playback_info_t mgu_terminal_info, mgu_last_info;
    char mgu_active_session[37], mgu_active_uuid[37], mgu_active_source[8193];''')
    raop = once(raop, 'conn_request(void *ptr, http_request_t *request, http_response_t **response) {', '''conn_request(void *ptr, http_request_t *request, http_response_t **response) {
    pthread_mutex_t *mgu_control_guard __attribute__((cleanup(mgu_playlist_unlock))) = NULL;''')
    anchor = '    hls_request = (host && !cseq && !client_session_id && !strcmp(method, "GET") && strcmp(url, "/server-info") && strcmp(url, "/playback-info"));'
    raop = once(raop, anchor, anchor + '''
    /* Never block the one HTTP thread behind EOS teardown: GStreamer may
     * still need a local playlist GET to finish shutting its pipeline down.
     * End events are sent after reset, so normal sender auto-next arrives
     * once this short exclusion has already completed. */
    if (!hls_request) {
        mgu_control_guard = mgu_playlist_trylock();
        if (!mgu_control_guard) {
            *response = http_response_create();
            http_response_init(*response, protocol, 503, "Service Unavailable");
            http_response_add_header(*response, "Retry-After", "1");
            http_response_add_header(*response, "Content-Length", "0");
            goto finish;
        }
    }
''')
    start = raop.index('void raop_handle_eos(raop_t *raop) {')
    end = raop.index('\nuint64_t get_local_time()', start)
    raop = raop[:start] + '''bool raop_playlist_waiting(raop_t *raop) { MGU_PLAYLIST_GUARD; return raop && raop->mgu_terminal; }
bool raop_playlist_continue_detached(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    bool value = raop && raop->mgu_continue_detached;
    if (raop) raop->mgu_continue_detached = false;
    return value;
}
void raop_playlist_cancel(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (!raop) return;
    bool had_item = raop->mgu_active_uuid[0] || raop->mgu_terminal;
    raop->mgu_terminal = raop->mgu_terminal_detached = raop->mgu_continue_detached = false;
    raop->mgu_playlist_cancelled = true;
    raop->mgu_accept_after_stop = false;
    if (had_item) mgu_reverse_clear(raop);
    if (had_item) { printf("MGU_PLAYLIST_CANCELLED\\n"); fflush(stdout); }
}
void raop_playlist_stop(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (!raop) return;
    bool had_item = !raop->mgu_playlist_cancelled && (raop->mgu_active_uuid[0] || raop->mgu_terminal);
    bool already_stopped = raop->mgu_playlist_cancelled && raop->current_video < 0;
    raop->mgu_terminal = raop->mgu_terminal_detached = raop->mgu_continue_detached = false;
    raop->mgu_playlist_cancelled = true;
    if (!already_stopped) raop->mgu_accept_after_stop = true;
    raop->current_video = -1;
    /* Retain a transmitted request until its ACK is drained. Dropping it and
     * reusing the socket would let its delayed ACK acknowledge a later item.
     * Unsent end events are cancelled without disconnecting the PTTH link. */
    mgu_playlist_discard_pending(raop);
    if (had_item) { printf("MGU_PLAYLIST_CANCELLED\\n"); fflush(stdout); }
}
void raop_playlist_control(raop_t *raop, void (*control)(void *), void *data) {
    MGU_PLAYLIST_GUARD;
    if (raop && control) control(data);
}
void raop_playlist_hold(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (raop) raop->mgu_accept_after_stop = false;
}
void *raop_playlist_transition_begin(raop_t *raop) { return raop ? mgu_playlist_lock() : NULL; }
void raop_playlist_transition_end(void *guard) { if (guard) pthread_mutex_unlock(guard); }
void raop_handle_hls_stop(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (!raop) return;
    raop_playlist_stop(raop);
    raop->callbacks.video_reset(raop->callbacks.cls, RESET_TYPE_HLS_EOS);
}
void raop_handle_eos(raop_t *raop) {
    MGU_PLAYLIST_GUARD;
    if (!raop || raop->mgu_terminal || raop->mgu_playlist_cancelled || raop->current_video < 0 || raop->current_video >= MAX_AIRPLAY_VIDEO) return;
    airplay_video_t *item = raop->airplay_video[raop->current_video];
    if (!item) return;
    double duration = get_duration(item);
    if (isfinite(raop->mgu_last_info.duration) && raop->mgu_last_info.duration > duration)
        duration = raop->mgu_last_info.duration;
    if (!isfinite(duration) || duration < 0.0) duration = 0.0;
    memset(&raop->mgu_terminal_info, 0, sizeof raop->mgu_terminal_info);
    raop->mgu_terminal_info.duration = raop->mgu_terminal_info.position = duration;
    raop->mgu_terminal_info.seek_duration = duration;
    /* Terminal rate=1 is the AirPlay end handshake, not a new local play command. */
    raop->mgu_terminal_info.rate = raop->mgu_action_at_end == 1 ? 0.0f : 1.0f;
    raop->mgu_terminal_info.ready_to_play = true;
    raop->mgu_terminal_info.playback_buffer_empty = true;
    raop->mgu_terminal = true;
    raop->mgu_terminal_detached = raop->callbacks.is_hls_detached && raop->callbacks.is_hls_detached(raop->callbacks.cls);
    /* Keep the completed item and reverse/control channels for next-item requests. */
    raop->callbacks.video_reset(raop->callbacks.cls, RESET_TYPE_HLS_EOS);
    /* Finish reset before the sender can react with a new /play. HTTP control
     * shares this guard, so an old EOS cannot reset the successor's renderer. */
    if (raop->mgu_action_at_end == 0) {
        printf("MGU_MEDIA_ENDED\\n"); fflush(stdout);
        mgu_playlist_end_events(raop);
    }
}
void raop_playlist_poll_end(raop_t *raop, bool (*ended)(void), bool (*completed)(void), void (*ready)(void)) {
    MGU_PLAYLIST_GUARD;
    if (!raop || !ended || !completed || !ready || !ended()) return;
    bool natural = completed();
    ready();
    if (natural) raop_handle_eos(raop); else raop_handle_hls_stop(raop);
}
''' + raop[end:]
    raop_path.write_text(raop)
    header_path = source / 'lib/raop.h'
    header = header_path.read_text()
    header = once(header, 'void raop_handle_eos(raop_t *raop);', '''void raop_handle_eos(raop_t *raop);
void raop_handle_hls_stop(raop_t *raop);
void raop_playlist_cancel(raop_t *raop);
void raop_playlist_stop(raop_t *raop);
void raop_playlist_control(raop_t *raop, void (*control)(void *), void *data);
void raop_playlist_hold(raop_t *raop);
void *raop_playlist_transition_begin(raop_t *raop);
void raop_playlist_transition_end(void *guard);
bool raop_playlist_waiting(raop_t *raop);
bool raop_playlist_continue_detached(raop_t *raop);
void raop_playlist_poll_end(raop_t *raop, bool (*ended)(void), bool (*completed)(void), void (*ready)(void));''')
    header_path.write_text(header)
    response_path = source / 'lib/http_response.c'
    original = source.parents[1].parent / '.local/airplay/UxPlay/lib/http_response.c'
    response_path.write_text(original.read_text() + '''
int http_response_get_status(http_response_t *response) {
    if (!response || response->data_length < 12) return 0;
    const char *space = memchr(response->data, ' ', response->data_length);
    return space && space + 4 <= response->data + response->data_length ? atoi(space + 1) : 0;
}
''')
    response_header = source / 'lib/http_response.h'
    original = original.with_name('http_response.h')
    response_header.write_text(original.read_text() + '\nint http_response_get_status(http_response_t *response);\n')
    http_path = source / 'lib/http_handlers.h'
    http = http_path.read_text()
    anchor = '/* handles PUT /setProperty http requests from Client to Server */'
    # Helpers need the current-item lookup and UUID lookup, defined above this anchor.
    http = once(http, anchor, '#include "mgu_playlist.h"\n\n' + anchor)
    # Names are forward-declared by mgu_playlist.h; the helper invokes the actual patched upstream handler.
    http = once(http, 'http_handler_play(raop_conn_t *conn, http_request_t *request, http_response_t *response,',
                'mgu_http_handler_play_original(raop_conn_t *conn, http_request_t *request, http_response_t *response,')
    anchor = '''    raop_t *raop = conn->raop;
    const char *url = http_request_get_url(request);
    const char *property = url + strlen("/setProperty?");'''
    http = once(http, anchor, '''    MGU_PLAYLIST_GUARD;
    if (mgu_playlist_property(conn, request, response, response_data, response_datalen)) return;
''' + anchor)
    anchor = '''    raop_t *raop = conn->raop;
    airplay_video_t *airplay_video = (airplay_video_t *) hls_get_current_video(raop);
    assert(airplay_video);
    bool data_is_plist = false;'''
    http = once(http, anchor, '''    MGU_PLAYLIST_GUARD;
    if (mgu_playlist_action(conn, request, response, response_data, response_datalen)) return;
''' + anchor.replace('    assert(airplay_video);', '    if (!airplay_video) { mgu_playlist_bad(response, 400); return; }'))
    http = once(http, '''    playback_info_t playback_info;

    playback_info.stallcount = 0;''', '''    playback_info_t playback_info = {0};

    playback_info.stallcount = 0;''')
    http = once(http, '    playback_info_t playback_info = {0};', '    MGU_PLAYLIST_GUARD;\n    playback_info_t playback_info = {0};')
    anchor = '    raop->callbacks.on_video_acquire_playback_info(raop->callbacks.cls, &playback_info);'
    http = once(http, anchor, '''    if (raop->mgu_terminal) mgu_playlist_snapshot(raop, &playback_info);
    else {
''' + anchor + '''
        if (isfinite(playback_info.duration) && playback_info.duration >= 0.0 && playback_info.position >= 0.0)
            raop->mgu_last_info = playback_info;
    }''')
    # Without usable playback information keep the channel open and report loading rather than destroying PTTH.
    start = http.index('    if (playback_info.duration == -1.0) {')
    end = http.index('    playback_info.num_loaded_time_ranges = 1;', start)
    http = http[:start] + '''    if (playback_info.duration < 0.0 || playback_info.position < 0.0) {
        memset(&playback_info, 0, sizeof playback_info);
        playback_info.playback_buffer_empty = true;
    }
''' + http[end:]
    # Explicit stop remains explicit and never masquerades as natural completion.
    anchor = '    raop->callbacks.on_video_stop(raop->callbacks.cls);'
    http = once(http, anchor, '''    raop_playlist_stop(raop);
''' + anchor)
    # Never assert on a partially initialized cached item after a failed request.
    http = once(http, 'if (raop->airplay_video[i] && !strcmp(uuid, get_playback_uuid(raop->airplay_video[i])))',
                'if (raop->airplay_video[i] && get_playback_uuid(raop->airplay_video[i]) && !strcmp(uuid, get_playback_uuid(raop->airplay_video[i])))')
    # A standard direct replay can retain the old item for outstanding local
    # routes. Control commands for that UUID must select the active replay.
    http = once(http, 'get_playlist_by_uuid(raop_t *raop, const char *uuid) {', '''get_playlist_by_uuid(raop_t *raop, const char *uuid) {
    if (!uuid) return -1;
    int current = raop->current_video;
    if (current >= 0 && current < MAX_AIRPLAY_VIDEO && raop->airplay_video[current] &&
        get_playback_uuid(raop->airplay_video[current]) &&
        !strcmp(uuid, get_playback_uuid(raop->airplay_video[current]))) return current;''')
    http_path.write_text(http)
    # Complete sender-controlled continuation can inherit the detached mirror origin,
    # while a later unrelated /play never inherits it.
    ux = once(ux, 'g_atomic_int_set(&mgu_detached, g_atomic_int_get(&mgu_mirror_active) || (pending_origin && g_atomic_int_get(&mgu_return_mirror)));',
              'bool continuing_detached = raop_playlist_continue_detached(raop);\n    g_atomic_int_set(&mgu_detached, g_atomic_int_get(&mgu_mirror_active) || continuing_detached || (pending_origin && g_atomic_int_get(&mgu_return_mirror)));')
    ux = once(ux, 'MGU_FEATURES native-detach\\n', 'MGU_FEATURES native-detach\\nMGU_FEATURES playlist\\n')
    start = ux.index('static gboolean video_eos_watch_callback (gpointer loop) {')
    end = ux.index('\n#define MAX_VIDEO_RENDERERS', start)
    ux = ux[:start] + '''static gboolean video_eos_watch_callback (gpointer loop) {
    raop_playlist_poll_end(raop, video_renderer_eos_watch, video_renderer_hls_completed, video_renderer_hls_ready);
    return TRUE;
}
''' + ux[end:]
    ux = once(ux, '    if (video_renderer_is_hls_active()) { missed_feedback = 0; return TRUE; }',
              '    if (video_renderer_is_hls_active() || raop_playlist_waiting(raop)) { missed_feedback = 0; return TRUE; }')
    ux = once(ux, '''    case RESET_TYPE_HLS_EOS:
        LOGD("video_reset: type= HLS_eos");''', '''    case RESET_TYPE_HLS_EOS:
        url.erase();
        LOGD("video_reset: type= HLS_eos");''')
    ux = once(ux, '        preserve_connections = false; //we already closed all other connections',
              '        preserve_connections = true; // Sender may provide the next playlist item over PTTH.')
    # Both stop/error historically set renderer->eos. Announce itemPlayedToEnd only
    # for an actual GStreamer EOS, never a local stop, load failure or mirror return.
    video = once(video, 'static bool hls_video = false;', '''static bool hls_video = false;
static gint mgu_hls_natural_end = 0;
static gint mgu_hls_generation = 0;
static gint mgu_hls_pipeline_generation = 0;''')
    anchor = 'void video_renderer_begin_hls_transition(void) {'
    video = once(video, anchor, anchor + '\n    g_atomic_int_add(&mgu_hls_generation, 1);\n    g_atomic_int_set(&mgu_hls_natural_end, 0);')
    video = once(video, '    hls_video = (uri != NULL);', '''    hls_video = (uri != NULL);
    g_atomic_int_set(&mgu_hls_pipeline_generation, g_atomic_int_get(&mgu_hls_generation));
    g_atomic_int_set(&mgu_hls_natural_end, 0);''')
    video = once(video, 'bool video_renderer_eos_watch() {\n    MGU_RENDER_GUARD;', '''bool video_renderer_eos_watch() {
    MGU_RENDER_GUARD;
    /* A new /play has already reserved the next item, but the old pipeline
     * may still be present until the GLib renderer rebuild runs. */
    if (g_atomic_int_get(&mgu_hls_pipeline_generation) != g_atomic_int_get(&mgu_hls_generation)) return false;''')
    video = once(video, '    case GST_MESSAGE_ERROR: {', '    case GST_MESSAGE_ERROR: {\n        if (hls_video) g_atomic_int_set(&mgu_hls_natural_end, 0);')
    anchor = '    case GST_MESSAGE_EOS:\n        /* end-of-stream */'
    video = once(video, anchor, anchor + '\n        if (hls_video) g_atomic_int_set(&mgu_hls_natural_end, 1);')
    anchor = 'void video_renderer_request_hls_stop(void) {'
    video = once(video, anchor, anchor + '\n    g_atomic_int_set(&mgu_hls_natural_end, 0);')
    video += '''
bool video_renderer_hls_completed(void) { return g_atomic_int_get(&mgu_hls_natural_end) != 0; }
'''
    header_path = source / 'renderers/video_renderer.h'
    header_path.write_text(once(header_path.read_text(), 'void video_renderer_request_hls_stop(void);',
                               'void video_renderer_request_hls_stop(void);\nbool video_renderer_hls_completed(void);'))
    return ux, video
