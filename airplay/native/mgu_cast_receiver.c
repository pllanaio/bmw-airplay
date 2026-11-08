/* Android screen cast sink for the PllanaCast for BMW app, GPL-3.0-or-later.
 *
 * The backend accepts and authenticates the phone's TCP connection and pipes
 * the remaining byte stream to stdin. This process never touches the
 * network. Frames (all integers big-endian, 16-byte header):
 *
 *   u8 type, u8 flags, u16 reserved, u32 length, u64 pts_us, payload
 *   type 1  H.264 parameter sets (Annex-B), kept and sent before keyframes
 *   type 2  H.264 access unit (Annex-B), flags bit 0 = keyframe
 *   type 4  PCM S16LE 48 kHz stereo (only with argv[2] == "audio")
 *   type 5  keepalive
 *
 * Video is shown as soon as it is decoded (like AirPlay mirroring); sound is
 * scheduled: phone timestamps are mapped to the pipeline clock with a fixed
 * latency and rebased when the clocks drift.
 * Output: MGU_CAST ready | playing | ended | error <code>. No addresses or
 * device names are printed.
 */
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>

#define MAX_VIDEO (4u * 1024u * 1024u)
#define MAX_AUDIO (256u * 1024u)
#define MAX_CONFIG (64u * 1024u)
#define LATENCY (150 * GST_MSECOND)

typedef struct {
    GMainLoop *loop;
    GstElement *pipeline;
    GstAppSrc *video, *audio;
    GMutex lock;
    gboolean based;
    GstClockTimeDiff offset;
    guint8 *config;
    gsize config_size;
} Cast;

static void say(const char *text) { printf("MGU_CAST %s\n", text); fflush(stdout); }

static gboolean read_all(guint8 *buffer, gsize size) {
    gsize done = 0;
    while (done < size) {
        size_t n = fread(buffer + done, 1, size - done, stdin);
        if (!n) return FALSE;
        done += n;
    }
    return TRUE;
}

static GstClockTime timestamp(Cast *cast, guint64 pts_us) {
    GstClock *clock = gst_element_get_clock(cast->pipeline);
    if (!clock) return GST_CLOCK_TIME_NONE;
    GstClockTime now = gst_clock_get_time(clock) - gst_element_get_base_time(cast->pipeline);
    gst_object_unref(clock);
    GstClockTimeDiff pts = (GstClockTimeDiff)(pts_us * GST_USECOND);
    g_mutex_lock(&cast->lock);
    if (!cast->based) { cast->offset = (GstClockTimeDiff)(now + LATENCY) - pts; cast->based = TRUE; }
    GstClockTimeDiff at = pts + cast->offset;
    /* Late (phone clock slower, network stall) or far ahead: rebase. */
    if (at < (GstClockTimeDiff)now || at > (GstClockTimeDiff)(now + LATENCY + GST_SECOND)) {
        cast->offset = (GstClockTimeDiff)(now + LATENCY) - pts;
        at = (GstClockTimeDiff)(now + LATENCY);
    }
    g_mutex_unlock(&cast->lock);
    return (GstClockTime)at;
}

static void push(Cast *cast, GstAppSrc *src, guint8 *data, gsize size, guint64 pts_us, gboolean delta) {
    GstBuffer *buffer = gst_buffer_new_wrapped(data, size);
    GST_BUFFER_PTS(buffer) = timestamp(cast, pts_us);
    if (delta) GST_BUFFER_FLAG_SET(buffer, GST_BUFFER_FLAG_DELTA_UNIT);
    gst_app_src_push_buffer(src, buffer);
}

