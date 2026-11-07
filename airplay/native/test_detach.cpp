/* Exercise the actual patched UxPlay callbacks; renderers are linked normally.
   No iPhone, media source or OAP SDK is needed. */
#define main mgu_upstream_main
#include "../../.build/airplay/uxplay-source/uxplay.cpp"
#undef main
#include <cassert>
#include <gst/gst.h>

static void finish_and_rebuild(void) {
    video_reset(NULL, RESET_TYPE_HLS_EOS);
    assert(url.empty());
    assert(preserve_connections);
    video_renderer_start();
    assert(!video_renderer_is_hls_active());
    reset_loop = false;
}

int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    render_logger = logger_init();
    raop_callbacks_t callbacks = {};
    callbacks.audio_process = audio_process;
    callbacks.video_process = video_process;
    raop = raop_init(&callbacks);
    assert(raop);
    assert(raop_init2(raop, 0, "02:00:00:00:00:01", "") == 0);
    videoflip_t transform[2] = { NONE, NONE };
    video_renderer_init(render_logger, "detach-test", transform, "h264parse", "", "avdec_h264", "videoconvert",
                        "fakesink", "", false, false, false, false, 2, NULL);
    video_renderer_start();
    use_video = false;
    use_audio = false;
    hls_support = false;
    video_decode_struct packet = {};
    /* Direct media owns its renderer independently of mirror transport. */
    on_video_play(NULL, "http://127.0.0.1/direct.m3u8", 0.0f);
    assert(video_renderer_is_hls_active());
    assert(!mgu_is_detached());
    assert(!g_atomic_int_get(&mgu_return_mirror));
    reset_loop = false;
    video_reset(NULL, RESET_TYPE_RTP_SHUTDOWN);
    video_reset(NULL, RESET_TYPE_RTP_TO_HLS_TEARDOWN);
    assert(!reset_loop && url == "http://127.0.0.1/direct.m3u8");
    on_video_rate(NULL, 0.0f); /* A pause is no longer swallowed for either origin. */
    assert(!reset_loop && !url.empty());
    on_video_rate(NULL, 1.0f);
    mgu_signal_detach(NULL); /* A legacy background signal cannot change origin. */
    assert(!g_atomic_int_get(&mgu_return_mirror));
    on_video_stop(NULL);
    assert(reset_loop && url.empty() && preserve_connections);
    assert(!g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();

    /* Late packets, codec metadata and sounds must not start mirroring after
       direct video. Check the early return before even dereferencing data. */
    video_process(NULL, NULL, NULL);
    audio_process(NULL, NULL, NULL);
    audio_get_format(NULL, NULL, NULL, NULL, NULL, NULL);
    assert(video_set_codec(NULL, VIDEO_CODEC_H264) == 0);
    assert(!g_atomic_int_get(&mgu_mirror_active));
    on_video_play(NULL, "http://127.0.0.1/direct-next.m3u8", 0.0f);
    mgu_mirror_start(NULL); /* Background mirror SETUP during media is not intent. */
    assert(!g_atomic_int_get(&mgu_allow_mirror));
    assert(!g_atomic_int_get(&mgu_return_mirror));
    mgu_signal_stop_video(NULL);
    assert(url.empty() && !g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();

    /* FCUP first requests the sender's playlists; on_video_play has not run
       yet. The accepted request must already capture origin and be stoppable. */
    mgu_mirror_start(NULL); video_process(NULL, NULL, &packet);
    mgu_video_loading(NULL);
    assert(g_atomic_int_get(&mgu_pending_origin) && g_atomic_int_get(&mgu_return_mirror));
    mgu_signal_stop_video(NULL);
    assert(!g_atomic_int_get(&mgu_pending_origin) && g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();
    mgu_video_loading(NULL);
    assert(!g_atomic_int_get(&mgu_return_mirror));
    mgu_signal_stop_video(NULL);
    assert(!g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();

    /* A new explicit mirror SETUP enables packet delivery again; origin is
       recorded only by an actual packet, never by codec metadata alone. */
    mgu_mirror_start(NULL);
    assert(g_atomic_int_get(&mgu_allow_mirror));
    assert(!g_atomic_int_get(&mgu_mirror_active));
    video_process(NULL, NULL, &packet);
    on_video_play(NULL, "http://127.0.0.1/from-mirror.m3u8", 0.0f);
    assert(mgu_is_detached());
    assert(g_atomic_int_get(&mgu_return_mirror));
    reset_loop = false;
    video_reset(NULL, RESET_TYPE_RTP_SHUTDOWN);
    video_reset(NULL, RESET_TYPE_RTP_TO_HLS_TEARDOWN);
    on_video_playlist_remove(NULL); /* Queue cleanup alone is non-authoritative. */
    assert(mgu_is_detached() && !reset_loop);
    assert(url == "http://127.0.0.1/from-mirror.m3u8");
    on_video_rate(NULL, 0.0f);
    assert(!reset_loop && !url.empty());
    on_video_rate(NULL, 1.0f);
    on_video_stop(NULL);
    assert(reset_loop && url.empty() && preserve_connections);
    assert(g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();
    assert(!mgu_is_detached());
    assert(!g_atomic_int_get(&mgu_mirror_active));

    /* An explicit HLS TEARDOWN must stop mirror-origin media too, including
       an item still loading before its own renderer has been created. */
    video_process(NULL, NULL, &packet);
    on_video_play(NULL, "http://127.0.0.1/loading.m3u8", 0.0f);
    reset_loop = false;
    video_reset(NULL, RESET_TYPE_HLS_SHUTDOWN);
    assert(reset_loop && url.empty() && preserve_connections);
    assert(g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();

    /* Natural mirror-origin end permits resumed mirror packets. Natural
       direct end and direct playlistRemove retain waiting mode. */
    video_process(NULL, NULL, &packet);
    on_video_play(NULL, "http://127.0.0.1/natural-mirror.m3u8", 0.0f);
    finish_and_rebuild();
    assert(g_atomic_int_get(&mgu_allow_mirror));
    on_video_play(NULL, "http://127.0.0.1/later-direct.m3u8", 0.0f);
    assert(!mgu_is_detached());
    finish_and_rebuild();
    assert(!g_atomic_int_get(&mgu_allow_mirror));
    on_video_play(NULL, "http://127.0.0.1/direct-removed.m3u8", 0.0f);
    reset_loop = false;
    on_video_playlist_remove(NULL);
    assert(reset_loop && url.empty() && !g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();

    /* The head-unit end button honors origin; the separate mirror button
       is an explicit override, even when the video was started directly. */
    mgu_mirror_start(NULL); video_process(NULL, NULL, &packet);
    on_video_play(NULL, "http://127.0.0.1/button-mirror.m3u8", 0.0f);
    mgu_signal_stop_video(NULL);
    assert(url.empty() && g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();
    on_video_play(NULL, "http://127.0.0.1/force-mirror.m3u8", 0.0f);
    mgu_signal_resume_mirror(NULL);
    assert(url.empty() && g_atomic_int_get(&mgu_allow_mirror));
    finish_and_rebuild();
    video_renderer_destroy();
    logger_destroy(render_logger);
    raop_destroy(raop);
    puts("Native video origins: independent mirror transport, sender stop/pause, HLS teardown while loading, origin-aware end button, direct waiting gate and explicit mirror restart passed");
}
