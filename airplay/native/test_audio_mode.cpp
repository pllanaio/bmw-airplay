/* Exercise the actual patched receiver profile and callbacks without a phone
 * or audio hardware. Protocol compatibility with a specific sender still
 * requires an iPhone/HeadUnit test. */
#define main mgu_upstream_main
#include "../../.build/airplay/uxplay-source/uxplay.cpp"
#undef main
#include <cassert>
#include <unistd.h>

static bool feature(uint64_t features, unsigned int bit) {
    return (features & (uint64_t(1) << bit)) != 0;
}

static unsigned int occurrences(const std::string &value, const std::string &needle) {
    unsigned int count = 0;
    for (size_t at = 0; (at = value.find(needle, at)) != std::string::npos; at += needle.size()) ++count;
    return count;
}

int main() {
    render_logger = logger_init();
    std::vector<char> hardware = {2, 0, 0, 0, 0, 1};
    hls_support = true;
    h265_support = true;
    assert(start_dnssd(hardware, "audio-profile-test") == 0);
    uint64_t normal_features = dnssd_get_airplay_features(dnssd);
    for (unsigned int bit : {0, 1, 4, 7, 42}) assert(feature(normal_features, bit));
    dnssd_destroy(dnssd);
    dnssd = NULL;

    fflush(stdout);
    const int saved_stdout = dup(fileno(stdout));
    FILE *capture = tmpfile();
    assert(saved_stdout >= 0 && capture);
    assert(dup2(fileno(capture), fileno(stdout)) >= 0);
    setenv("MGU_AUDIO_ONLY", "1", 1);
    setenv("MGU_AUTO_MEDIA", "0", 1);
    render_coverart = true;
    mgu_audio_configure();
    assert(mgu_audio_only && !use_video && !hls_support && !h265_support && !render_coverart);
    assert(videosink == "0");
    assert(!g_atomic_int_get(&mgu_audio_playing));
    assert(start_dnssd(hardware, "audio-profile-test") == 0);
    uint64_t audio_features = dnssd_get_airplay_features(dnssd);
    for (unsigned int bit : {0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 33, 34, 42})
        assert(!feature(audio_features, bit));
    for (unsigned int bit : {9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30})
        assert(feature(audio_features, bit) == feature(normal_features, bit));
    assert(feature(audio_features, 9) && feature(audio_features, 30));

    /* Avoid hardware output while exercising the actual packet callbacks. */
    use_audio = false;
    unsigned char bytes[] = {0};
    audio_decode_struct packet = {};
    packet.data = bytes;
    packet.data_len = sizeof bytes;
    packet.ct = 2;
    audio_process(NULL, NULL, &packet);
    audio_process(NULL, NULL, &packet);
    assert(g_atomic_int_get(&mgu_audio_playing));
    audio_flush(NULL);
    audio_flush(NULL);
    assert(!g_atomic_int_get(&mgu_audio_playing));
    assert(!reset_loop && url.empty());
    audio_process(NULL, NULL, &packet);
    assert(g_atomic_int_get(&mgu_audio_playing));
    audio_stop_coverart_rendering(NULL); /* audio/type 96 TEARDOWN */
    assert(!g_atomic_int_get(&mgu_audio_playing));
    assert(!reset_loop);

    /* A stale/misrouted video command cannot create an HLS or mirror surface
     * or reset the receiver while an audio stream is playing. */
    audio_process(NULL, NULL, &packet);
    video_decode_struct video_packet = {};
    video_process(NULL, NULL, &video_packet);
    on_video_play(NULL, "http://127.0.0.1/should-not-start.m3u8", 0.0f);
    video_reset(NULL, RESET_TYPE_RTP_SHUTDOWN);
    assert(g_atomic_int_get(&mgu_audio_playing));
    assert(!g_atomic_int_get(&mgu_mirror_active));
    assert(!video_renderer_is_hls_active() && url.empty() && !reset_loop);

    conn_init(NULL);
    conn_init(NULL);
    conn_destroy(NULL);
    assert(g_atomic_int_get(&mgu_audio_playing));
    conn_destroy(NULL);
    assert(!g_atomic_int_get(&mgu_audio_playing));
    assert(open_connections == 0 && !reset_loop);
    audio_process(NULL, NULL, &packet); /* another song without receiver restart */
    assert(g_atomic_int_get(&mgu_audio_playing));

    fflush(stdout);
    rewind(capture);
    std::string markers;
    char buffer[4096];
    size_t count;
    while ((count = fread(buffer, 1, sizeof buffer, capture))) markers.append(buffer, count);
    assert(dup2(saved_stdout, fileno(stdout)) >= 0);
    close(saved_stdout);
    fclose(capture);
    assert(occurrences(markers, "MGU_FEATURES audio-only\n") == 1);
    assert(occurrences(markers, "MGU_AUDIO_PLAY\n") == 4);
    assert(occurrences(markers, "MGU_AUDIO_WAITING\n") == 4);
    assert(markers.find("MGU_MODE mirror\n") == std::string::npos);
    assert(markers.find("MGU_MODE hls\n") == std::string::npos);
    dnssd_destroy(dnssd);
    dnssd = NULL;
    logger_destroy(render_logger);
    puts("Native RAOP-only capabilities, first-packet state, flush/teardown, waiting and next-song callbacks passed");
}
