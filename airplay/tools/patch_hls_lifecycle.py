"""Targeted UxPlay fixes for concurrent mirroring and remote HLS playback."""
import re
def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay HLS lifecycle anchor: ' + old[:90])
    return text.replace(old, new)

def patch(upstream, source, ux, video):
    # GLib's application name is immutable for the process, including rebuilds.
    video = once(video, '    if (!appname || strcmp(appname,server_name))  g_set_application_name(server_name);',
                 '    if (!appname) g_set_application_name(server_name);')
    video = once(video, 'static bool hls_video = false;', '''static bool hls_video = false;
/* 0 mirror, 1 HLS, 2 mirror renderer being rebuilt. Never route RTP into HLS. */
static gint mgu_hls_owner = 0;
static gint mgu_hls_stop_requested = 0;
static gint mgu_hls_desired_play = 1;
static gboolean mgu_hls_play_requested = FALSE;
static float mgu_hls_start_fraction = 0.0f;
bool video_renderer_is_hls_active(void) { return g_atomic_int_get(&mgu_hls_owner) == 1; }
void video_renderer_begin_hls_transition(void) { g_atomic_int_set(&mgu_hls_stop_requested, 0); g_atomic_int_set(&mgu_hls_desired_play, 1); g_atomic_int_set(&mgu_hls_owner, 1); }
''')
    video = once(video, '    hls_video = (uri != NULL);',
                 '    g_atomic_int_set(&mgu_hls_owner, uri ? 1 : 2);\n    mgu_hls_play_requested = (uri != NULL && g_atomic_int_get(&mgu_hls_desired_play));\n    hls_video = (uri != NULL);')
    video = once(video, '    hls_buffer_empty = TRUE;\n    hls_buffer_empty = FALSE;',
                 '    hls_buffer_empty = TRUE;\n    hls_buffer_full = FALSE;')
    video = once(video, 'void video_renderer_pause() {',
                 '''void video_renderer_pause() {
    if (video_renderer_is_hls_active()) g_atomic_int_set(&mgu_hls_desired_play, 0);
    if (hls_video) mgu_hls_play_requested = FALSE;
    else if (video_renderer_is_hls_active()) return;''')
    video = once(video, 'void video_renderer_resume() {', '''void video_renderer_resume() {
    if (video_renderer_is_hls_active()) g_atomic_int_set(&mgu_hls_desired_play, 1);
    if (!hls_video && video_renderer_is_hls_active()) return;
    if (hls_video) {
        mgu_hls_play_requested = TRUE;
        if (!hls_buffer_full) return;
    }''')
    video = once(video, 'void video_renderer_hls_ready() {',
                 'void video_renderer_hls_ready() {\n    mgu_hls_play_requested = FALSE;')
    video = once(video, 'void video_renderer_set_start(float position) {', '''void video_renderer_set_start(float position) {
    mgu_hls_start_fraction = (position < 0.0f && position >= -1.0f) ? -position : 0.0f;
    if (mgu_hls_start_fraction > 0.0f) { hls_requested_start_position = 0; return; }''')
    anchor = 'static void hls_video_seek_to_start_position(GstElement *pipeline) {'
    video = once(video, anchor, anchor + '''
    if (mgu_hls_start_fraction > 0.0f && GST_CLOCK_TIME_IS_VALID(hls_duration) && hls_duration > 0) {
        hls_requested_start_position = (gint64)(mgu_hls_start_fraction * hls_duration);
        mgu_hls_start_fraction = 0.0f;
    }
''')
    old = '''            hls_buffer_empty = TRUE;
            hls_buffer_full = FALSE;
            if (percent > 0) {
                hls_buffer_empty = FALSE;
                renderer->buffering_level = percent;
                logger_log(logger, LOGGER_DEBUG, "Buffering :%d percent done", percent);
                if (percent < 100) {
                    gst_element_set_state (renderer->pipeline, GST_STATE_PAUSED);
                } else {
                    hls_buffer_full = TRUE;
                    gst_element_set_state (renderer->pipeline, GST_STATE_PLAYING);
                }
            }'''
    video = once(video, old, '''            hls_buffer_empty = (percent <= 0);
            hls_buffer_full = (percent >= 100);
            renderer->buffering_level = CLAMP(percent, 0, 100);
            gst_element_set_state(renderer->pipeline,
                hls_buffer_full && mgu_hls_play_requested ? GST_STATE_PLAYING : GST_STATE_PAUSED);''')
    # Keep mirror packets blocked until start() has finished iterating over all
    # renderers. A packet choosing a codec earlier destroys the unused renderer
    # while start() is still about to access it.
    video = once(video, '    first_packet = true;',
                 '    first_packet = true;\n    g_atomic_int_set(&mgu_hls_owner, 0);\n    g_print("MGU_MODE waiting\\n"); fflush(stdout);')
    video = once(video, '    g_assert(!hls_video);',
                 '    if (g_atomic_int_get(&mgu_hls_owner) != 0) return 0;')
    anchor = 'uint64_t video_renderer_render_buffer(unsigned char* data, int *data_len, int *nal_count, uint64_t *ntp_time) {'
    video = once(video, anchor, anchor + '\n    if (g_atomic_int_get(&mgu_hls_owner) != 0) return 0;')
    video = once(video, '''void video_renderer_destroy() {
    for (int i = 0; i < n_renderers; i++) {
        if (renderer_type[i]) {
            video_renderer_destroy_instance(renderer_type[i]);
        }
    }
}''', '''void video_renderer_destroy() {
    if (!hls_video && g_atomic_int_get(&mgu_hls_owner) != 1) g_atomic_int_set(&mgu_hls_owner, 2);
    renderer = NULL;
    for (int i = 0; i < n_renderers; i++) {
        video_renderer_t *old = renderer_type[i];
        renderer_type[i] = NULL;
        if (old) video_renderer_destroy_instance(old);
    }
}''')
    video = once(video, 'if (hls_video && renderer->eos)', 'if (hls_video && renderer && renderer->eos)')
    video = once(video, 'bool video_renderer_eos_watch() {', '''bool video_renderer_eos_watch() {
    if (g_atomic_int_compare_and_exchange(&mgu_hls_stop_requested, 1, 0)) return true;''')
    anchor = '        if (!hls_video || closed_window) {'
    video = once(video, anchor, '''        if (hls_video && !closed_window) {
            mgu_hls_play_requested = FALSE;
            gst_element_set_state(renderer->pipeline, GST_STATE_READY);
            renderer->eos = TRUE;
            g_print("MGU_MEDIA_FAILED\\n"); fflush(stdout);
        }
''' + anchor)
    video = once(video, '    *rate = 0.0f;\n    if (!renderer) {',
                 '    *rate = 0.0f;\n    *buffer_empty = true;\n    *buffer_full = false;\n    if (!renderer || !hls_video) {')
    lock_code = '''
static GRecMutex mgu_renderer_mutex;
static void mgu_renderer_unlock(GRecMutex **lock) { g_rec_mutex_unlock(*lock); }
#define MGU_RENDER_GUARD GRecMutex *mgu_lock __attribute__((cleanup(mgu_renderer_unlock))) = &mgu_renderer_mutex; g_rec_mutex_lock(mgu_lock)
'''
    video = once(video, 'static GstClockTime gst_video_pipeline_base_time', lock_code + '\nstatic GstClockTime gst_video_pipeline_base_time')
    # Packet delivery and control requests run on different threads from
    # renderer rebuilding. Protect their pointer lifetimes, including early returns.
    pattern = r'(?m)^((?:static\s+)?(?:void|bool|int|unsigned int|uint64_t|gboolean)\s+(video_renderer_[a-z_]+|video_get_playback_info|waiting_for_x11_window|gstreamer_video_pipeline_bus_callback)\s*\([^;]*?\)\s*\{)'
    def guard(match):
        if match.group(2) in ['video_renderer_is_hls_active', 'video_renderer_begin_hls_transition']:
            return match.group(0)  # Atomic ownership query must not block HTTP playlist requests.
        return match.group(0) + '\n    MGU_RENDER_GUARD;'
    video = re.sub(pattern, guard, video)
    header = (upstream / 'renderers/video_renderer.h').read_text()
    header = once(header, 'void video_renderer_start ();',
                  'bool video_renderer_is_hls_active(void);\nvoid video_renderer_begin_hls_transition(void);\nvoid video_renderer_request_hls_stop(void);\nvoid video_renderer_start ();')
    (source / 'renderers/video_renderer.h').write_text(header)
    video += '''
void video_renderer_request_hls_stop(void) {
    /* The HTTP thread also serves local HLS GETs. Never take the renderer
     * lock or change pipeline state here: teardown can await such a GET.
     * GLib's EOS/reset callback performs the actual state change. */
    g_atomic_int_set(&mgu_hls_stop_requested, 1);
}
'''

    anchor = 'extern "C" void video_reset(void *cls, reset_type_t type) {'
    ux = once(ux, anchor, anchor + '\n    if ((type == RESET_TYPE_RTP_SHUTDOWN || type == RESET_TYPE_RTP_TO_HLS_TEARDOWN) && video_renderer_is_hls_active()) return;')
    for name in ['video_pause', 'video_resume', 'video_flush']:
        anchor = 'extern "C" void ' + name + ' (void *cls) {'
        ux = once(ux, anchor, anchor + '\n    if (video_renderer_is_hls_active()) return;')
    for anchor in [
        'extern "C" void audio_process (void *cls, raop_ntp_t *ntp, audio_decode_struct *data) {',
        'extern "C" void audio_get_format (void *cls, unsigned char *ct, unsigned short *spf, bool *usingScreen, bool *isMedia, uint64_t *audioFormat) {',
        'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {',
    ]:
        ux = once(ux, anchor, anchor + '\n    if (video_renderer_is_hls_active()) return;')
    # A mirror stream can remain connected throughout HLS; after HLS ends,
    # choose its renderer from incoming packet metadata even without a new SETUP.
    anchor = 'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {\n    if (video_renderer_is_hls_active()) return;'
    ux = once(ux, anchor, anchor + '\n    if (use_video && video_renderer_choose_codec(false, data->is_h265) < 0) return;')
    anchor = 'extern "C" void on_video_play(void *cls, const char* location, const float start_position) {'
    ux = once(ux, anchor, anchor + '\n    video_renderer_begin_hls_transition();')
    anchor = 'extern "C" void on_video_stop(void *cls) {'
    at = ux.index(anchor)
    before, after = ux[:at], ux[at:]
    after = once(after, '    video_renderer_hls_ready();', '    video_renderer_request_hls_stop();')
    ux = before + after
    anchor = '        audio_renderer_render_buffer(data->data, &(data->data_len), &(data->seqnum), &(data->ntp_time_remote));'
    ux = once(ux, anchor, '''        unsigned char mgu_audio_codec = (unsigned char)data->ct;
        audio_renderer_start(&mgu_audio_codec);
''' + anchor)
    anchor = 'extern "C" void on_video_rate(void *cls, const float rate) {'
    ux = once(ux, anchor, anchor + '\n    if (rate == 1.0f) { printf("MGU_MEDIA_PLAY\\n"); fflush(stdout); }')
    ux = once(ux, '    return (float) position;', '    video_renderer_request_hls_stop();\n    return (float) position;')
    ux = once(ux, '    playback_info->ready_to_play = true; //?',
              '    playback_info->ready_to_play = (playback_info->position >= 0.0 && !playback_info->playback_buffer_empty);')
    ux = once(ux, '    playback_info->playback_likely_to_keep_up = true; //?',
              '    playback_info->playback_likely_to_keep_up = playback_info->playback_buffer_full;')
    anchor = 'extern "C" int video_set_codec(void *cls, video_codec_t codec) {'
    ux = once(ux, anchor, '''extern "C" bool mgu_hls_active(void *cls) { (void) cls; return video_renderer_is_hls_active(); }
''' + anchor)
    ux = once(ux, '    raop_cbs.video_set_codec = video_set_codec;',
              '    raop_cbs.video_set_codec = video_set_codec;\n    raop_cbs.is_hls_active = mgu_hls_active;')
    anchor = 'static gboolean feedback_callback(gpointer loop) {'
    ux = once(ux, anchor, anchor + '''
    /* HLS playback uses its own control channel, not mirror /feedback polls. */
    if (video_renderer_is_hls_active()) { missed_feedback = 0; return TRUE; }''')
    raop_header = (upstream / 'lib/raop.h').read_text()
    raop_header = once(raop_header, '    int   (*video_set_codec)(void *cls, video_codec_t codec);',
                       '    bool  (*is_hls_active)(void *cls);\n    int   (*video_set_codec)(void *cls, video_codec_t codec);')
    (source / 'lib/raop.h').write_text(raop_header)
    handlers = (upstream / 'lib/raop_handlers.h').read_text()
    anchor = '                raop_destroy_airplay_video(raop, -1);  //cleanup any hls data still present when mirror video starts'
    handlers = once(handlers, anchor, '''                /* Background iPhone mirroring must not delete the active HLS playlists. */
                if (!raop->callbacks.is_hls_active || !raop->callbacks.is_hls_active(raop->callbacks.cls))
                    raop_destroy_airplay_video(raop, -1);''')
    (source / 'lib/raop_handlers.h').write_text(handlers)
    raop = (upstream / 'lib/raop.c').read_text()
    raop = once(raop, '    hls_request =  (host && !cseq && !client_session_id);',
                '    hls_request = (host && !cseq && !client_session_id && !strcmp(method, "GET") && strcmp(url, "/server-info") && strcmp(url, "/playback-info"));')
    anchor = '''                    httpd_remove_known_connections(raop->httpd);
                    if (raop->callbacks.video_reset) {
                        raop->callbacks.video_reset(raop->callbacks.cls, RESET_TYPE_NOHOLD);
                    }'''
    raop = once(raop, anchor, '''                    if (raop->callbacks.is_hls_active && raop->callbacks.is_hls_active(raop->callbacks.cls)) {
                        /* Replace only the mirror connection, preserving HLS/PTTH control. */
                        httpd_remove_connections_by_type(raop->httpd, CONNECTION_TYPE_RAOP);
                    } else {
                        httpd_remove_known_connections(raop->httpd);
                        if (raop->callbacks.video_reset)
                            raop->callbacks.video_reset(raop->callbacks.cls, RESET_TYPE_NOHOLD);
                    }''')
    raop = once(raop, '''    assert (id >= 0);
    raop_destroy_airplay_video(raop, id);''', '''    /* playlistRemove may already have cleared current_video. */
    if (id >= 0) raop_destroy_airplay_video(raop, id);''')
    (source / 'lib/raop.c').write_text(raop)
    mirror = (upstream / 'lib/raop_rtp_mirror.c').read_text()
    anchor = '                raop_rtp_mirror->callbacks.video_process(raop_rtp_mirror->callbacks.cls, raop_rtp_mirror->ntp, &video_data);'
    mirror = once(mirror, anchor, '''                bool mgu_hls_packet = raop_rtp_mirror->callbacks.is_hls_active &&
                    raop_rtp_mirror->callbacks.is_hls_active(raop_rtp_mirror->callbacks.cls);
''' + anchor + '''
                if (sps_pps_len > 0 && (mgu_hls_packet ||
                    (raop_rtp_mirror->callbacks.is_hls_active &&
                     raop_rtp_mirror->callbacks.is_hls_active(raop_rtp_mirror->callbacks.cls))))
                    prepend_sps_pps = true; /* Keep decoder config for resuming the suspended mirror. */''')
    (source / 'lib/raop_rtp_mirror.c').write_text(mirror)
    audio = (upstream / 'renderers/audio_renderer.c').read_text()
    audio_lock = '''
static GRecMutex mgu_audio_mutex;
static void mgu_audio_unlock(GRecMutex **lock) { g_rec_mutex_unlock(*lock); }
#define MGU_AUDIO_GUARD GRecMutex *mgu_lock __attribute__((cleanup(mgu_audio_unlock))) = &mgu_audio_mutex; g_rec_mutex_lock(mgu_lock)
'''
    audio = once(audio, 'static GstClockTime gst_audio_pipeline_base_time', audio_lock + '\nstatic GstClockTime gst_audio_pipeline_base_time')
    pattern = r'(?m)^((?:void|unsigned int)\s+(audio_renderer_[a-z_]+)\s*\([^;]*?\)\s*\{)'
    audio = re.sub(pattern, lambda m: m.group(0) + '\n    MGU_AUDIO_GUARD;', audio)
    audio = once(audio, '#include "audio_renderer.h"', '#include "audio_renderer.h"\n#include "video_renderer.h"')
    anchor = 'void  audio_renderer_start(unsigned char *ct) {\n    MGU_AUDIO_GUARD;'
    audio = once(audio, anchor, anchor + '\n    if (video_renderer_is_hls_active()) return;')
    anchor = 'void audio_renderer_render_buffer(unsigned char* data, int *data_len, unsigned short *seqnum, uint64_t *ntp_time) {\n    MGU_AUDIO_GUARD;'
    audio = once(audio, anchor, anchor + '\n    if (video_renderer_is_hls_active() || !renderer || !renderer->appsrc) return;')
    audio = once(audio, '        if (renderer_type[i]->ct == *ct)', '        if (renderer_type[i] && renderer_type[i]->ct == *ct)')
    anchor = 'static gboolean gstreamer_audio_pipeline_bus_callback(GstBus *bus, GstMessage *message, void *loop) {'
    audio = once(audio, anchor, anchor + '''
    MGU_AUDIO_GUARD;
    /* Queued bus messages may arrive after stop or codec replacement. */
    audio_renderer_t *mgu_active_audio = renderer;
    audio_renderer_t *renderer = NULL;
    for (int i = 0; i < NFORMATS; i++)
        if (renderer_type[i] && renderer_type[i]->bus == bus) renderer = renderer_type[i];
    if (!renderer || renderer != mgu_active_audio || !renderer->pipeline) return TRUE;
''')
    (source / 'renderers/audio_renderer.c').write_text(audio)

    # Isolate each cached video's local master/media URLs. A new /play changes
    # current_video before all its playlists arrive; old requests must still
    # resolve to their own playlist instead of the half-built next video.
    av = (upstream / 'lib/airplay_video.c').read_text()
    av = once(av, '    size_t len = strlen(uri) + strlen(port);', '''    static unsigned int next_route = 0;
    char route[40];
    snprintf(route, sizeof(route), "/mgu-hls-%u", __atomic_add_fetch(&next_route, 1, __ATOMIC_RELAXED));
    size_t len = strlen(uri) + strlen(port) + strlen(route);''')
    av = once(av, '    strcat(airplay_video->local_uri_prefix, port);',
              '    strcat(airplay_video->local_uri_prefix, port);\n    strcat(airplay_video->local_uri_prefix, route);')
    (source / 'lib/airplay_video.c').write_text(av)
    http = (upstream / 'lib/http_handlers.h').read_text()
    at = http.index('static void\nhttp_handler_play(')
    http = http[:at] + '#include "mgu_direct_play.h"\n\n' + http[at:]
    at = http.index('http_handler_play(')
    head, play = http[:at], http[at:]
    brace = play.index('{') + 1
    play = play[:brace] + '\n    printf("MGU_MEDIA_LOADING\\n"); fflush(stdout);\n    if (mgu_direct_play(conn, request, response)) return;' + play[brace:]
    # Some apps append AirPlay metadata such as &subtitleURL to the
    # synthetic master URL. FCUP still receives the original URL; our local
    # playlist route is a canonical path.
    play = once(play, '        strcat(location, uri_suffix);',
                '        strcat(location, "/master.m3u8");')
    http = head + play
    # Apply the namespaced lookup only inside the local HLS GET handler.
    at = http.index('http_handler_hls(')
    prefix, tail = http[:at], http[at:]
    tail = once(tail, '''    if (raop->current_video == -1) {
        logger_log(raop->logger, LOGGER_ERR,"airplay_video playlist  not found");
        http_response_init(response, "HTTP/1.1", 404, "Not Found");
        return;
    }
''', '')
    anchor = '    airplay_video_t *airplay_video = (airplay_video_t *) hls_get_current_video(raop);\n    assert(airplay_video);'
    replacement = '''    airplay_video_t *airplay_video = NULL;
    if (!strncmp(url, "/mgu-hls-", 9)) {
        for (int i = 0; i < MAX_AIRPLAY_VIDEO; i++) {
            if (!raop->airplay_video[i]) continue;
            const char *base = get_uri_local_prefix(raop->airplay_video[i]);
            const char *route = strstr(base, "/mgu-hls-");
            size_t n = route ? strlen(route) : 0;
            if (n && !strncmp(url, route, n) && url[n] == '/') {
                airplay_video = raop->airplay_video[i]; url += n; break;
            }
        }
    } else if (raop->current_video >= 0) {
        airplay_video = hls_get_current_video(raop);
    }
    if (!airplay_video) {
        http_response_init(response, "HTTP/1.1", 404, "Not Found");
        return;
    }'''
    tail = once(tail, anchor, replacement)
    tail = once(tail, '    if (!strcmp(url, "/master.m3u8")){',
                '    if (!strncmp(url, "/master.m3u8", 12) && (url[12] == \'&\' || url[12] == \'?\')) url = "/master.m3u8";\n    if (!strcmp(url, "/master.m3u8")){')
    (source / 'lib/http_handlers.h').write_text(prefix + tail)
    return ux, video
