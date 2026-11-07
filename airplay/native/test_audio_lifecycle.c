/* Exercise the real audio renderer while packet delivery races with stop. */
#include "../../.build/airplay/uxplay-source/renderers/audio_renderer.c"
void logger_log(logger_t *l, int level, const char *fmt, ...) {(void)l;(void)level;(void)fmt;}
static gint feeding = 1, delivered = 0;
static gint hls_blocked = 0;
bool video_renderer_is_hls_active(void) {return g_atomic_int_get(&hls_blocked)!=0;}
static gpointer packets(gpointer ignored) {
    (void)ignored;
    unsigned char data[16] = {0x8c}; unsigned short seq = 0;
    while (g_atomic_int_get(&feeding)) {
        unsigned char ct = 8; audio_renderer_start(&ct);
        int length = sizeof data; uint64_t time = (uint64_t)g_get_monotonic_time() * 1000;
        audio_renderer_render_buffer(data,&length,&seq,&time);
        g_atomic_int_inc(&delivered); g_usleep(50);
    }
    return NULL;
}
int main(int argc, char **argv) {
    gst_init(&argc,&argv); aac = TRUE; format[0] = "test";
    audio_renderer_t r = {0};
    r.ct = 8; r.pipeline = gst_parse_launch("appsrc name=audio_source ! fakesink sync=false",NULL);
    r.appsrc = gst_bin_get_by_name(GST_BIN(r.pipeline),"audio_source");
    r.bus = gst_element_get_bus(r.pipeline);
    renderer_type[0] = &r;
    GThread *thread = g_thread_new("audio-packets",packets,NULL);
    unsigned char ct = 8;
    for (int i=0;i<100;i++) {
        audio_renderer_start(&ct); g_usleep(500); audio_renderer_stop();
        g_atomic_int_set(&hls_blocked,1); audio_renderer_stop();
        audio_renderer_start(&ct); g_assert_null(renderer);
        g_atomic_int_set(&hls_blocked,0);
    }
    g_atomic_int_set(&feeding,0); g_thread_join(thread);
    audio_renderer_stop();
    g_assert_cmpint(g_atomic_int_get(&delivered),>,0);
    g_assert_null(renderer);
    /* A late bus error from an old renderer must not dereference the active
       renderer (which is NULL after stop). */
    GError *error = g_error_new_literal(GST_STREAM_ERROR,GST_STREAM_ERROR_FAILED,"old pipeline");
    GstMessage *message = gst_message_new_error(GST_OBJECT(r.pipeline),error,"test");
    g_assert(gstreamer_audio_pipeline_bus_callback(r.bus,message,NULL));
    renderer_type[0] = NULL;
    gst_message_unref(message);g_error_free(error);
    gst_object_unref(r.bus);gst_object_unref(r.appsrc);gst_object_unref(r.pipeline);
    g_print("Concurrent audio packet delivery during 100 stop/start cycles and late bus event passed\n");
    return 0;
}