static gpointer reader(gpointer data) {
    Cast *cast = (Cast *)data;
    guint8 header[16];
    const char *result = "ended";
    while (read_all(header, sizeof header)) {
        guint type = header[0], flags = header[1];
        guint32 length = ((guint32)header[4] << 24) | ((guint32)header[5] << 16) | ((guint32)header[6] << 8) | header[7];
        guint64 pts = 0;
        for (int i = 8; i < 16; i++) pts = (pts << 8) | header[i];
        guint32 limit = type == 1 ? MAX_CONFIG : type == 2 ? MAX_VIDEO : type == 4 ? MAX_AUDIO : type == 5 ? 0 : 0;
        if ((type != 1 && type != 2 && type != 4 && type != 5) || length > limit) { result = "error protocol"; break; }
        guint8 *payload = length ? g_malloc(length) : NULL;
        if (length && !read_all(payload, length)) { g_free(payload); break; }
        if (type == 1) {
            g_free(cast->config); cast->config = payload; cast->config_size = length;
        } else if (type == 2) {
            gboolean key = flags & 1;
            if (key && cast->config) {
                guint8 *joined = g_malloc(cast->config_size + length);
                memcpy(joined, cast->config, cast->config_size);
                memcpy(joined + cast->config_size, payload, length);
                g_free(payload);
                push(cast, cast->video, joined, cast->config_size + length, pts, FALSE);
            } else push(cast, cast->video, payload, length, pts, !key);
        } else if (type == 4) {
            if (cast->audio && !(length & 3)) push(cast, cast->audio, payload, length, pts, FALSE);
            else g_free(payload);
        }
    }
    say(result);
    g_main_loop_quit(cast->loop);
    return NULL;
}

static gboolean on_bus(GstBus *bus, GstMessage *message, gpointer data) {
    (void)bus;
    Cast *cast = (Cast *)data;
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *error = NULL;
        gst_message_parse_error(message, &error, NULL);
        say(error && error->domain == GST_STREAM_ERROR ? "error decode" : "error pipeline");
        if (error) g_error_free(error);
        g_main_loop_quit(cast->loop);
    } else if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_STATE_CHANGED && GST_MESSAGE_SRC(message) == GST_OBJECT(cast->pipeline)) {
        GstState old_state, new_state, pending;
        gst_message_parse_state_changed(message, &old_state, &new_state, &pending);
        if (new_state == GST_STATE_PLAYING && old_state != GST_STATE_PLAYING) say("playing");
    }
    return TRUE;
}

int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    if (argc != 3 || !argv[1][0]) { fprintf(stderr, "usage: mgu-cast-receiver <video-sink> audio|noaudio\n"); return 64; }
    gboolean with_audio = !strcmp(argv[2], "audio");
    const char *audio_sink = g_getenv("MGU_HLS_AUDIO_SINK");
    if (with_audio && (!audio_sink || !*audio_sink)) { say("error audio_sink"); return 69; }
    gchar *description = g_strdup_printf(
        "appsrc name=video is-live=true format=time do-timestamp=false max-bytes=16777216 block=false "
        "caps=video/x-h264,stream-format=byte-stream,alignment=au ! h264parse config-interval=-1 ! "
        "avdec_h264 max-threads=2 output-corrupt=false ! videoconvert ! video/x-raw,format=I420 ! "
        "queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! %s sync=false"
        "%s%s",
        argv[1],
        with_audio ? " appsrc name=audio is-live=true format=time do-timestamp=false max-bytes=1048576 block=false "
            "caps=audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved ! "
            "queue max-size-time=400000000 max-size-buffers=0 max-size-bytes=0 leaky=downstream ! audioconvert ! audioresample ! " : "",
        with_audio ? audio_sink : "");
    GError *error = NULL;
    Cast cast;
    memset(&cast, 0, sizeof cast);
    g_mutex_init(&cast.lock);
    cast.pipeline = gst_parse_launch(description, &error);
    g_free(description);
    if (error || !cast.pipeline) { say("error pipeline"); return 69; }
    cast.video = GST_APP_SRC(gst_bin_get_by_name(GST_BIN(cast.pipeline), "video"));
    if (with_audio) cast.audio = GST_APP_SRC(gst_bin_get_by_name(GST_BIN(cast.pipeline), "audio"));
    cast.loop = g_main_loop_new(NULL, FALSE);
    GstBus *bus = gst_element_get_bus(cast.pipeline);
    gst_bus_add_watch(bus, on_bus, &cast);
    gst_object_unref(bus);
    if (gst_element_set_state(cast.pipeline, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) { say("error pipeline"); return 69; }
    say("ready");
    GThread *thread = g_thread_new("cast-reader", reader, &cast);
    g_main_loop_run(cast.loop);
    gst_element_set_state(cast.pipeline, GST_STATE_NULL);
    /* The reader may still block on stdin; exiting the process ends it. */
    (void)thread;
    fflush(stdout);
    _exit(0);
}
