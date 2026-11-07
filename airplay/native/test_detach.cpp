/* Exercise the actual patched UxPlay callbacks; renderers are linked normally.
   No iPhone, media source or OAP SDK is needed. */
#define main mgu_upstream_main
#include "../../.build/airplay/uxplay-source/uxplay.cpp"
#undef main
#include <cassert>
#include <gst/gst.h>

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
    /* A direct AirPlay video retains the sender's normal stop controls. */
    on_video_play(NULL, "http://127.0.0.1/direct.m3u8", 0.0f);
    assert(video_renderer_is_hls_active());
    assert(!mgu_is_detached());
    reset_loop = false;
    video_reset(NULL, RESET_TYPE_HLS_SHUTDOWN);
    assert(reset_loop);
    video_reset(NULL, RESET_TYPE_HLS_EOS);
    video_renderer_start();
    /* The real packet callback records mirroring before the HLS request. */
    video_decode_struct packet = {};
    video_process(NULL, NULL, &packet);
    on_video_play(NULL, "http://127.0.0.1/from-mirror.m3u8", 0.0f);
    assert(mgu_is_detached());
    reset_loop = false;
    on_video_rate(NULL, 0.0f);
    on_video_stop(NULL);
    on_video_playlist_remove(NULL);
    video_reset(NULL, RESET_TYPE_HLS_SHUTDOWN);
    assert(mgu_is_detached());
    assert(!reset_loop); /* Immediate backgrounding cannot cancel loading. */
    assert(url == "http://127.0.0.1/from-mirror.m3u8");
    /* A subsequent video from the same suspended mirror is detached too. */
    on_video_play(NULL, "http://127.0.0.1/next.m3u8", 0.0f);
    assert(mgu_is_detached());
    mgu_signal_resume_mirror(NULL);
    assert(!mgu_is_detached());
    video_reset(NULL, RESET_TYPE_HLS_EOS);
    assert(!mgu_is_detached());
    assert(!g_atomic_int_get(&mgu_mirror_active));
    /* An unrelated direct video after the mirror ends is not detached. */
    on_video_play(NULL, "http://127.0.0.1/later-direct.m3u8", 0.0f);
    assert(!mgu_is_detached());
    video_renderer_destroy();
    logger_destroy(render_logger);
    raop_destroy(raop);
    puts("Native mirror-origin detection, immediate phone pause/stop/teardown, video replacement and mirror return passed");
}
