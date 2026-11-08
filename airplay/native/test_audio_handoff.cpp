/* Regression for an existing video session changing to standalone audio.
 * SETUP is parsed/routed by actual raop.c in the C bridge; encrypted ALAC
 * travels through real UDP, RTP decryption, UxPlay callbacks and GStreamer.
 * Only the negotiated FairPlay key is replaced with a known local test key. */
#define main mgu_upstream_main
#include "../../.build/airplay/uxplay-source/uxplay.cpp"
#undef main
#include <cassert>
#include <fstream>
#include <gst/gst.h>
#include <unistd.h>

extern "C" {
void *mgu_test_audio_session_create(raop_t *);
void mgu_test_audio_setup(void *, unsigned int, bool, bool);
void mgu_test_mirror_setup(void *);
void mgu_test_audio_send(void *, const unsigned char *, unsigned int);
void mgu_test_audio_metadata(void *, const char *);
void mgu_test_audio_stale_events(void *);
void mgu_test_audio_session_destroy(void *);
}

static gint decoded_buffers = 0, decoded_bytes = 0, video_buffers = 0;
static GMainLoop *test_loop;
static guint video_watch;

static void test_log(void *, int, const char *message) { fprintf(stderr, "%s\n", message); }

static gboolean decoded(GSignalInvocationHint *, guint count, const GValue *values, gpointer) {
    if (count < 3) return TRUE;
    GstElement *sink = GST_ELEMENT(g_value_get_object(values));
    const gchar *name = GST_OBJECT_NAME(sink);
    GstBuffer *buffer = (GstBuffer *)g_value_get_boxed(values + 1);
    if (!strcmp(name, "handoff-pcm")) {
        GstPad *pad = GST_PAD(g_value_get_object(values + 2));
        GstCaps *caps = gst_pad_get_current_caps(pad);
        assert(caps && !strcmp(gst_structure_get_name(gst_caps_get_structure(caps, 0)), "audio/x-raw"));
        gst_caps_unref(caps);
        g_atomic_int_inc(&decoded_buffers);
        g_atomic_int_add(&decoded_bytes, gst_buffer_get_size(buffer));
    } else {
        GstPad *pad = GST_PAD(g_value_get_object(values + 2));
        GstCaps *caps = gst_pad_get_current_caps(pad);
        if (caps && !strcmp(gst_structure_get_name(gst_caps_get_structure(caps, 0)), "video/x-raw"))
            g_atomic_int_inc(&video_buffers);
        if (caps) gst_caps_unref(caps);
    }
    return TRUE;
}

static void pump(unsigned int milliseconds) {
    const gint64 until = g_get_monotonic_time() + milliseconds * 1000;
    do {
        while (g_main_context_iteration(NULL, FALSE)) {}
        g_usleep(1000);
    } while (g_get_monotonic_time() < until);
}

static void rebuild(void) {
    if (video_watch) { g_source_remove(video_watch); video_watch = 0; }
    /* This is the exact helper called by UxPlay's reconnect/main-loop path.
     * It destroys/recreates the renderer under the production playlist guard.
     * In particular, the test never assigns the HLS ownership atomic. */
    mgu_rebuild_media_renderers();
    video_watch = video_renderer_listen(test_loop, 0);
    /* The next production main_loop entry clears these loop-control flags. */
    reset_loop = false; relaunch_video = false;
}

static void begin_video(const char *uri, bool pending) {
    const gint before = g_atomic_int_get(&video_buffers);
    mgu_video_loading(NULL);
    assert(video_renderer_is_hls_active() && g_atomic_int_get(&mgu_pending_origin));
    if (pending) return;
    on_video_play(NULL, uri, 0.0f);
    rebuild();
    on_video_rate(NULL, 1.0f); /* Sender's ordinary play/rate handshake. */
    const gint64 deadline = g_get_monotonic_time() + 8 * G_TIME_SPAN_SECOND;
    while (g_atomic_int_get(&video_buffers) == before && g_get_monotonic_time() < deadline) pump(10);
    assert(video_renderer_is_hls_active());
    if (g_atomic_int_get(&video_buffers) == before) {
        double duration = 0, position = 0, seek = 0, span = 0; float rate = 0; bool empty = false, full = false;
        video_get_playback_info(&duration, &position, &seek, &span, &rate, &empty, &full);
        fprintf(stderr, "HLS fixture did not reach sink: duration=%g position=%g rate=%g empty=%d full=%d\n",
                duration, position, rate, empty, full);
    }
    assert(g_atomic_int_get(&video_buffers) > before); /* Actual decoded HLS frames while playing. */
}

