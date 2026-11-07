/* Compile against the actual privately patched renderer, not a mock of it. */
#ifndef MGU_RENDERER_TEST_SOURCE
#define MGU_RENDERER_TEST_SOURCE "../../.build/airplay/uxplay-source/renderers/video_renderer.c"
#endif
#include MGU_RENDERER_TEST_SOURCE
void logger_log(logger_t *l, int level, const char *fmt, ...) { (void)l; (void)level; (void)fmt; }
int logger_get_level(logger_t *l) { (void)l; return LOGGER_WARNING; }
static gint feeding = 1;
static gpointer mirror_packets(gpointer ignored) {
    (void)ignored;
    unsigned char packet[] = {0, 0, 0, 1, 0x09, 0xf0}; /* H.264 access-unit delimiter. */
    while (g_atomic_int_get(&feeding)) {
        int length = sizeof packet, count = 1; uint64_t timestamp = (uint64_t)g_get_monotonic_time() * 1000;
        video_renderer_choose_codec(false, false);
        video_renderer_render_buffer(packet, &length, &count, &timestamp);
        g_usleep(100);
    }
    return NULL;
}
int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    hls_video = true; g_atomic_int_set(&mgu_hls_owner, 1);
    g_assert(video_renderer_is_hls_active());
    g_assert_cmpint(video_renderer_choose_codec(false, false), ==, 0);
    /* Incoming RTP must be discarded before dereferencing packet or appsrc. */
    g_assert_cmpuint(video_renderer_render_buffer(NULL, NULL, NULL, NULL), ==, 0);
    video_renderer_t *r = g_new0(video_renderer_t, 1);
    r->pipeline = gst_parse_launch("fakesrc num-buffers=1 ! fakesink", NULL);
    r->bus = gst_element_get_bus(r->pipeline);
    r->codec = hls;
    renderer = r; renderer_type[0] = r; n_renderers = 1;
    hls_buffer_full = FALSE;
    video_renderer_resume();
    GstState state;
    gst_element_get_state(r->pipeline, &state, NULL, 0);
    g_assert_cmpint(state, ==, GST_STATE_NULL); /* Early client rate=1 cannot drain an empty buffer. */
    video_renderer_pause();
    GstMessage *buffered = gst_message_new_buffering(GST_OBJECT(r->pipeline), 100);
    gstreamer_video_pipeline_bus_callback(r->bus, buffered, NULL);
    gst_message_unref(buffered);
    gst_element_get_state(r->pipeline, &state, NULL, 100 * GST_MSECOND);
    g_assert_cmpint(state, !=, GST_STATE_PLAYING); /* Buffer fill must respect an explicit pause. */
    video_renderer_destroy();
    g_assert_null(renderer); g_assert_null(renderer_type[0]);
    video_renderer_destroy(); /* Second teardown must not unref freed objects. */
    g_assert(!video_renderer_eos_watch());
    double duration, position, start, span; float rate; bool empty, full;
    g_assert(video_get_playback_info(&duration, &position, &start, &span, &rate, &empty, &full));
    g_assert_cmpfloat(position, ==, -1);
    g_setenv("MGU_HLS_AUDIO_SINK", "fakesink", TRUE);
    g_setenv("G_TLS_CA_FILE", "/etc/ssl/certs/ca-certificates.crt", TRUE);
    videoflip_t transform[2] = {NONE, NONE};
    for (int n = 0; n < 3; n++) {
        video_renderer_init(NULL, "test", transform, "h264parse", "", "avdec_h264", "videoconvert",
            "fakesink", "", false, false, false, false, 2, "http://127.0.0.1/master.m3u8");
        g_assert(video_renderer_is_hls_active()); g_assert_nonnull(renderer);
        g_assert_cmpint(video_renderer_choose_codec(false, true), ==, 0);
        video_renderer_destroy(); video_renderer_destroy();
        g_assert_null(renderer);
    }
    GThread *packets = g_thread_new("mirror-packets", mirror_packets, NULL);
    for (int n = 0; n < 12; n++) {
        video_renderer_init(NULL, "test", transform, "h264parse", "", "avdec_h264", "videoconvert",
            "fakesink", "", false, false, false, false, 2, NULL);
        video_renderer_start(); g_usleep(2000);
        video_renderer_destroy();
        video_renderer_init(NULL, "test", transform, "h264parse", "", "avdec_h264", "videoconvert",
            "fakesink", "", false, false, false, false, 2, "http://127.0.0.1/master.m3u8");
        g_usleep(2000); video_renderer_destroy();
    }
    g_atomic_int_set(&feeding, 0); g_thread_join(packets);
    g_print("HLS ownership, initial buffering, explicit pause, repeated teardown and late playback queries passed\n");
    g_print("Concurrent mirror packets during 12 mirror/HLS renderer rebuilds passed\n");
    return 0;
}
