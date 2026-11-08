#include <gst/gst.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
enum { GST_PLAY_FLAG_DOWNLOAD = 1 << 7 };
#include "mgu_hls_output.h"
static unsigned audio_buffers = 0;
static void viewport_file_test(void) {
    gchar directory[] = "/tmp/mgu-hls-viewport-XXXXXX";
    g_assert_nonnull(g_mkdtemp(directory));
    gchar *file = g_build_filename(directory, "viewport", NULL);
    gchar *link = g_build_filename(directory, "link", NULL);
    int fd = open(file, O_RDWR | O_CREAT | O_EXCL, 0600);
    g_assert_cmpint(fd, >=, 0);
    guint width = 16, height = 16;
    guint32 words[] = {GUINT32_TO_LE(1920), GUINT32_TO_LE(720), 0};
    g_assert_cmpint(write(fd, words, 8), ==, 8);
    g_assert(mgu_hls_viewport_read(file, &width, &height));
    g_assert_cmpuint(width, ==, 1920); g_assert_cmpuint(height, ==, 720);
    g_assert_cmpint(chmod(file, 0644), ==, 0);
    g_assert(!mgu_hls_viewport_read(file, &width, &height));
    g_assert_cmpint(chmod(file, 0600), ==, 0);
    g_assert_cmpint(symlink(file, link), ==, 0);
    g_assert(!mgu_hls_viewport_read(link, &width, &height));
    g_assert_cmpint(unlink(link), ==, 0);
    g_assert_cmpint(linkat(AT_FDCWD, file, AT_FDCWD, link, 0), ==, 0);
    g_assert(!mgu_hls_viewport_read(file, &width, &height));
    g_assert_cmpint(unlink(link), ==, 0);
    g_assert_cmpint(ftruncate(fd, 7), ==, 0);
    g_assert(!mgu_hls_viewport_read(file, &width, &height));
    g_assert_cmpint(ftruncate(fd, 9), ==, 0);
    g_assert(!mgu_hls_viewport_read(file, &width, &height));
    g_assert_cmpint(ftruncate(fd, 8), ==, 0);
    const guint invalid[][2] = {{15, 720}, {1921, 720}, {2050, 720}, {2048, 1082}, {1920, 0}};
    for (guint i = 0; i < G_N_ELEMENTS(invalid); ++i) {
        words[0] = GUINT32_TO_LE(invalid[i][0]); words[1] = GUINT32_TO_LE(invalid[i][1]);
        g_assert_cmpint(pwrite(fd, words, 8, 0), ==, 8);
        g_assert(!mgu_hls_viewport_read(file, &width, &height));
        g_assert_cmpuint(width, ==, 1920); g_assert_cmpuint(height, ==, 720);
    }
    close(fd); g_assert_cmpint(unlink(file), ==, 0);
    g_assert_cmpint(mkfifo(file, 0600), ==, 0);
    g_assert(!mgu_hls_viewport_read(file, &width, &height));
    g_assert_cmpint(unlink(file), ==, 0); g_assert_cmpint(rmdir(directory), ==, 0);
    g_free(file); g_free(link);
    g_print("Viewport file: bounded dimensions, exact size, private permissions, link/FIFO rejection and unchanged last target passed\n");
}
static void output_gone(gpointer data, GObject *object) {
    (void)object;
    g_atomic_int_inc((gint *)data);
}

static guint descriptor_count(void) {
    GDir *directory = g_dir_open("/proc/self/fd", 0, NULL);
    g_assert_nonnull(directory);
    guint count = 0;
    while (g_dir_read_name(directory)) count++;
    g_dir_close(directory);
    return count;
}