static void decoded_audio(void *session, const unsigned char *packet, size_t bytes) {
    const gint before = g_atomic_int_get(&decoded_buffers), bytes_before = g_atomic_int_get(&decoded_bytes);
    for (int i = 0; i < 12; ++i) { mgu_test_audio_send(session, packet, bytes); pump(10); }
    const gint64 deadline = g_get_monotonic_time() + 3 * G_TIME_SPAN_SECOND;
    while (g_atomic_int_get(&decoded_buffers) == before && g_get_monotonic_time() < deadline) pump(10);
    assert(g_atomic_int_get(&decoded_buffers) > before);
    assert(g_atomic_int_get(&decoded_bytes) - bytes_before >= 352 * 2 * 2);
    assert(g_atomic_int_get(&mgu_audio_playing));
}

static void handoff(void *session, const unsigned char *packet, size_t bytes, raop_t *receiver) {
    assert(video_renderer_is_hls_active());
    const unsigned int connections = open_connections;
    mgu_test_audio_setup(session, 2, false, true);
    assert(raop == receiver && open_connections == connections && !reset_httpd);
    assert(url.empty() && !g_atomic_int_get(&mgu_pending_origin));
    assert(reset_loop && relaunch_video && preserve_connections && !g_atomic_int_get(&mgu_allow_mirror));
    rebuild();
    assert(!video_renderer_is_hls_active() && !reset_httpd);
    decoded_audio(session, packet, bytes);
    assert(raop == receiver && open_connections == connections && !reset_httpd);
}

