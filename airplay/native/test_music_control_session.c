/* Exercise real patched request handling before/after RAOP authentication. */
#include "../../.build/airplay/uxplay-source/lib/raop.c"
static int exports, clears;
static const char *expected_id = "ABCD1234", *expected_token = "123456789";
static void remote(void *cls, void *owner, const unsigned char *peer, int length,
                   unsigned int zone, const char *id, const char *token) {
    (void)cls; (void)owner; (void)zone;
    if (!token) { clears++; return; }
    assert(length == 4 && peer[0] == 192 && !strcmp(id, expected_id) && !strcmp(token, expected_token));
    exports++;
}
static void options(raop_conn_t *conn, bool credentials) {
    char input[256];
    int length = snprintf(input, sizeof input, "OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n%s\r\n",
        credentials ? "DACP-ID: ABCD1234\r\nActive-Remote: 123456789\r\n" : "");
    http_request_t *request = http_request_init();
    http_request_add_data(request, input, length); assert(http_request_is_complete(request));
    http_response_t *response = NULL;
    conn_request(conn, request, &response); assert(response);
    http_request_destroy(request); http_response_destroy(response);
}
static void ignore_audio(void *cls, raop_ntp_t *ntp, audio_decode_struct *data) { (void)cls; (void)ntp; (void)data; }
static void ignore_video(void *cls, raop_ntp_t *ntp, video_decode_struct *data) { (void)cls; (void)ntp; (void)data; }
static void ignore_format(void *cls, unsigned char *ct, unsigned short *spf, bool *screen, bool *media, uint64_t *format) {
    (void)cls; (void)ct; (void)spf; (void)screen; (void)media; (void)format;
}
static bool current_owner = true;
static bool selected(void *cls, void *owner) { (void)cls; (void)owner; return current_owner; }

static void setup_stream(raop_conn_t *conn, unsigned int codec, bool credentials) {
    plist_t root = plist_new_dict(), streams = plist_new_array(), stream = plist_new_dict();
    plist_dict_set_item(stream, "type", plist_new_uint(96));
    plist_dict_set_item(stream, "ct", plist_new_uint(codec));
    plist_dict_set_item(stream, "spf", plist_new_uint(352));
    plist_dict_set_item(stream, "controlPort", plist_new_uint(0));
    plist_dict_set_item(stream, "isMedia", plist_new_bool(codec == 2));
    plist_dict_set_item(stream, "usingScreen", plist_new_bool(codec == 8));
    plist_array_append_item(streams, stream); plist_dict_set_item(root, "streams", streams);
    char *body = NULL; uint32_t bytes = 0; plist_to_bin(root, &body, &bytes);
    char header[512]; int header_bytes = snprintf(header, sizeof header,
        "SETUP /stream RTSP/1.0\r\nCSeq: 8\r\n%s%s%s%s%sContent-Type: application/x-apple-binary-plist\r\nContent-Length: %u\r\n\r\n",
        credentials ? "DACP-ID: " : "", credentials ? expected_id : "", credentials ? "\r\nActive-Remote: " : "",
        credentials ? expected_token : "", credentials ? "\r\n" : "", bytes);
    http_request_t *request = http_request_init(); http_request_add_data(request, header, header_bytes);
    http_request_add_data(request, body, bytes); assert(http_request_is_complete(request));
    http_response_t *response = NULL; conn_request(conn, request, &response);
    assert(response && http_response_get_status(response) == 200 && !http_response_get_disconnect(response));
    assert(raop_rtp_is_running(conn->raop_rtp));
    http_request_destroy(request); http_response_destroy(response); plist_mem_free(body); plist_free(root);
}

