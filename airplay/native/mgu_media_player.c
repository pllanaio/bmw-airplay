/* URL player for Android/DLNA senders, GPL-3.0-or-later.
 *
 * Plays one http(s) media URL through the same output as AirPlay video:
 * playbin -> mgu_hls_output (viewport scaling, OEM ALSA sink, CA store) ->
 * mguvideosink shared memory. The backend controls it over stdin with one
 * command per line and reads bounded status lines on stdout. Stream URLs and
 * peer addresses are never printed.
 *
 *   uri <url>          load (paused), report MGU_PLAYER state loading
 *   start <seconds>    position to apply once the media is prerolled
 *   play | pause       transport
 *   seek <seconds>     flushing seek
 *   volume <0..100>    playbin volume (the BMW volume stays in the car)
 *   mute <0|1>
 *   stop               unload, report MGU_PLAYER state stopped
 *   quit               exit
 *
 *   MGU_PLAYER ready
 *   MGU_PLAYER state loading|buffering|playing|paused|stopped|ended
 *   MGU_PLAYER media video|audio
 *   MGU_PLAYER position <ms> <duration ms or -1>
 *   MGU_PLAYER error <code>
 */
#include <gst/gst.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <math.h>

typedef enum {
    GST_PLAY_FLAG_VIDEO = (1 << 0),
    GST_PLAY_FLAG_AUDIO = (1 << 1),
    GST_PLAY_FLAG_TEXT = (1 << 2),
    GST_PLAY_FLAG_VIS = (1 << 3),
    GST_PLAY_FLAG_SOFT_VOLUME = (1 << 4),
    GST_PLAY_FLAG_NATIVE_AUDIO = (1 << 5),
    GST_PLAY_FLAG_NATIVE_VIDEO = (1 << 6),
    GST_PLAY_FLAG_DOWNLOAD = (1 << 7),
    GST_PLAY_FLAG_BUFFERING = (1 << 8),
} GstPlayFlags;
#include "mgu_hls_output.h"

typedef struct {
    GMainLoop *loop;
    GstElement *player;
    gboolean loaded, want_playing, prerolled, buffering, live, reported_media;
    double start;
    gint64 last_position, last_duration;
    const char *last_state;
    GString *line;
} Player;

static void say(const char *format, ...) G_GNUC_PRINTF(1, 2);
static void say(const char *format, ...) {
    va_list args;
    va_start(args, format);
    fputs("MGU_PLAYER ", stdout);
    vfprintf(stdout, format, args);
    fputc('\n', stdout);
    fflush(stdout);
    va_end(args);
}

static void report_state(Player *p, const char *state) {
    if (p->last_state && !strcmp(p->last_state, state)) return;
    p->last_state = state;
    say("state %s", state);
}

static gboolean valid_uri(const char *uri) {
    size_t n = strlen(uri);
    if (n < 8 || n > 8192) return FALSE;
    if (strncasecmp(uri, "http://", 7) && strncasecmp(uri, "https://", 8)) return FALSE;
    for (const unsigned char *c = (const unsigned char *)uri; *c; c++)
        if (*c <= 0x20 || *c == 0x7f) return FALSE;
    return TRUE;
}

static void unload(Player *p) {
    gst_element_set_state(p->player, GST_STATE_NULL);
    p->loaded = p->want_playing = p->prerolled = p->buffering = p->live = p->reported_media = FALSE;
    p->start = 0; p->last_position = p->last_duration = -2;
}

static void apply_target(Player *p) {
    if (!p->loaded) return;
    GstState target = p->want_playing && !p->buffering ? GST_STATE_PLAYING : GST_STATE_PAUSED;
    gst_element_set_state(p->player, target);
}

static void report_media(Player *p) {
    if (p->reported_media) return;
    gint videos = 0;
    g_object_get(p->player, "n-video", &videos, NULL);
    p->reported_media = TRUE;
    say("media %s", videos > 0 ? "video" : "audio");
}

