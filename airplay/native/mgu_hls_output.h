/* Private UxPlay output integration, GPL-3.0-or-later like the enclosing code. */
#include <stdio.h>
#include <gio/gio.h>
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
    g_object_set(player, "audio-sink", audio, NULL);
    /* Fill the HU's 1920x504 video surface. Crop centrally at the source
       aspect before scaling; baking a 16:9 letterbox into each frame would
       leave permanent bars even when the renderer uses a cover crop.
       Explicit raw input caps let aspectratiocrop link before playbin has
       connected its decoded source. One combined convert+scale pass keeps the
       output near the previous 720p pixel budget (968k versus 922k pixels). */
    GstElement *filter = gst_parse_bin_from_description(
        "queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=no ! video/x-raw ! "
        "aspectratiocrop aspect-ratio=80/21 ! "
        "videoconvertscale add-borders=false n-threads=2 dither=none method=bilinear ! "
        "capsfilter caps=\"video/x-raw,format=I420,width=1920,height=504,pixel-aspect-ratio=1/1\"",
        TRUE, &error);
    if (error || !filter) g_error("MGU HLS video filter could not be created");
    g_object_set(player, "video-filter", filter, NULL);
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
