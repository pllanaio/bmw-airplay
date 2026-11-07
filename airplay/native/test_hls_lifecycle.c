/* Compile against the actual privately patched renderer, not a mock of it. */
#ifndef MGU_RENDERER_TEST_SOURCE
#define MGU_RENDERER_TEST_SOURCE "../../.build/airplay/uxplay-source/renderers/video_renderer.c"
#endif
#include MGU_RENDERER_TEST_SOURCE
void logger_log(logger_t *l, int level, const char *fmt, ...) { (void)l; (void)level; (void)fmt; }
int logger_get_level(logger_t *l) { (void)l; return LOGGER_WARNING; }
static gint feeding = 1;
static GMutex stop_mutex;
static GCond stop_condition;
static gboolean stop_returned = FALSE;
static gpointer request_stop(gpointer ignored) {
    (void) ignored;
    video_renderer_request_hls_stop();
    g_mutex_lock(&stop_mutex); stop_returned = TRUE;
    g_cond_signal(&stop_condition); g_mutex_unlock(&stop_mutex);
    return NULL;
}
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
    /* A sender can replace an item before the GLib EOS watcher runs. The
     * previous pipeline's pending EOS must never finish that successor. */
    r->eos = TRUE; g_atomic_int_set(&mgu_hls_natural_end, 1);
    video_renderer_begin_hls_transition();
    g_assert(!video_renderer_eos_watch());
    g_atomic_int_set(&mgu_hls_pipeline_generation, g_atomic_int_get(&mgu_hls_generation));
    g_assert(video_renderer_eos_watch());
    g_assert(!video_renderer_hls_completed());
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
    /* The HTTP thread serves the HLS GET that a renderer teardown may await.
       Its stop request must complete even while GLib owns the renderer lock;
       only the GLib EOS/reset watcher may perform the pipeline state change. */
    g_atomic_int_set(&mgu_hls_natural_end, 1);
    g_rec_mutex_lock(&mgu_renderer_mutex);
    GThread *stopper = g_thread_new("http-stop", request_stop, NULL);
    g_mutex_lock(&stop_mutex);
    gint64 stop_deadline = g_get_monotonic_time() + 2 * G_TIME_SPAN_SECOND;
    while (!stop_returned && g_cond_wait_until(&stop_condition, &stop_mutex, stop_deadline)) {}
    g_assert_true(stop_returned);
    g_mutex_unlock(&stop_mutex);
    g_rec_mutex_unlock(&mgu_renderer_mutex);
    g_thread_join(stopper);
    g_assert(video_renderer_eos_watch());
    g_assert(!video_renderer_hls_completed());
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
    /* A sender can pause immediately after /play, before the GLib rebuild
       has created an HLS pipeline. Initialization must retain that pause. */
    video_renderer_begin_hls_transition(); video_renderer_pause();
    video_renderer_init(NULL, "test", transform, "h264parse", "", "avdec_h264", "videoconvert",
        "fakesink", "", false, false, false, false, 2, "http://127.0.0.1/master.m3u8");
    g_assert(!mgu_hls_play_requested && !g_atomic_int_get(&mgu_hls_desired_play));
    video_renderer_resume(); g_assert(mgu_hls_play_requested);
    video_renderer_destroy();
    video_renderer_begin_hls_transition(); video_renderer_pause();
    video_renderer_begin_hls_transition(); /* A new accepted item replaces the paused reservation. */
    g_assert(g_atomic_int_get(&mgu_hls_desired_play));
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
    g_print("HLS ownership, initial buffering, explicit pause, nonblocking HTTP stop, repeated teardown and late playback queries passed\n");
    g_print("Concurrent mirror packets during 12 mirror/HLS renderer rebuilds passed\n");
    return 0;
}
