/* Private UxPlay output integration, GPL-3.0-or-later like the enclosing code. */
#include <stdio.h>
#include <gio/gio.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct {
    GstElement *capsfilter;
    gchar *file;
    guint width, height;
    gint64 checked_at;
} MguHlsViewport;

static gboolean mgu_hls_viewport_valid(guint width, guint height) {
    return width >= 16 && height >= 16 && width <= 2048 && height <= 2048 &&
        !(width & 1) && !(height & 1) && (guint64)width * height <= 2048u * 1080u;
}

static gboolean mgu_hls_viewport_read(const gchar *file, guint *width, guint *height) {
    if (!file || file[0] != '/' || strlen(file) > 4095) return FALSE;
    int fd = open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return FALSE;
    struct stat st;
    guint32 words[3];
    gboolean valid = !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_uid == geteuid() &&
        st.st_nlink == 1 && (st.st_mode & 0777) == 0600 && st.st_size == 8;
    ssize_t count = -1;
    if (valid) do { count = pread(fd, words, sizeof words, 0); } while (count < 0 && errno == EINTR);
    close(fd);
    if (!valid || count != 8) return FALSE;
    guint w = GUINT32_FROM_LE(words[0]), h = GUINT32_FROM_LE(words[1]);
    if (!mgu_hls_viewport_valid(w, h)) return FALSE;
    *width = w; *height = h;
    return TRUE;
}

static void mgu_hls_viewport_caps(MguHlsViewport *viewport) {
    GstCaps *caps = gst_caps_new_simple("video/x-raw", "format", G_TYPE_STRING, "I420",
        "width", G_TYPE_INT, (gint)viewport->width, "height", G_TYPE_INT, (gint)viewport->height,
        "pixel-aspect-ratio", GST_TYPE_FRACTION, 1, 1, NULL);
    g_object_set(viewport->capsfilter, "caps", caps, NULL);
    gst_caps_unref(caps);
}

static GstPadProbeReturn mgu_hls_viewport_probe(GstPad *pad, GstPadProbeInfo *info, gpointer data) {
    (void)pad; (void)info;
    MguHlsViewport *viewport = (MguHlsViewport *)data;
    gint64 now = g_get_monotonic_time();
    if (now - viewport->checked_at < 100000) return GST_PAD_PROBE_OK;
    viewport->checked_at = now;
    guint width = viewport->width, height = viewport->height;
    if (mgu_hls_viewport_read(viewport->file, &width, &height) &&
        (width != viewport->width || height != viewport->height)) {
        viewport->width = width; viewport->height = height;
        /* Delayed caps changes accept the current queued buffer while the
         * following buffers renegotiate. No pipeline or phone restart. */
        mgu_hls_viewport_caps(viewport);
    }
    return GST_PAD_PROBE_OK;
}

static void mgu_hls_viewport_free(gpointer data) {
    MguHlsViewport *viewport = (MguHlsViewport *)data;
    gst_object_unref(viewport->capsfilter);
    g_free(viewport->file);
    g_free(viewport);
}

static void mgu_hls_output(GstElement *player) {
    const gchar *description = g_getenv("MGU_HLS_AUDIO_SINK");
    if (!description || !*description) g_error("MGU HLS audio output not configured");
    GError *error = NULL;
    const gchar *ca_file = g_getenv("G_TLS_CA_FILE");
    if (!ca_file || !*ca_file) g_error("MGU HLS certificate store not configured");
    GTlsDatabase *database = g_tls_file_database_new(ca_file, &error);
    if (error || !database) g_error("MGU HLS certificate store could not be loaded");
    g_tls_backend_set_default_database(g_tls_backend_get_default(), database);
    g_object_unref(database);
    GstElement *audio = gst_parse_bin_from_description(description, TRUE, &error);
    if (error || !audio) g_error("MGU HLS audio pipeline could not be created");
    gst_object_ref_sink(audio);
    g_object_set(player, "audio-sink", audio, NULL);
    gst_object_unref(audio);
    /* OP19 itself always contains its input. Match the actual UI viewport's
       aspect here so the final renderer fills both axes with the whole source.
       Fixed square pixels plus add-borders=false stretch independently, with
       no crop or receiver-added letterbox. The private file follows UI resize. */
    GstElement *filter = gst_parse_bin_from_description(
        "queue name=mgu-hls-viewport-input max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=no ! video/x-raw ! "
        "videoconvertscale add-borders=false n-threads=2 dither=none method=bilinear ! "
        "capsfilter name=mgu-hls-viewport-output caps-change-mode=delayed",
        TRUE, &error);
    if (error || !filter) g_error("MGU HLS video filter could not be created");
    gst_object_ref_sink(filter);
    MguHlsViewport *viewport = g_new0(MguHlsViewport, 1);
    viewport->width = 1920; viewport->height = 720;
    viewport->file = g_strdup(g_getenv("MGU_HLS_VIEWPORT_FILE"));
    viewport->capsfilter = gst_bin_get_by_name(GST_BIN(filter), "mgu-hls-viewport-output");
    GstElement *input = gst_bin_get_by_name(GST_BIN(filter), "mgu-hls-viewport-input");
    if (!viewport->capsfilter || !input) g_error("MGU HLS viewport filter unavailable");
    mgu_hls_viewport_read(viewport->file, &viewport->width, &viewport->height);
    mgu_hls_viewport_caps(viewport);
    GstPad *input_pad = gst_element_get_static_pad(input, "sink");
    gst_pad_add_probe(input_pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST),
        mgu_hls_viewport_probe, viewport, mgu_hls_viewport_free);
    gst_object_unref(input_pad); gst_object_unref(input);
    g_object_set(player, "video-filter", filter, NULL);
    gst_object_unref(filter);
    /* Prefill before playback instead of repeatedly opening/pausing audio at
       startup. A fixed network-speed hint avoids a heavy first rendition.
       Five seconds (about one YouTube segment) ride out the short throughput
       dips of a phone hotspot without a visible stall. */
    g_object_set(player, "buffer-duration", (gint64)(5 * GST_SECOND),
                 "buffer-size", (gint)(8 * 1024 * 1024), "connection-speed", (guint64)2500, NULL);
    gint flags = 0;
    g_object_get(player, "flags", &flags, NULL);
    flags &= ~GST_PLAY_FLAG_DOWNLOAD; /* No unbounded on-disk video cache. */
    flags |= (1 << 12); /* GST_PLAY_FLAG_FORCE_SW_DECODERS */
    g_object_set(player, "flags", flags, NULL);
}