static void lifetime_test(void) {
    const gchar *requested = g_getenv("MGU_HLS_TEST_RESETS");
    if (!requested) return;
    const guint iterations = (guint)atoi(requested);
    g_assert(iterations > 0 && iterations <= 1000);
    GstElement *warmup = gst_element_factory_make("playbin3", NULL);
    g_assert_nonnull(warmup); mgu_hls_output(warmup); gst_object_unref(warmup);
    gint destroyed = 0;
    guint descriptors = descriptor_count();
    for (guint i = 0; i < iterations; ++i) {
        GstElement *player = gst_element_factory_make("playbin3", NULL);
        g_assert_nonnull(player);
        mgu_hls_output(player);
        GstElement *filter = NULL, *audio = NULL;
        g_object_get(player, "video-filter", &filter, "audio-sink", &audio, NULL);
        GstElement *capsfilter = gst_bin_get_by_name(GST_BIN(filter), "mgu-hls-viewport-output");
        GstElement *input = gst_bin_get_by_name(GST_BIN(filter), "mgu-hls-viewport-input");
        g_object_weak_ref(G_OBJECT(filter), output_gone, &destroyed);
        g_object_weak_ref(G_OBJECT(audio), output_gone, &destroyed);
        g_object_weak_ref(G_OBJECT(capsfilter), output_gone, &destroyed);
        g_object_weak_ref(G_OBJECT(input), output_gone, &destroyed);
        gst_object_unref(input); gst_object_unref(capsfilter);
        gst_object_unref(filter); gst_object_unref(audio);
        gst_element_set_state(player, GST_STATE_NULL);
        gst_object_unref(player);
        g_assert_cmpint(g_atomic_int_get(&destroyed), ==, 4 * (gint)(i + 1));
    }
    g_assert_cmpuint(descriptor_count(), ==, descriptors);
    g_print("%u HLS filter lifecycle cycles released audio/filter/pad-probe/caps objects and retained no file descriptors\n", iterations);
}

typedef struct { const gchar *frames, *viewport; guint width, height; } Resize;
static gpointer resize_playing(gpointer data) {
    Resize *resize = (Resize *)data;
    guint32 header[16] = {0};
    gint64 deadline = g_get_monotonic_time() + 15000000;
    gboolean received = FALSE;
    while (g_get_monotonic_time() < deadline) {
        int fd = open(resize->frames, O_RDONLY | O_NOFOLLOW);
        if (fd >= 0) {
            received = read(fd, header, sizeof header) == (ssize_t)sizeof header && header[4] > 0;
            close(fd);
        }
        if (received) break;
        g_usleep(10000);
    }
    g_assert(received);
    /* Change an already PLAYING stream after it has presented real buffers. */
    g_usleep(300000);
    gchar *temporary = g_strdup_printf("%s.resize-%d", resize->viewport, getpid());
    int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    g_assert_cmpint(fd, >=, 0);
    guint32 words[] = {GUINT32_TO_LE(resize->width), GUINT32_TO_LE(resize->height)};
    g_assert_cmpint(write(fd, words, sizeof words), ==, sizeof words);
    g_assert_cmpint(close(fd), ==, 0);
    g_assert_cmpint(rename(temporary, resize->viewport), ==, 0);
    g_free(temporary);
    return NULL;
}

