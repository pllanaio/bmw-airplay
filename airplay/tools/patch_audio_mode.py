"""Detect standalone RAOP audio inside a mixed AirPlay receiver session.

Apply after the lifecycle/media-mode patches. UxPlay's -vs 0 alone only hides
video; it still advertises screen mirroring and HLS capabilities. This profile
also narrows discovery and ignores video callbacks without closing RAOP.
MGU_AUTO_MEDIA=1 instead retains full discovery and follows actual media.
GPL-3.0-or-later.
"""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay audio-only source: ' + old[:80])
    return text.replace(old, new)


def patch(source, ux, video):
    ux = once(ux, 'static bool use_video = true;', '''static bool use_video = true;
static bool mgu_audio_only = false;
static bool mgu_audio_auto = false;
static gint mgu_audio_playing = 0;
static gint mgu_audio_presented = 0;
/* 0 no SETUP, 1 standalone media, 2 screen/video audio, 3 unspecified AAC. */
static gint mgu_audio_kind = 0;
static gint64 mgu_audio_candidate_since = 0;
static GRecMutex mgu_audio_mode_mutex;
struct mgu_audio_mode_guard {
    mgu_audio_mode_guard() { g_rec_mutex_lock(&mgu_audio_mode_mutex); }
    ~mgu_audio_mode_guard() { g_rec_mutex_unlock(&mgu_audio_mode_mutex); }
};''')
    ux = once(ux, 'static int register_dnssd() {', '''/* The sender retains the audio session between songs. State changes describe
 * received audio, never a request to tear down discovery or pairing. */
static void mgu_audio_set_playing(bool playing) {
    if ((!mgu_audio_only && !mgu_audio_auto) || !g_atomic_int_compare_and_exchange(&mgu_audio_playing, !playing, playing)) return;
    if (playing) { g_atomic_int_set(&mgu_audio_presented, 1); printf("MGU_MODE audio\\nMGU_AUDIO_PLAY\\n"); }
    else printf("MGU_AUDIO_WAITING\\n");
    fflush(stdout);
}

static bool mgu_audio_transport_allowed(void) {
    int kind = g_atomic_int_get(&mgu_audio_kind);
    return mgu_audio_only || (mgu_audio_auto && (kind == 1 || kind == 3));
}

static void mgu_audio_format(unsigned char ct, bool screen, bool media) {
    if (!mgu_audio_auto || mgu_audio_only) return;
    mgu_audio_mode_guard guard;
    g_atomic_int_set(&mgu_audio_kind, screen ? 2 : (media || ct == 2) ? 1 : 3);
    mgu_audio_candidate_since = 0;
    /* A new screen transport is video intent, but only an actual video packet
     * announces mirror mode. Never send a late audio WAITING over that mode. */
    if (screen) g_atomic_int_set(&mgu_audio_playing, 0);
}

static void mgu_audio_packet(audio_decode_struct *data) {
    if ((!mgu_audio_only && !mgu_audio_auto) || !data || !data->data || data->data_len <= 0 ||
        video_renderer_is_hls_active()) return;
    mgu_audio_mode_guard guard;
    if (video_renderer_is_hls_active() || g_atomic_int_get(&mgu_pending_origin)) return;
    int kind = g_atomic_int_get(&mgu_audio_kind);
    if (!mgu_audio_only && kind == 3) {
        /* Older senders can omit both booleans. Give video time to arrive,
         * while a paused/static mirror retains ownership without a timeout. */
        if (g_atomic_int_get(&mgu_mirror_active) || g_atomic_int_get(&mgu_pending_origin)) return;
        gint64 now = g_get_monotonic_time();
        if (!mgu_audio_candidate_since) { mgu_audio_candidate_since = now; return; }
        if (now - mgu_audio_candidate_since < 750000) return;
        g_atomic_int_set(&mgu_audio_kind, 1);
        kind = 1;
    }
    if (!mgu_audio_only && kind != 1) return;
    if (!g_atomic_int_get(&mgu_audio_playing)) {
        /* An explicit standalone audio SETUP replaces the previous mirror's
         * origin. A later accepted video packet can take ownership immediately. */
        g_atomic_int_set(&mgu_mirror_active, 0);
    }
    mgu_audio_set_playing(true);
}

static void mgu_audio_video_owner(bool mirror = false) {
    if (!mgu_audio_auto || mgu_audio_only) return;
    mgu_audio_mode_guard guard;
    bool returning_from_audio = g_atomic_int_compare_and_exchange(&mgu_audio_presented, 1, 0);
    g_atomic_int_set(&mgu_audio_kind, 2);
    g_atomic_int_set(&mgu_audio_playing, 0);
    if (mirror) g_atomic_int_set(&mgu_mirror_active, 1);
    mgu_audio_candidate_since = 0;
    /* The mirror pipeline may reuse its already chosen codec after music.
     * Announce this actual packet transition even without another codec event. */
    if (mirror && returning_from_audio) { printf("MGU_MODE mirror\\n"); fflush(stdout); }
}

static bool mgu_audio_standalone(void) {
    return mgu_audio_only || (mgu_audio_auto &&
        (g_atomic_int_get(&mgu_audio_kind) == 1 || g_atomic_int_get(&mgu_audio_playing)));
}

static void mgu_audio_session_end(void) {
    mgu_audio_mode_guard guard;
    mgu_audio_set_playing(false);
    g_atomic_int_set(&mgu_audio_kind, 0);
    mgu_audio_candidate_since = 0;
}

static void mgu_audio_configure(void) {
    const char *setting = getenv("MGU_AUDIO_ONLY");
    mgu_audio_only = setting && !strcmp(setting, "1");
    setting = getenv("MGU_AUTO_MEDIA");
    mgu_audio_auto = setting && !strcmp(setting, "1");
    if (mgu_audio_auto) {
        render_coverart = false; /* UI artwork is decoded outside the RTP thread. */
        printf("MGU_FEATURES auto-media\\n"); fflush(stdout);
    }
    if (!mgu_audio_only) return;
    use_video = false;
    videosink = "0";
    hls_support = false;
    h265_support = false;
    render_coverart = false;
    g_atomic_int_set(&mgu_audio_playing, 0);
    printf("MGU_FEATURES audio-only\\nMGU_MODE audio\\nMGU_AUDIO_WAITING\\n");
    fflush(stdout);
}

static int register_dnssd() {''')
    anchor = '    if (videosink == "0") {'
    ux = once(ux, anchor, '    mgu_audio_configure();\n\n' + anchor)
    anchor = '    dnssd_set_airplay_features(dnssd, 27, (int) setup_legacy_pairing);'
    ux = once(ux, anchor, anchor + '''
    if (mgu_audio_only) {
        /* Video, photos, slideshows, cloud video, mirroring, rotation, photo
         * preload and video queue/codec capabilities do not apply to RAOP.
         * Keep audio formats, FairPlay pairing and Now Playing metadata. */
        const int video_features[] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 33, 34, 42};
        for (unsigned int i = 0; i < sizeof(video_features) / sizeof(video_features[0]); ++i)
            dnssd_set_airplay_features(dnssd, video_features[i], 0);
    }''')
    anchor = 'extern "C" void audio_process (void *cls, raop_ntp_t *ntp, audio_decode_struct *data) {'
    guarded = anchor + '\n    if (!g_atomic_int_get(&mgu_allow_mirror)) return;'
    ux = once(ux, guarded, anchor + '\n    if (!g_atomic_int_get(&mgu_allow_mirror) && !mgu_audio_transport_allowed()) return;')
    # Run after the existing HLS guard so mirror or HLS audio cannot steal the
    # display, even during pending playlist downloads and renderer rebuilds.
    guarded = anchor + '\n    if (!g_atomic_int_get(&mgu_allow_mirror) && !mgu_audio_transport_allowed()) return;\n    if (video_renderer_is_hls_active()) return;'
    ux = once(ux, guarded, guarded + '\n    mgu_audio_packet(data);')
    anchor = 'extern "C" void audio_get_format (void *cls, unsigned char *ct, unsigned short *spf, bool *usingScreen, bool *isMedia, uint64_t *audioFormat) {'
    guarded = anchor + '\n    if (!g_atomic_int_get(&mgu_allow_mirror)) return;'
    ux = once(ux, guarded, anchor + '''
    mgu_audio_format(ct ? *ct : 0, usingScreen && *usingScreen, isMedia && *isMedia);
    if (!g_atomic_int_get(&mgu_allow_mirror) && !mgu_audio_transport_allowed()) return;''')
    anchor = 'extern "C" void audio_flush (void *cls) {'
    ux = once(ux, anchor, anchor + '''
    if (mgu_audio_standalone()) {
        mgu_audio_set_playing(false);
        /* Upstream flush is a no-op. Stop the pipeline to discard queued
         * sound immediately; audio_process restarts it on the next packet. */
        if (use_audio) audio_renderer_stop();
        return;
    }''')
    anchor = 'extern "C" void audio_stop_coverart_rendering(void *cls) {'
    ux = once(ux, anchor, anchor + '''
    /* UxPlay invokes this callback for an audio (type 96) TEARDOWN even
     * when no artwork is displayed. Preserve the receiver for the next song. */
    if (mgu_audio_standalone()) { audio_flush(cls); return; }''')
    anchor = '    if (open_connections == 0) {'
    ux = once(ux, anchor, anchor + '\n        mgu_audio_session_end();')
    for anchor in [
        'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {',
        'extern "C" void on_video_play(void *cls, const char* location, const float start_position) {',
        'extern "C" void video_reset(void *cls, reset_type_t type) {',
    ]:
        ux = once(ux, anchor, anchor + '\n    if (mgu_audio_only) return;')
    anchor = '    g_atomic_int_set(&mgu_mirror_active, 1);'
    ux = once(ux, anchor, anchor + '\n    mgu_audio_video_owner(true);')
    # /play reserves HLS ownership before fetching sender playlists. This must
    # also silence audio state before a late FLUSH can overwrite video loading.
    for anchor in [
        'extern "C" void on_video_play(void *cls, const char* location, const float start_position) {\n    if (mgu_audio_only) return;',
        'extern "C" void mgu_video_loading(void *cls) {',
    ]:
        guard = '\n    if (mgu_audio_only) return;' if 'mgu_video_loading' in anchor else ''
        ux = once(ux, anchor, anchor + guard + '\n    mgu_audio_video_owner();')
    handlers_path = source / 'lib/raop_handlers.h'
    handlers = handlers_path.read_text()
    anchor = '''            raop_rtp_destroy(conn->raop_rtp);
            conn->raop_rtp = NULL;'''
    handlers = once(handlers, anchor, anchor + '''
            /* Untyped TEARDOWN can leave another control connection alive.
             * Report audio end now, rather than waiting for all TCP clients. */
            const char *audio_only = getenv("MGU_AUDIO_ONLY");
            const char *auto_media = getenv("MGU_AUTO_MEDIA");
            if (((audio_only && !strcmp(audio_only, "1")) || (auto_media && !strcmp(auto_media, "1"))) &&
                raop->callbacks.audio_stop_coverart_rendering)
                raop->callbacks.audio_stop_coverart_rendering(raop->callbacks.cls);''')
    handlers_path.write_text(handlers)
    return ux, video
