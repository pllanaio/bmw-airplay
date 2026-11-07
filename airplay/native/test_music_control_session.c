/* Exercise real patched request handling before/after RAOP authentication. */
#include "../../.build/airplay/uxplay-source/lib/raop.c"
static int exports, clears;
static void remote(void *cls, void *owner, const unsigned char *peer, int length,
                   unsigned int zone, const char *id, const char *token) {
    (void)cls; (void)owner; (void)zone;
    if (!token) { clears++; return; }
    assert(length == 4 && peer[0] == 192 && !strcmp(id, "ABCD1234") && !strcmp(token, "123456789"));
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
    puts("DACP export requires verified/authenticated RAOP, fresh stream credentials, and revokes on audio TEARDOWN");
    return 0;
}
