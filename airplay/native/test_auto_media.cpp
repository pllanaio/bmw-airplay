/* Exercise the actual mixed receiver callbacks with synthetic sender media.
 * No iPhone, audio hardware or display server is needed. Sender compatibility
 * and background playback policy still require a real device check. */
#define main mgu_upstream_main
#include "../../.build/airplay/uxplay-source/uxplay.cpp"
#undef main
#include <cassert>
#include <fstream>
#include <gst/gst.h>
#include <vector>
#include <unistd.h>

static bool feature(uint64_t value, unsigned int bit) { return value & (uint64_t(1) << bit); }

static std::string captured(FILE *file) {
    fflush(stdout);
    assert(!fseek(file, 0, SEEK_SET));
    std::string value;
    char bytes[4096];
    size_t count;
    while ((count = fread(bytes, 1, sizeof bytes, file))) value.append(bytes, count);
    clearerr(file);
    assert(!fseek(file, 0, SEEK_END));
    return value;
}

static unsigned int occurrences(const std::string &value, const std::string &needle) {
    unsigned int count = 0;
    for (size_t at = 0; (at = value.find(needle, at)) != std::string::npos; at += needle.size()) ++count;
    return count;
}

static void markers(FILE *file, unsigned int playing, unsigned int waiting) {
    std::string value = captured(file);
    assert(occurrences(value, "MGU_AUDIO_PLAY\n") == playing);
    assert(occurrences(value, "MGU_AUDIO_WAITING\n") == waiting);
}

static void format(audio_decode_struct &packet, unsigned char codec, bool screen, bool media) {
    packet.ct = codec;
    packet.data[0] = codec == 2 ? 0x20 : 0x8c;
    unsigned short samples = 352;
    uint64_t audio_format = 0;
    audio_get_format(NULL, &codec, &samples, &screen, &media, &audio_format);
}

static void append32(std::vector<unsigned char> &value, uint32_t number) {
    for (int shift = 24; shift >= 0; shift -= 8) value.push_back((number >> shift) & 255);
}

static void field(std::vector<unsigned char> &value, const char *tag, const std::string &text) {
    value.insert(value.end(), tag, tag + 4);
    append32(value, text.size());
    value.insert(value.end(), text.begin(), text.end());
}

