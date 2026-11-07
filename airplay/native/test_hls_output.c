#include <gst/gst.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
enum { GST_PLAY_FLAG_DOWNLOAD = 1 << 7 };
#include "mgu_hls_output.h"
static unsigned audio_buffers = 0;
static GstPadProbeReturn audio_probe(GstPad *pad, GstPadProbeInfo *info, gpointer data) {
    (void)info; (void)data;
    GstCaps *caps = gst_pad_get_current_caps(pad);
    g_assert_nonnull(caps);
    const GstStructure *s = gst_caps_get_structure(caps, 0);
    gint channels = 0, rate = 0;
    g_assert(gst_structure_get_int(s, "channels", &channels));
    g_assert(gst_structure_get_int(s, "rate", &rate));
    g_assert_cmpint(channels, ==, 8); g_assert_cmpint(rate, ==, 48000);
    g_assert_cmpstr(gst_structure_get_string(s, "format"), ==, "S16LE");
    audio_buffers++; gst_caps_unref(caps); return GST_PAD_PROBE_OK;
}
int main(int argc, char **argv) {
    gst_init(&argc, &argv); g_assert(argc == 2 || argc == 3);
    gchar *path = g_strdup_printf("/dev/shm/mgu-video-hls-test-%d", getpid());
    GstElement *player = gst_element_factory_make(argc == 3 ? "playbin" : "playbin3", NULL);
    GstElement *video = gst_element_factory_make("mguvideosink", NULL);
    g_assert_nonnull(player); g_assert_nonnull(video);
    g_object_set(video, "location", path, NULL);
    g_object_set(player, "video-sink", video, "uri", argv[1], NULL);
    mgu_hls_output(player);
    GstElement *audio = NULL;
    g_object_get(player, "audio-sink", &audio, NULL);
    GstElement *probe = gst_bin_get_by_name(GST_BIN(audio), "mgu-audio-probe");
    g_assert_nonnull(probe);
    GstPad *pad = gst_element_get_static_pad(probe, "sink");
    gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, audio_probe, NULL, NULL);
    GstBus *bus = gst_element_get_bus(player);
    g_assert(gst_element_set_state(player, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);
    GstMessage *message = gst_bus_timed_pop_filtered(bus, 30 * GST_SECOND, GST_MESSAGE_EOS | GST_MESSAGE_ERROR);
    g_assert_nonnull(message);
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *error = NULL; gchar *debug = NULL;
        gst_message_parse_error(message, &error, &debug);
        g_printerr("%s: %s\n", error->message, debug ? debug : "");
        gst_element_set_state(player, GST_STATE_NULL); gst_object_unref(player); g_free(path); return 2;
    }
    g_assert_cmpuint(audio_buffers, >, 0);
    if (argc == 3) {
        GstIterator *it = gst_bin_iterate_recurse(GST_BIN(player));
        GValue value = G_VALUE_INIT; gboolean legacy = FALSE, modern = FALSE;
        while (gst_iterator_next(it, &value) == GST_ITERATOR_OK) {
            GstElementFactory *factory = gst_element_get_factory(g_value_get_object(&value));
            const gchar *name = factory ? gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(factory)) : "";
            legacy |= g_strcmp0(name, "hlsdemux") == 0;
            modern |= g_strcmp0(name, "hlsdemux2") == 0;
            g_value_reset(&value);
        }
        g_value_unset(&value); gst_iterator_free(it);
        g_assert(legacy && !modern);
        g_print("Confirmed legacy hlsdemux, not hlsdemux2\n");
    }
    guint32 header[16]; int fd = open(path, O_RDONLY);
    g_assert_cmpint(fd, >=, 0); g_assert_cmpint(read(fd, header, 64), ==, 64); close(fd);
    g_assert_cmpuint(header[2], ==, 1280); g_assert_cmpuint(header[3], ==, 720);
    g_assert_cmpuint(header[4], >, 0);
    gst_element_set_state(player, GST_STATE_NULL);
    gst_message_unref(message); gst_object_unref(bus); gst_object_unref(pad);
    gst_object_unref(probe); gst_object_unref(audio); gst_object_unref(player);
    g_assert_cmpint(access(path, F_OK), ==, -1); g_free(path);
    g_print("HLS HTTP playback: 720p I420 frames, 8-channel 48 kHz S16LE audio, EOS and cleanup passed\n");
    return 0;
}