static void command(Player *p, char *text) {
    char *argument = strchr(text, ' ');
    if (argument) *argument++ = '\0';
    if (!strcmp(text, "uri") && argument) {
        unload(p);
        if (!valid_uri(argument)) { say("error invalid_uri"); report_state(p, "stopped"); return; }
        g_object_set(p->player, "uri", argument, NULL);
        p->loaded = TRUE; p->last_state = NULL;
        report_state(p, "loading");
        GstStateChangeReturn r = gst_element_set_state(p->player, GST_STATE_PAUSED);
        if (r == GST_STATE_CHANGE_FAILURE) { say("error open_failed"); unload(p); report_state(p, "stopped"); }
        else if (r == GST_STATE_CHANGE_NO_PREROLL) p->live = TRUE;
    } else if (!strcmp(text, "start") && argument) {
        double value = strtod(argument, NULL);
        p->start = isfinite(value) && value > 0 ? value : 0;
    } else if (!strcmp(text, "play")) {
        if (!p->loaded) return;
        p->want_playing = TRUE; apply_target(p);
    } else if (!strcmp(text, "pause")) {
        if (!p->loaded) return;
        p->want_playing = FALSE; apply_target(p);
        if (p->prerolled) report_state(p, "paused");
    } else if (!strcmp(text, "seek") && argument) {
        double value = strtod(argument, NULL);
        if (!p->loaded || !isfinite(value) || value < 0) return;
        if (!p->prerolled) { p->start = value; return; }
        if (!gst_element_seek_simple(p->player, GST_FORMAT_TIME,
                (GstSeekFlags)(GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_KEY_UNIT), (gint64)(value * GST_SECOND)))
            say("error seek_failed");
    } else if (!strcmp(text, "volume") && argument) {
        long value = strtol(argument, NULL, 10);
        if (value < 0) value = 0;
        if (value > 100) value = 100;
        g_object_set(p->player, "volume", (gdouble)value / 100.0, NULL);
    } else if (!strcmp(text, "mute") && argument) {
        g_object_set(p->player, "mute", (gboolean)(argument[0] == '1'), NULL);
    } else if (!strcmp(text, "stop")) {
        unload(p); report_state(p, "stopped");
    } else if (!strcmp(text, "quit")) {
        g_main_loop_quit(p->loop);
    }
}

static gboolean on_stdin(GIOChannel *channel, GIOCondition condition, gpointer data) {
    Player *p = (Player *)data;
    /* Read what is left after a hangup; EOF then ends with the backend. */
    if (!(condition & G_IO_IN)) { g_main_loop_quit(p->loop); return FALSE; }
    gchar chunk[4096];
    gsize count = 0;
    GIOStatus status = g_io_channel_read_chars(channel, chunk, sizeof chunk, &count, NULL);
    if (status == G_IO_STATUS_EOF || status == G_IO_STATUS_ERROR) { g_main_loop_quit(p->loop); return FALSE; }
    for (gsize i = 0; i < count; i++) {
        if (chunk[i] == '\n') {
            if (p->line->len && p->line->str[p->line->len - 1] == '\r') g_string_truncate(p->line, p->line->len - 1);
            command(p, p->line->str);
            g_string_truncate(p->line, 0);
        } else if (p->line->len < 9000) g_string_append_c(p->line, chunk[i]);
        else { g_string_truncate(p->line, 0); say("error line_too_long"); }
    }
    return TRUE;
}