static void reused_stream_test(void) {
    const int before = exports;
    raop_callbacks_t callbacks = {0};
    callbacks.audio_process = ignore_audio; callbacks.video_process = ignore_video;
    callbacks.audio_get_format = ignore_format; callbacks.music_control = remote;
    callbacks.audio_stream_is_current = selected;
    raop_t *raop = raop_init(&callbacks); assert(raop);
    assert(raop_init2(raop, 0, "02:00:00:00:00:01", "") == 0);
    unsigned char address[] = {192,168,1,15};
    raop_conn_t *conn = conn_init(raop, address, 4, address, 4, 0); assert(conn);
    conn->connection_type = CONNECTION_TYPE_RAOP; conn->authenticated = true;
    timing_protocol_t protocol = TP_UNSPECIFIED;
    conn->raop_ntp = raop_ntp_init(raop->logger, &callbacks, "127.0.0.1", 4, 0, &protocol);
    assert(conn->raop_ntp);
    const unsigned char aes[16] = {0};
    conn->raop_rtp = raop_rtp_init(raop->logger, &callbacks, conn->raop_ntp, "127.0.0.1", 4, aes, aes);
    assert(conn->raop_rtp);
    setup_stream(conn, 8, true); assert(exports == before + 1 && conn->mgu_control_published);
    const int first_clears = clears;
    expected_id = "1234ABCD"; expected_token = "987654321";
    setup_stream(conn, 2, true);
    assert(exports == before + 2 && clears > first_clears && conn->mgu_control_published);
    assert(!strcmp(conn->mgu_dacp_id, expected_id) && !strcmp(conn->mgu_active_remote, expected_token));
    setup_stream(conn, 2, false);
    assert(exports == before + 2 && !conn->mgu_control_published && !conn->mgu_active_remote[0]);
    current_owner = false;
    setup_stream(conn, 2, true); assert(exports == before + 2 && !conn->mgu_control_published);
    current_owner = true;
    setup_stream(conn, 2, true); assert(exports == before + 3 && conn->mgu_control_published);
    conn_destroy(conn); raop_destroy(raop);
    puts("Reused real SETUP96 refreshes authenticated DACP epochs, rejects stale owners, and never inherits missing credentials");
}
int main(void) {
    raop_t raop = {0}; raop.logger = logger_init(); raop.callbacks.music_control = remote;
    unsigned char peer[] = {192, 168, 1, 15};
    raop_conn_t conn = {0}; conn.raop = &raop; conn.connection_type = CONNECTION_TYPE_RAOP;
    conn.remote = peer; conn.remotelen = 4;
    options(&conn, true); assert(exports == 0); /* pre-pairing credentials */
    conn.raop_rtp = (raop_rtp_t *) &conn;
    options(&conn, false); assert(exports == 0); /* transport is insufficient */
    conn.authenticated = true; options(&conn, false); assert(exports == 1);
    options(&conn, true); assert(exports == 1); /* publish once per audio session */
    mgu_music_control_clear(&conn); assert(clears == 1 && !conn.mgu_control_published);
    assert(!conn.mgu_active_remote[0] && !conn.mgu_dacp_id[0]);
    options(&conn, false); assert(exports == 1); /* no previous session credentials */
    conn.authenticated = false; conn.mgu_pair_verified = true;
    conn.raop_rtp = NULL; options(&conn, true); assert(exports == 1);
    conn.raop_rtp = (raop_rtp_t *) &conn; options(&conn, false); assert(exports == 2);
    /* Typed audio TEARDOWN revokes controls even with TCP still connected. */
    conn.raop_rtp = NULL;
    plist_t root = plist_new_dict(), streams = plist_new_array(), stream = plist_new_dict();
    plist_dict_set_item(stream, "type", plist_new_uint(96)); plist_array_append_item(streams, stream);
    plist_dict_set_item(root, "streams", streams);
    char *body = NULL; uint32_t bytes = 0; plist_to_bin(root, &body, &bytes);
    char header[256]; int header_bytes = snprintf(header, sizeof header,
        "TEARDOWN /stream RTSP/1.0\r\nCSeq: 2\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: %u\r\n\r\n", bytes);
    http_request_t *request = http_request_init(); http_request_add_data(request, header, header_bytes);
    http_request_add_data(request, body, bytes); assert(http_request_is_complete(request));
    http_response_t *response = NULL; conn_request(&conn, request, &response);
    assert(clears == 2 && !conn.mgu_control_published && !conn.mgu_active_remote[0]);
    assert(conn.mgu_pair_verified); /* the authenticated connection can SETUP again */
    conn.raop_rtp = (raop_rtp_t *) &conn; options(&conn, false); assert(exports == 2);
    options(&conn, true); assert(exports == 3);
    http_request_destroy(request); http_response_destroy(response); plist_mem_free(body); plist_free(root);
    logger_destroy(raop.logger);
    reused_stream_test();
    puts("DACP export requires verified/authenticated RAOP, fresh stream credentials, and revokes on audio TEARDOWN");
    return 0;
}
