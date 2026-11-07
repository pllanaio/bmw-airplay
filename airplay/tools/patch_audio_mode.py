"""Opt-in RAOP-only receiver profile for the BMW audio route.

Apply after the lifecycle/media-mode patches. UxPlay's -vs 0 alone only hides
video; it still advertises screen mirroring and HLS capabilities. This profile
also narrows discovery and ignores video callbacks without closing RAOP.
GPL-3.0-or-later.
"""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay audio-only source: ' + old[:80])
    return text.replace(old, new)


def patch(source, ux, video):
    ux = once(ux, 'static bool use_video = true;', '''static bool use_video = true;
static bool mgu_audio_only = false;
static gint mgu_audio_playing = 0;''')
    ux = once(ux, 'static int register_dnssd() {', '''/* The sender retains the audio session between songs. State changes describe
 * received audio, never a request to tear down discovery or pairing. */
static void mgu_audio_set_playing(bool playing) {
    if (!mgu_audio_only || !g_atomic_int_compare_and_exchange(&mgu_audio_playing, !playing, playing)) return;
    if (playing) printf("MGU_MODE audio\\nMGU_AUDIO_PLAY\\n");
    else printf("MGU_AUDIO_WAITING\\n");
    fflush(stdout);
}

static void mgu_audio_configure(void) {
    const char *setting = getenv("MGU_AUDIO_ONLY");
    mgu_audio_only = setting && !strcmp(setting, "1");
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
    ux = once(ux, anchor, anchor + '''
    if (mgu_audio_only && data && data->data && data->data_len > 0) mgu_audio_set_playing(true);''')
    anchor = 'extern "C" void audio_flush (void *cls) {'
    ux = once(ux, anchor, anchor + '''
    if (mgu_audio_only) {
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
    if (mgu_audio_only) { audio_flush(cls); return; }''')
    anchor = '    if (open_connections == 0) {'
    ux = once(ux, anchor, anchor + '\n        mgu_audio_set_playing(false);')
    for anchor in [
        'extern "C" void video_process (void *cls, raop_ntp_t *ntp, video_decode_struct *data) {',
        'extern "C" void on_video_play(void *cls, const char* location, const float start_position) {',
        'extern "C" void video_reset(void *cls, reset_type_t type) {',
    ]:
        ux = once(ux, anchor, anchor + '\n    if (mgu_audio_only) return;')
    handlers_path = source / 'lib/raop_handlers.h'
    handlers = handlers_path.read_text()
    anchor = '''            raop_rtp_destroy(conn->raop_rtp);
            conn->raop_rtp = NULL;'''
    handlers = once(handlers, anchor, anchor + '''
            /* Untyped TEARDOWN can leave another control connection alive.
             * Report audio end now, rather than waiting for all TCP clients. */
            const char *audio_only = getenv("MGU_AUDIO_ONLY");
            if (audio_only && !strcmp(audio_only, "1") && raop->callbacks.audio_stop_coverart_rendering)
                raop->callbacks.audio_stop_coverart_rendering(raop->callbacks.cls);''')
    handlers_path.write_text(handlers)
    return ux, video