static std::string read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    render_logger = logger_init();
    raop_callbacks_t callbacks = {};
    callbacks.audio_process = audio_process;
    callbacks.video_process = video_process;
    raop = raop_init(&callbacks);
    assert(raop && raop_init2(raop, 0, "02:00:00:00:00:01", "") == 0);
    char temporary[] = "/tmp/mgu-auto-media-XXXXXX";
    char *directory = mkdtemp(temporary);
    assert(directory);
    setenv("MGU_MUSIC_DIR", directory, 1);
    setenv("MGU_AUDIO_ONLY", "0", 1);
    setenv("MGU_AUTO_MEDIA", "1", 1);

    fflush(stdout);
    const int saved_stdout = dup(fileno(stdout));
    FILE *capture = tmpfile();
    assert(saved_stdout >= 0 && capture && dup2(fileno(capture), fileno(stdout)) >= 0);
    use_video = true;
    hls_support = true;
    render_coverart = true;
    mgu_audio_configure();
    assert(mgu_audio_auto && !mgu_audio_only && use_video && hls_support && !render_coverart);
    std::vector<char> hardware = {2, 0, 0, 0, 0, 1};
    assert(start_dnssd(hardware, "automatic-media-test") == 0);
    uint64_t features = dnssd_get_airplay_features(dnssd);
    for (unsigned int bit : {0, 4, 7, 9, 30}) assert(feature(features, bit));
    dnssd_destroy(dnssd); dnssd = NULL;

    videoflip_t transform[2] = {NONE, NONE};
    video_renderer_init(render_logger, "automatic-media-test", transform, "h264parse", "", "avdec_h264", "videoconvert",
                        "fakesink", "", false, false, false, false, 2, NULL);
    video_renderer_start();
    use_video = false; /* Actual callbacks, without sending synthetic video to a decoder. */
    use_audio = false;
    reset_loop = false;
    unsigned char bytes[] = {0x20};
    audio_decode_struct audio = {};
    audio.data = bytes; audio.data_len = sizeof bytes; audio.ct = 2;
    video_decode_struct video = {};

    /* Screen intent wins even if the sender uses ALAC and sets isMedia. */
    format(audio, 2, true, true);
    assert(g_atomic_int_get(&mgu_audio_kind) == 2);
    audio_process(NULL, NULL, &audio);
    assert(!g_atomic_int_get(&mgu_audio_playing));
    markers(capture, 0, 0);

    /* SETUP alone and empty packets cannot claim the display. */
    format(audio, 8, false, true);
    assert(g_atomic_int_get(&mgu_audio_kind) == 1);
    assert(!g_atomic_int_get(&mgu_audio_presented));
    markers(capture, 0, 0);
    audio_decode_struct empty = audio; empty.data_len = 0;
    audio_process(NULL, NULL, &empty);
    markers(capture, 0, 0);
    audio_process(NULL, NULL, &audio);
    audio_process(NULL, NULL, &audio);
    assert(g_atomic_int_get(&mgu_audio_playing));
    assert(g_atomic_int_get(&mgu_audio_presented));
    markers(capture, 1, 0);
    audio_flush(NULL); audio_flush(NULL);
    assert(!g_atomic_int_get(&mgu_audio_playing) && !reset_loop);
    assert(g_atomic_int_get(&mgu_audio_presented));
    markers(capture, 1, 1);
    audio_process(NULL, NULL, &audio);
    markers(capture, 2, 1);

    /* Accepted video packets silently own the screen; late mirror audio and
     * its FLUSH cannot change that ownership back to an audio/waiting view. */
    video_process(NULL, NULL, &video);
    assert(!g_atomic_int_get(&mgu_audio_playing) && g_atomic_int_get(&mgu_audio_kind) == 2);
    assert(!g_atomic_int_get(&mgu_audio_presented));
    assert(g_atomic_int_get(&mgu_mirror_active));
    audio_process(NULL, NULL, &audio); audio_flush(NULL);
    markers(capture, 2, 1);
    assert(!reset_loop);

    /* Explicit standalone ALAC may replace a mirror, and a fresh standalone
     * media SETUP must also bypass the direct-video waiting packet gate. */
    format(audio, 2, false, false); audio_process(NULL, NULL, &audio);
    assert(g_atomic_int_get(&mgu_audio_playing) && !g_atomic_int_get(&mgu_mirror_active));
    markers(capture, 3, 1);
    audio_stop_coverart_rendering(NULL);
    assert(!reset_loop); markers(capture, 3, 2);
    g_atomic_int_set(&mgu_allow_mirror, 0);
    format(audio, 8, false, true);
    assert(!g_atomic_int_get(&mgu_audio_playing));
    audio_process(NULL, NULL, &audio);
    assert(g_atomic_int_get(&mgu_audio_playing) && !g_atomic_int_get(&mgu_allow_mirror));
    const unsigned int before_mirror_setup = occurrences(captured(capture), "MGU_MODE mirror\n");
    video_process(NULL, NULL, &video);
    assert(g_atomic_int_get(&mgu_audio_playing) && g_atomic_int_get(&mgu_audio_kind) == 1);
    assert(occurrences(captured(capture), "MGU_MODE mirror\n") == before_mirror_setup);
    markers(capture, 4, 2);
    audio_flush(NULL); markers(capture, 4, 3);
    assert(g_atomic_int_get(&mgu_audio_presented));
    format(audio, 8, true, false);
    assert(g_atomic_int_get(&mgu_audio_presented) && !g_atomic_int_get(&mgu_audio_playing));
    video_process(NULL, NULL, &video);
    assert(occurrences(captured(capture), "MGU_MODE mirror\n") == before_mirror_setup);
    mgu_mirror_start(NULL); /* Actual stream110 SETUP, not stale RTP. */
    assert(g_atomic_int_get(&mgu_allow_mirror));
    video_process(NULL, NULL, &video); video_process(NULL, NULL, &video);
    assert(!g_atomic_int_get(&mgu_audio_presented) && g_atomic_int_get(&mgu_audio_kind) == 2);
    assert(occurrences(captured(capture), "MGU_MODE mirror\n") == before_mirror_setup + 1);
    markers(capture, 4, 3);

    /* A mirror that actually stops releases its old flag without restarting
     * discovery or the receiver. Fresh ALAC then identifies standalone audio. */
    video_reset(NULL, RESET_TYPE_RTP_SHUTDOWN);
    assert(!g_atomic_int_get(&mgu_mirror_active));
    reset_loop = false;
    format(audio, 2, false, false); audio_process(NULL, NULL, &audio);
    assert(g_atomic_int_get(&mgu_audio_playing) && !g_atomic_int_get(&mgu_mirror_active) && !reset_loop);
    markers(capture, 5, 3);
    audio_flush(NULL); markers(capture, 5, 4);

    /* Ambiguous AAC gives actual video time to arrive instead of guessing
     * from a codec. A paused/static mirror never expires into audio mode. */
    format(audio, 8, false, false);
    assert(g_atomic_int_get(&mgu_audio_kind) == 3);
    audio_process(NULL, NULL, &audio);
    assert(mgu_audio_candidate_since && !g_atomic_int_get(&mgu_audio_playing));
    mgu_audio_candidate_since = g_get_monotonic_time() - 100000;
    audio_process(NULL, NULL, &audio); markers(capture, 5, 4);
    mgu_audio_candidate_since = g_get_monotonic_time() - 750001;
    audio_process(NULL, NULL, &audio);
    assert(g_atomic_int_get(&mgu_audio_playing)); markers(capture, 6, 4);
    audio_flush(NULL); markers(capture, 6, 5);
    video_process(NULL, NULL, &video);
    assert(g_atomic_int_get(&mgu_mirror_active));
    format(audio, 8, false, false);
    mgu_audio_candidate_since = g_get_monotonic_time() - 10000000;
    audio_process(NULL, NULL, &audio);
    assert(!g_atomic_int_get(&mgu_audio_playing) && g_atomic_int_get(&mgu_audio_kind) == 3);
    markers(capture, 6, 5);
    g_atomic_int_set(&mgu_mirror_active, 0);
    g_atomic_int_set(&mgu_pending_origin, 1);
    audio_process(NULL, NULL, &audio); markers(capture, 6, 5);
    g_atomic_int_set(&mgu_pending_origin, 0);

    /* A real accepted /play reserves video during FCUP loading, before
     * on_video_play. Late SETUP/FLUSH must not overwrite either video phase. */
    format(audio, 2, false, false); audio_process(NULL, NULL, &audio); markers(capture, 7, 5);
    mgu_video_loading(NULL);
    assert(video_renderer_is_hls_active() && g_atomic_int_get(&mgu_pending_origin));
    assert(g_atomic_int_get(&mgu_audio_kind) == 2 && !g_atomic_int_get(&mgu_audio_playing));
    format(audio, 8, false, true); audio_process(NULL, NULL, &audio); audio_flush(NULL);
    assert(video_renderer_is_hls_active() && !g_atomic_int_get(&mgu_audio_playing) && !reset_loop);
    markers(capture, 7, 5);
    on_video_play(NULL, "http://127.0.0.1/automatic-video.m3u8", 0.0f);
    assert(video_renderer_is_hls_active() && !g_atomic_int_get(&mgu_pending_origin));
    reset_loop = false;
    format(audio, 2, false, false); audio_process(NULL, NULL, &audio); audio_flush(NULL);
    assert(video_renderer_is_hls_active() && !g_atomic_int_get(&mgu_audio_playing) && !reset_loop);
    markers(capture, 7, 5);
    video_reset(NULL, RESET_TYPE_HLS_EOS);
    video_renderer_start(); reset_loop = false;
    assert(!video_renderer_is_hls_active());

    /* Metadata and cover art come from the same actual RAOP callbacks in
     * automatic mode, without enabling UxPlay's video artwork renderer. */
    format(audio, 8, false, true); audio_process(NULL, NULL, &audio); markers(capture, 8, 5);
    std::vector<unsigned char> fields;
    field(fields, "minm", "Auto café"); field(fields, "asar", "Phone sender"); field(fields, "asal", "Actual DMAP fields");
    std::vector<unsigned char> metadata = {'m', 'l', 'i', 't'};
    append32(metadata, fields.size()); metadata.insert(metadata.end(), fields.begin(), fields.end());
    audio_set_metadata(NULL, metadata.data(), metadata.size());
    const std::string json_path = std::string(directory) + "/current.json";
    std::string json = read_file(json_path);
    assert(json.find("\"title\":\"Auto café\"") != std::string::npos);
    assert(json.find("\"artist\":\"Phone sender\"") != std::string::npos);
    assert(json.find("\"album\":\"Actual DMAP fields\"") != std::string::npos);
    unsigned char png[33] = {137,80,78,71,13,10,26,10,0,0,0,13,'I','H','D','R',0,0,1,0,0,0,1,0,8,6};
    audio_set_coverart(NULL, png, sizeof png);
    struct stat st;
    std::string cover_path = std::string(directory) + "/cover.png";
    assert(!stat(cover_path.c_str(), &st) && st.st_size == sizeof png && (st.st_mode & 0777) == 0600);
    assert(read_file(json_path).find("\"file\":\"cover.png\"") != std::string::npos && !render_coverart);
    audio_stop_coverart_rendering(NULL);
    assert(mgu_metadata_title.empty() && access(cover_path.c_str(), F_OK) && !reset_loop);
    markers(capture, 8, 6);
    format(audio, 2, false, false); audio_process(NULL, NULL, &audio); markers(capture, 9, 6);
    conn_init(NULL); conn_init(NULL); conn_destroy(NULL);
    assert(g_atomic_int_get(&mgu_audio_playing));
    conn_destroy(NULL);
    assert(!g_atomic_int_get(&mgu_audio_playing) && !g_atomic_int_get(&mgu_audio_kind) && !reset_loop);
    markers(capture, 9, 7);

    std::string all = captured(capture);
    assert(occurrences(all, "MGU_FEATURES auto-media\n") == 1);
    assert(all.find("MGU_FEATURES audio-only\n") == std::string::npos);
    assert(occurrences(all, "MGU_MODE audio\n") == 9);
    assert(occurrences(all, "MGU_MODE mirror\n") == 3);
    assert(occurrences(all, "MGU_MODE hls\n") == 1);
    assert(all.find("MGU_MODE audio\n") < all.find("MGU_AUDIO_PLAY\n"));
    assert(dup2(saved_stdout, fileno(stdout)) >= 0);
    close(saved_stdout); fclose(capture);
    video_renderer_destroy(); raop_destroy(raop); logger_destroy(render_logger);
    unlink(json_path.c_str()); close(mgu_metadata_directory); mgu_metadata_directory = -1;
    assert(!rmdir(directory));
    puts("Automatic media: full discovery, screen/standalone audio intent, ambiguous AAC grace, HLS ownership, real metadata and persistent handoff passed");
}
