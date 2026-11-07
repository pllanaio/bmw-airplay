/* Feed a locally generated ALAC packet through the actual audio renderer. */
#include "../../.build/airplay/uxplay-source/renderers/audio_renderer.c"
#include <stdio.h>

void logger_log(logger_t *log, int level, const char *message, ...) {
    (void)log; (void)level; (void)message;
}
bool video_renderer_is_hls_active(void) { return false; }

static gint buffers, decoded_bytes;
static void decoded(GstElement *sink, GstBuffer *buffer, GstPad *pad, gpointer unused) {
    (void)sink; (void)pad; (void)unused;
    g_atomic_int_add(&decoded_bytes, (gint)gst_buffer_get_size(buffer));
    g_atomic_int_inc(&buffers);
}
static void check_errors(void) {
    for (int i = 0; i < NFORMATS; i++) {
        GstMessage *message = gst_bus_pop_filtered(renderer_type[i]->bus, GST_MESSAGE_ERROR);
        if (!message) continue;
        GError *error = NULL; gchar *debug = NULL;
        gst_message_parse_error(message, &error, &debug);
        g_error("Audio decoder error: %s (%s)", error->message, debug ? debug : "");
    }
}
static void play_packets(unsigned char *packet, int length) {
    const gint before = g_atomic_int_get(&buffers);
    const gint bytes_before = g_atomic_int_get(&decoded_bytes);
    unsigned char compression = 2;
    audio_renderer_start(&compression);
    g_assert_nonnull(renderer);
    for (unsigned short sequence = 0; sequence < 8; sequence++) {
        int bytes = length;
        uint64_t time = (uint64_t)g_get_real_time() * 1000;
        audio_renderer_render_buffer(packet, &bytes, &sequence, &time);
    }
    const gint64 deadline = g_get_monotonic_time() + 3 * G_TIME_SPAN_SECOND;
    while (g_atomic_int_get(&buffers) == before && g_get_monotonic_time() < deadline) {
        check_errors();
        g_usleep(1000);
    }
    check_errors();
    g_assert_cmpint(g_atomic_int_get(&buffers), >, before);
    /* One frame contains 352 stereo samples, decoded to at least 16-bit PCM. */
    g_assert_cmpint(g_atomic_int_get(&decoded_bytes) - bytes_before, >=, 352 * 2 * 2);
}
int main(int argc, char **argv) {
    g_assert_cmpint(argc, ==, 2);
    gchar *packet = NULL; gsize bytes = 0;
    g_assert(g_file_get_contents(argv[1], &packet, &bytes, NULL));
    g_assert_cmpuint(bytes, >, 8);
    g_assert_cmpuint(bytes, <, 65536);
    g_assert_cmphex((unsigned char)packet[0], ==, 0x20);
    gst_init(&argc, &argv);
    const bool synchronized = false;
    audio_renderer_init(NULL, "fakesink name=decoded signal-handoffs=true enable-last-sample=false",
                        &synchronized, &synchronized, "");
    for (int i = 0; i < NFORMATS; i++) {
        GstElement *sink = gst_bin_get_by_name(GST_BIN(renderer_type[i]->pipeline), "decoded");
        g_assert_nonnull(sink);
        g_signal_connect(sink, "handoff", G_CALLBACK(decoded), NULL);
        gst_object_unref(sink);
    }
    play_packets((unsigned char *)packet, (int)bytes);
    audio_renderer_stop();
    g_assert_null(renderer);
    /* A stop must allow the next track's packets to resume decoded output. */
    play_packets((unsigned char *)packet, (int)bytes);
    audio_renderer_stop();
    g_assert_null(renderer);
    audio_renderer_destroy();
    g_free(packet);
    g_print("Real ALAC decoding produces PCM before and after audio stop/restart\n");
    return 0;
}