static std::string file_text(const std::string &name) {
    std::ifstream file(name);
    return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

int main(int argc, char **argv) {
    assert(argc == 3);
    gchar *fixture = NULL; gsize bytes = 0;
    assert(g_file_get_contents(argv[1], &fixture, &bytes, NULL) && bytes > 8 && bytes < 65536 && (unsigned char)fixture[0] == 0x20);
    gst_init(&argc, &argv);
    GstElement *fake = gst_element_factory_make("fakesink", NULL); assert(fake);
    guint signal = g_signal_lookup("handoff", G_OBJECT_TYPE(fake)); assert(signal);
    gulong hook = g_signal_add_emission_hook(signal, 0, decoded, NULL, NULL); assert(hook);
    gst_object_unref(fake);
    test_loop = g_main_loop_new(NULL, FALSE);
    render_logger = logger_init();
    logger_set_callback(render_logger, test_log, NULL);
    logger_set_level(render_logger, getenv("MGU_HANDOFF_DEBUG") ? LOGGER_DEBUG : LOGGER_INFO);
    char temporary[] = "/tmp/mgu-handoff-XXXXXX";
    char *directory = mkdtemp(temporary); assert(directory);
    setenv("MGU_MUSIC_DIR", directory, 1);
    setenv("MGU_AUDIO_ONLY", "0", 1); setenv("MGU_AUTO_MEDIA", "1", 1);
    setenv("MGU_HLS_AUDIO_SINK", "fakesink sync=true", 1);
    setenv("G_TLS_CA_FILE", "/etc/ssl/certs/ca-certificates.crt", 1);
    const std::string viewport = std::string(directory) + "/viewport";
    unsigned int size[] = {128,72};
    int viewport_fd = open(viewport.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600);
    assert(viewport_fd >= 0 && write(viewport_fd, size, sizeof size) == sizeof size); close(viewport_fd);
    setenv("MGU_HLS_VIEWPORT_FILE", viewport.c_str(), 1);
    mgu_audio_configure();
    use_video = true; use_audio = true; video_sync = false; audio_sync = false;
    videosink = "fakesink"; videosink_options = " signal-handoffs=true";
    video_decoder = "avdec_h264"; playbin_version = 2; h265_support = false; hls_support = true;
    raop_callbacks_t callbacks = {};
    callbacks.audio_process = audio_process; callbacks.audio_get_format = audio_get_format;
    callbacks.audio_flush = audio_flush; callbacks.audio_stop_coverart_rendering = audio_stop_coverart_rendering;
    callbacks.audio_set_metadata = audio_set_metadata;
    callbacks.conn_init = conn_init; callbacks.conn_destroy = conn_destroy;
    callbacks.video_process = video_process; callbacks.video_reset = video_reset;
    callbacks.video_mirror_start = mgu_mirror_start;
    callbacks.is_hls_active = mgu_hls_active; callbacks.is_hls_detached = mgu_hls_detached;
    callbacks.on_video_loading = mgu_video_loading;
    callbacks.audio_stream_setup = mgu_audio_stream_setup;
    callbacks.audio_stream_is_current = mgu_audio_stream_is_current;
    raop = raop_init(&callbacks); assert(raop);
    assert(raop_init2(raop, 0, "02:00:00:00:00:01", "") == 0);
    raop_t *const receiver = raop;
    audio_renderer_init(render_logger, "fakesink name=handoff-pcm signal-handoffs=true enable-last-sample=false", &audio_sync, &video_sync, "");
    video_renderer_init(render_logger, "handoff-test", videoflip, "h264parse", "", "avdec_h264", "videoconvert",
                        videosink.c_str(), videosink_options.c_str(), false, false, false, false, 2, NULL);
    video_renderer_start(); video_watch = video_renderer_listen(test_loop, 0);
    guint audio_watches[] = {audio_renderer_listen(test_loop, 0), audio_renderer_listen(test_loop, 1)};

    /* First reproduce a single authenticated transport renegotiating from
     * screen AAC to standalone ALAC while an actual HLS pipeline is playing. */
    begin_video(argv[2], false);
    void *old_screen = mgu_test_audio_session_create(raop);
    mgu_test_audio_setup(old_screen, 8, true, false);
    assert(video_renderer_is_hls_active() && !reset_loop);
    handoff(old_screen, (unsigned char *)fixture, bytes, receiver);

    /* A real new mirror SETUP can regain the display after audio, then the
     * same receiver accepts and decodes another actual video generation. */
    mgu_test_mirror_setup(old_screen);
    const bool real_video = use_video; use_video = false;
    video_decode_struct video = {}; video_process(NULL, NULL, &video);
    use_video = real_video;
    assert(!g_atomic_int_get(&mgu_audio_playing) && g_atomic_int_get(&mgu_mirror_active));
    begin_video(argv[2], false);

    /* A second actual RTP owner replaces the old screen stream. Displaced
     * FLUSH and DMAP events must not pause audio or replace current metadata. */
    mgu_test_audio_setup(old_screen, 8, true, false);
    void *music = mgu_test_audio_session_create(raop);
    handoff(music, (unsigned char *)fixture, bytes, receiver);
    mgu_test_audio_metadata(music, "CURRENT OWNER"); pump(80);
    assert(file_text(std::string(directory) + "/current.json").find("CURRENT OWNER") != std::string::npos);
    mgu_test_audio_stale_events(old_screen); pump(80);
    assert(g_atomic_int_get(&mgu_audio_playing));
    const std::string metadata = file_text(std::string(directory) + "/current.json");
    assert(metadata.find("CURRENT OWNER") != std::string::npos && metadata.find("OLD OWNER") == std::string::npos);
    decoded_audio(music, (unsigned char *)fixture, bytes);
    begin_video(argv[2], false);

    /* FCUP can have accepted the next video while the preceding pipeline is
     * still alive. A positive SETUP must cancel this pending intent as well. */
    begin_video(argv[2], true);
    handoff(music, (unsigned char *)fixture, bytes, receiver);
    mgu_test_audio_stale_events(old_screen); pump(80);
    assert(g_atomic_int_get(&mgu_audio_playing));
    begin_video(argv[2], false);
    assert(raop == receiver && open_connections == 2 && !reset_httpd);

    mgu_test_audio_session_destroy(old_screen); mgu_test_audio_session_destroy(music);
    assert(!open_connections);
    if (video_watch) g_source_remove(video_watch);
    for (guint watch : audio_watches) g_source_remove(watch);
    video_renderer_destroy(); audio_renderer_destroy(); raop_destroy(raop); logger_destroy(render_logger);
    g_signal_remove_emission_hook(signal, hook); g_main_loop_unref(test_loop); g_free(fixture);
    unlink((std::string(directory) + "/current.json").c_str()); unlink(viewport.c_str());
    if (mgu_metadata_directory >= 0) close(mgu_metadata_directory);
    assert(!rmdir(directory));
    puts("Real parsed SETUP96: active/pending HLS to renegotiated/decrypted ALAC PCM, stale-owner isolation and video return passed");
}