static gboolean on_bus(GstBus *bus, GstMessage *message, gpointer data) {
    (void)bus;
    Player *p = (Player *)data;
    switch (GST_MESSAGE_TYPE(message)) {
    case GST_MESSAGE_EOS:
        if (p->loaded) { p->want_playing = FALSE; gst_element_set_state(p->player, GST_STATE_PAUSED); report_state(p, "ended"); }
        break;
    case GST_MESSAGE_ERROR: {
        GError *error = NULL;
        gst_message_parse_error(message, &error, NULL);
        const char *code = "playback_failed";
        if (error) {
            if (error->domain == GST_RESOURCE_ERROR) code = error->code == GST_RESOURCE_ERROR_NOT_AUTHORIZED ? "forbidden" :
                error->code == GST_RESOURCE_ERROR_NOT_FOUND ? "not_found" : "network_failed";
            else if (error->domain == GST_STREAM_ERROR) code = error->code == GST_STREAM_ERROR_CODEC_NOT_FOUND ||
                error->code == GST_STREAM_ERROR_TYPE_NOT_FOUND || error->code == GST_STREAM_ERROR_WRONG_TYPE ? "unsupported" : "decode_failed";
            g_error_free(error);
        }
        say("error %s", code);
        unload(p); p->last_state = NULL; report_state(p, "stopped");
        break;
    }
    case GST_MESSAGE_BUFFERING: {
        if (p->live || !p->loaded) break;
        gint percent = 100;
        gst_message_parse_buffering(message, &percent);
        gboolean low = percent < 100;
        if (low != p->buffering) {
            p->buffering = low;
            if (low) report_state(p, "buffering");
            apply_target(p);
        }
        break;
    }
    case GST_MESSAGE_ASYNC_DONE:
        if (!p->loaded) break;
        if (!p->prerolled) {
            p->prerolled = TRUE;
            report_media(p);
            if (p->start > 0) {
                gst_element_seek_simple(p->player, GST_FORMAT_TIME,
                    (GstSeekFlags)(GST_SEEK_FLAG_FLUSH | GST_SEEK_FLAG_KEY_UNIT), (gint64)(p->start * GST_SECOND));
                p->start = 0;
            }
            if (!p->want_playing) report_state(p, "paused");
            apply_target(p);
        }
        break;
    case GST_MESSAGE_STATE_CHANGED:
        if (GST_MESSAGE_SRC(message) == GST_OBJECT(p->player) && p->loaded) {
            GstState old_state, new_state, pending;
            gst_message_parse_state_changed(message, &old_state, &new_state, &pending);
            if (new_state == GST_STATE_PLAYING) { report_media(p); report_state(p, "playing"); }
            else if (new_state == GST_STATE_PAUSED && old_state == GST_STATE_PLAYING && !p->buffering && !p->want_playing &&
                     !(p->last_state && !strcmp(p->last_state, "ended")))
                report_state(p, "paused");
        }
        break;
    default:
        break;
    }
    return TRUE;
}

static gboolean on_tick(gpointer data) {
    Player *p = (Player *)data;
    if (!p->loaded || !p->prerolled) return TRUE;
    gint64 position = -1, duration = -1;
    if (!gst_element_query_position(p->player, GST_FORMAT_TIME, &position)) return TRUE;
    if (!gst_element_query_duration(p->player, GST_FORMAT_TIME, &duration)) duration = -1;
    gint64 ms = position / GST_MSECOND, total = duration >= 0 ? duration / GST_MSECOND : -1;
    if (ms / 250 != p->last_position / 250 || total != p->last_duration) {
        p->last_position = ms; p->last_duration = total;
        say("position %" G_GINT64_FORMAT " %" G_GINT64_FORMAT, ms, total);
    }
    return TRUE;
}

int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    if (argc != 2 || !argv[1][0]) { fprintf(stderr, "usage: mgu-media-player <video-sink>\n"); return 64; }
    Player p;
    memset(&p, 0, sizeof p);
    p.last_position = p.last_duration = -2;
    p.line = g_string_new(NULL);
    p.loop = g_main_loop_new(NULL, FALSE);
    p.player = gst_element_factory_make("playbin", "mgu-media-player");
    if (!p.player) { say("error playbin_missing"); return 69; }
    GError *error = NULL;
    GstElement *video = NULL;
    if (strcmp(argv[1], "none")) {
        video = gst_parse_bin_from_description(argv[1], TRUE, &error);
        if (error || !video) { say("error video_sink_failed"); return 69; }
        g_object_set(p.player, "video-sink", video, NULL);
    }
    /* Viewport scaling, audio sink, certificate store and buffering exactly
       as for AirPlay direct video. */
    mgu_hls_output(p.player);
    gint flags = 0;
    g_object_get(p.player, "flags", &flags, NULL);
    flags &= ~(GST_PLAY_FLAG_TEXT | GST_PLAY_FLAG_VIS);
    if (!video) flags &= ~GST_PLAY_FLAG_VIDEO;
    g_object_set(p.player, "flags", flags, NULL);
    GstBus *bus = gst_element_get_bus(p.player);
    gst_bus_add_watch(bus, on_bus, &p);
    gst_object_unref(bus);
    GIOChannel *input = g_io_channel_unix_new(0);
    g_io_channel_set_encoding(input, NULL, NULL);
    g_io_channel_set_buffered(input, FALSE);
    g_io_add_watch(input, (GIOCondition)(G_IO_IN | G_IO_HUP | G_IO_ERR | G_IO_NVAL), on_stdin, &p);
    g_timeout_add(250, on_tick, &p);
    say("ready");
    g_main_loop_run(p.loop);
    gst_element_set_state(p.player, GST_STATE_NULL);
    gst_object_unref(p.player);
    g_io_channel_unref(input);
    g_string_free(p.line, TRUE);
    g_main_loop_unref(p.loop);
    return 0;
}