static void retained_frame(const guint32 *header, const guint8 *frame, gsize bytes) {
    const gchar *destination = g_getenv("MGU_HLS_TEST_FRAME_FILE");
    if (!destination || destination[0] != '/') return;
    int fd = open(destination, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    g_assert_cmpint(fd, >=, 0);
    guint32 single[16]; memcpy(single, header, sizeof single);
    single[5] = 0; single[6] = 1;
    g_assert_cmpint(write(fd, single, sizeof single), ==, sizeof single);
    g_assert_cmpint(write(fd, frame, bytes), ==, (ssize_t)bytes);
    g_assert_cmpint(close(fd), ==, 0);
    g_print("Retained actual native output frame: %s\n", destination);
}
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
    gst_init(&argc, &argv); g_assert(argc == 4 || argc == 5);
    viewport_file_test();
    lifetime_test();
    const guint source_width = atoi(argv[2]), source_height = atoi(argv[3]);
    const gboolean legacy_playbin = argc == 5;
    g_assert(source_width > 0 && source_height > 0);
    gchar *path = g_strdup_printf("/dev/shm/mgu-video-hls-test-%d", getpid());
    GstElement *player = gst_element_factory_make(legacy_playbin ? "playbin" : "playbin3", NULL);
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
    Resize resize = {path, g_getenv("MGU_HLS_VIEWPORT_FILE"), 0, 0};
    const gchar *resize_to = g_getenv("MGU_HLS_TEST_RESIZE");
    if (resize_to) {
        g_assert_cmpint(sscanf(resize_to, "%ux%u", &resize.width, &resize.height), ==, 2);
        g_assert(mgu_hls_viewport_valid(resize.width, resize.height));
        g_assert_nonnull(resize.viewport);
    }
    g_assert(gst_element_set_state(player, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);
    GThread *resizer = resize_to ? g_thread_new("viewport-test", resize_playing, &resize) : NULL;
    GstMessage *message = gst_bus_timed_pop_filtered(bus, 30 * GST_SECOND, GST_MESSAGE_EOS | GST_MESSAGE_ERROR);
    g_assert_nonnull(message);
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *error = NULL; gchar *debug = NULL;
        gst_message_parse_error(message, &error, &debug);
        g_printerr("%s: %s\n", error->message, debug ? debug : "");
        gst_element_set_state(player, GST_STATE_NULL); gst_object_unref(player); g_free(path); return 2;
    }
    if (resizer) g_thread_join(resizer);
    g_assert_cmpuint(audio_buffers, >, 0);
    if (legacy_playbin) {
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
    g_assert_cmpint(fd, >=, 0); g_assert_cmpint(read(fd, header, 64), ==, 64);
    guint target_width = 1920, target_height = 720;
    mgu_hls_viewport_read(g_getenv("MGU_HLS_VIEWPORT_FILE"), &target_width, &target_height);
    g_assert_cmpuint(header[2], ==, target_width); g_assert_cmpuint(header[3], ==, target_height);
    g_assert_cmpuint(header[4], >, 0);
    const guint width = header[2], height = header[3];
    const gsize frame_bytes = (gsize)width * height * 3 / 2;
    guint8 *luma = g_malloc(frame_bytes);
    const off_t slot = 64 + header[5] * width * height * 3 / 2;
    g_assert_cmpint(pread(fd, luma, frame_bytes, slot), ==, (ssize_t)frame_bytes);
    close(fd);
    /* Fixtures have four distinct corner patches plus an asymmetric gradient.
       Check the whole source mapped independently on both axes. A central
       crop loses the corner patches; contain adds bars; proportional scaling
       cannot satisfy this matrix for source aspects other than 80:21. */
    const guint xs[] = {8, width / 2, width - 9}, ys[] = {8, height / 2, height - 9};
    for (guint iy = 0; iy < G_N_ELEMENTS(ys); ++iy) {
        for (guint ix = 0; ix < G_N_ELEMENTS(xs); ++ix) {
            const double x = (xs[ix] + 0.5) / width;
            const double y = (ys[iy] + 0.5) / height;
            const gint expected = x < 0.125 && y < 0.125 ? 40 :
                x > 0.875 && y < 0.125 ? 88 :
                x < 0.125 && y > 0.875 ? 160 :
                x > 0.875 && y > 0.875 ? 208 : 64 + 72 * x + 40 * y;
            const gint actual = luma[ys[iy] * width + xs[ix]];
            if (ABS(expected - actual) > 6)
                g_error("%ux%u complete-source stretch pixel %u,%u: expected Y=%d, got %d",
                        source_width, source_height, xs[ix], ys[iy], expected, actual);
        }
    }
    for (guint x = 0; x < width; ++x) {
        g_assert_cmpuint(luma[x], >, 30);
        g_assert_cmpuint(luma[(height - 1) * width + x], >, 30);
    }
    for (guint y = 0; y < height; ++y) {
        g_assert_cmpuint(luma[y * width], >, 30);
        g_assert_cmpuint(luma[y * width + width - 1], >, 30);
    }
    retained_frame(header, luma, frame_bytes);
    g_free(luma);
    gst_element_set_state(player, GST_STATE_NULL);
    gst_message_unref(message); gst_object_unref(bus); gst_object_unref(pad);
    gst_object_unref(probe); gst_object_unref(audio); gst_object_unref(player);
    g_assert_cmpint(access(path, F_OK), ==, -1); g_free(path);
    g_print("HLS %ux%u → %ux%u: viewport-matched I420 stretch with all four source corners and no added bars/crop, 8-channel 48 kHz S16LE audio, EOS and cleanup passed\n",
            source_width, source_height, width, height);
    return 0;
}
