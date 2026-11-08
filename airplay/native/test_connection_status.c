/* Actual patched RAOP handlers: verified transport intent and accepted media
 * own connection status; probes/local fetches and unrelated reverse UUIDs do not. */
#define _GNU_SOURCE
#include "../../.build/airplay/uxplay-source/lib/raop.c"
#include "../../.build/airplay/uxplay-source/lib/httpd.c"
static const char *session = "11111111-2222-4333-8444-555555555555";
static const char *other = "99999999-2222-4333-8444-555555555555";
static const char *item_a = "aaaaaaaa-1111-4222-8333-444444444444";
static const char *item_b = "bbbbbbbb-1111-4222-8333-444444444444";
static int events[64], event_count, plays;
static void audio(void *cls, raop_ntp_t *ntp, audio_decode_struct *data) {(void)cls;(void)ntp;(void)data;}
static void video(void *cls, raop_ntp_t *ntp, video_decode_struct *data) {(void)cls;(void)ntp;(void)data;}
static void status(void *cls, bool connected) {(void)cls;assert(event_count < 64);events[event_count++] = connected;}
static void play(void *cls, const char *url, float start) {(void)cls;(void)url;(void)start;plays++;}
static void stopped(void *cls) {(void)cls;}
static void reset(void *cls, reset_type_t type) {(void)cls;(void)type;}
static void quiet(void *cls, int level, const char *message) {(void)cls;(void)level;(void)message;}
static raop_conn_t *connection(raop_t *server, connection_type_t type, const char *session_id, int peer) {
    unsigned char address[] = {127, 0, 0, (unsigned char)peer};
    raop_conn_t *conn = conn_init(server, address, 4, address, 4, 0); assert(conn);
    conn->connection_type = type;
    if (session_id) conn->client_session_id = strdup(session_id);
    return conn;
}
static int dispatch(raop_conn_t *conn, const char *method, const char *url, bool rtsp, plist_t body) {
    char *bytes = NULL; uint32_t length = 0;
    if (body) plist_to_bin(body, &bytes, &length);
    char header[1024];
    int size = snprintf(header, sizeof header,
        "%s %s %s\r\nHost: receiver\r\n%s%s%sContent-Type: application/x-apple-binary-plist\r\nContent-Length: %u\r\n\r\n",
        method, url, rtsp ? "RTSP/1.0" : "HTTP/1.1", rtsp ? "CSeq: 1\r\n" : "",
        conn->client_session_id ? "X-Apple-Session-ID: " : "",
        conn->client_session_id ? conn->client_session_id : "", length);
    /* Append the session's line ending separately, preserving the request's
       exact binary plist body for the real llhttp + conn_request path. */
    if (conn->client_session_id) {
        size = snprintf(header, sizeof header,
            "%s %s HTTP/1.1\r\nHost: receiver\r\nX-Apple-Session-ID: %s\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: %u\r\n\r\n",
            method, url, conn->client_session_id, length);
    }
    http_request_t *request = http_request_init(); http_request_add_data(request, header, size);
    if (length) http_request_add_data(request, bytes, length);
    assert(http_request_is_complete(request));
    http_response_t *response = NULL; conn_request(conn, request, &response); assert(response);
    int code = http_response_get_status(response);
    http_request_destroy(request); http_response_destroy(response); plist_mem_free(bytes);
    return code;
}
static plist_t streams(bool audio_stream, bool mirror_stream) {
    plist_t root = plist_new_dict(), list = plist_new_array();
    if (audio_stream) {
        plist_t stream = plist_new_dict();
        plist_dict_set_item(stream, "type", plist_new_uint(96));
        plist_dict_set_item(stream, "ct", plist_new_uint(2));
        plist_dict_set_item(stream, "spf", plist_new_uint(352));
        plist_array_append_item(list, stream);
    }
    if (mirror_stream) {
        plist_t stream = plist_new_dict();
        plist_dict_set_item(stream, "type", plist_new_uint(110));
        plist_dict_set_item(stream, "streamConnectionID", plist_new_uint(123));
        plist_array_append_item(list, stream);
    }
    plist_dict_set_item(root, "streams", list); return root;
}
static void transport(raop_conn_t *conn, bool setup, bool audio_stream, bool mirror_stream) {
    plist_t body = streams(audio_stream, mirror_stream);
    assert(dispatch(conn, setup ? "SETUP" : "TEARDOWN", "/stream", true, body) == 200);
    plist_free(body);
}
static void initialize_rtp(raop_conn_t *conn) {
    unsigned char aes[16] = {0}; timing_protocol_t timing = TP_NONE;
    conn->raop_ntp = raop_ntp_init(conn->raop->logger, &conn->raop->callbacks, "127.0.0.1", 4, 0, &timing);
    assert(conn->raop_ntp);
    conn->raop_rtp = raop_rtp_init(conn->raop->logger, &conn->raop->callbacks, conn->raop_ntp, "127.0.0.1", 4, aes, aes);
    conn->raop_rtp_mirror = raop_rtp_mirror_init(conn->raop->logger, &conn->raop->callbacks, conn->raop_ntp, "127.0.0.1", 4, aes);
    assert(conn->raop_rtp && conn->raop_rtp_mirror);
}
static void media(raop_conn_t *conn, const char *uuid, bool insert) {
    plist_t item = plist_new_dict();
    plist_dict_set_item(item, "uuid", plist_new_string(uuid));
    plist_dict_set_item(item, "Content-Location", plist_new_string("https://media.example/video.mp4"));
    plist_dict_set_item(item, "clientProcName", plist_new_string("YouTube"));
    plist_t root = item;
    if (insert) {
        root = plist_new_dict(); plist_t params = plist_new_dict();
        plist_dict_set_item(params, "item", item); plist_dict_set_item(root, "params", params);
        plist_dict_set_item(root, "type", plist_new_string("playlistInsert"));
    }
    assert(dispatch(conn, "POST", insert ? "/action" : "/play", false, root) == 200);
    plist_free(root);
}
/* Reverse-ready is normally called by HTTPD after its complete 101 reaches
 * the socket. Register a real socketpair in HTTPD and exercise the same hook. */
static void reverse(raop_conn_t *conn, int slot, int sockets[2]) {
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
    http_connection_t *wire = &conn->raop->httpd->connections[slot];
    wire->socket_fd = sockets[0]; wire->user_data = conn; wire->connected = 1; wire->type = CONNECTION_TYPE_PTTH;
    mgu_session_reverse_ready(conn);
}
static void drop_reverse(raop_conn_t *conn, int slot, int sockets[2]) {
    http_connection_t *wire = &conn->raop->httpd->connections[slot];
    conn_destroy(conn); wire->user_data = NULL; wire->connected = 0; wire->socket_fd = -1;
    close(sockets[0]); close(sockets[1]);
}
int main(void) {
    raop_callbacks_t callbacks = {0}; callbacks.audio_process = audio; callbacks.video_process = video;
    callbacks.session_status = status; callbacks.on_video_play = play; callbacks.on_video_stop = stopped; callbacks.video_reset = reset;
    raop_t *server = raop_init(&callbacks); assert(server); raop_set_log_callback(server, quiet, NULL);
    char directory[] = "/tmp/mgu-session-status-XXXXXX"; assert(mkdtemp(directory));
    char key[256]; snprintf(key, sizeof key, "%s/key", directory);
    assert(raop_init2(server, 0, "02:00:00:00:04:06", key) == 0);
    raop_set_plist(server, "hls", 1);
    raop_session_announce(server); assert(event_count == 1 && !events[0]);
    raop_conn_t *probe = connection(server, CONNECTION_TYPE_RAOP, NULL, 1);
    probe->mgu_pair_verified = true;
    assert(dispatch(probe, "OPTIONS", "*", true, NULL) == 200);
    raop_conn_t *local = connection(server, CONNECTION_TYPE_HLS, NULL, 1);
    assert(dispatch(local, "GET", "/missing/master.m3u8", false, NULL) == 404);
    raop_conn_t *wrong = connection(server, CONNECTION_TYPE_PTTH, other, 1); int wrong_sockets[2];
    reverse(wrong, 0, wrong_sockets);
    assert(!raop_session_is_connected(server) && event_count == 1);

    raop_conn_t *audio_conn = connection(server, CONNECTION_TYPE_RAOP, NULL, 1); initialize_rtp(audio_conn);
    transport(audio_conn, true, true, false);
    assert(!raop_session_is_connected(server)); /* RTP allocation alone is not authentication. */
    audio_conn->mgu_pair_verified = true;
    transport(audio_conn, true, true, false); assert(raop_session_is_connected(server));
    transport(audio_conn, false, true, false);
    assert(!raop_session_is_connected(server)); /* Wrong-UUID reverse probe cannot retain it. */
    audio_conn->mgu_pair_verified = false; audio_conn->authenticated = true;
    transport(audio_conn, true, true, true); assert(raop_session_is_connected(server));
    transport(audio_conn, false, true, false);
    assert(raop_session_is_connected(server) && raop_rtp_mirror_is_running(audio_conn->raop_rtp_mirror));
    transport(audio_conn, false, false, true); assert(!raop_session_is_connected(server));
    transport(audio_conn, true, true, true);
    transport(audio_conn, false, true, true);
    assert(!raop_rtp_is_running(audio_conn->raop_rtp) && !raop_rtp_mirror_is_running(audio_conn->raop_rtp_mirror));
    assert(!raop_session_is_connected(server));
    conn_destroy(audio_conn);

    raop_conn_t *first = connection(server, CONNECTION_TYPE_AIRPLAY, session, 1);
    media(first, item_a, false); assert(plays == 1 && raop_session_is_connected(server));
    assert(!wrong->mgu_session_attached);
    raop_conn_t *valid = connection(server, CONNECTION_TYPE_PTTH, session, 1); int valid_sockets[2];
    reverse(valid, 1, valid_sockets); assert(valid->mgu_session_attached);
    conn_destroy(first); assert(raop_session_is_connected(server)); /* Between videos. */
    drop_reverse(wrong, 0, wrong_sockets);
    raop_conn_t *next = connection(server, CONNECTION_TYPE_AIRPLAY, session, 1);
    media(next, item_b, true); assert(plays == 2);
    drop_reverse(valid, 1, valid_sockets);
    assert(raop_session_is_connected(server)); /* /action's control owner remains. */
    assert(dispatch(next, "POST", "/stop", false, NULL) == 200);
    assert(raop_session_is_connected(server)); /* Ending an item keeps the route. */
    raop_conn_t *retained = connection(server, CONNECTION_TYPE_PTTH, session, 1); int retained_sockets[2];
    reverse(retained, 2, retained_sockets); assert(retained->mgu_session_attached);
    conn_destroy(next); assert(raop_session_is_connected(server));
    raop_conn_t *replacement = connection(server, CONNECTION_TYPE_PTTH, session, 1); int replacement_sockets[2];
    int before = event_count;
    reverse(replacement, 3, replacement_sockets); assert(replacement->mgu_session_attached && event_count == before);
    drop_reverse(retained, 2, retained_sockets); assert(raop_session_is_connected(server));
    raop_conn_t *other_peer = connection(server, CONNECTION_TYPE_PTTH, session, 2); int peer_sockets[2];
    reverse(other_peer, 4, peer_sockets); assert(!other_peer->mgu_session_attached);
    assert(!raop_session_is_connected(server)); /* Replaced by an unrelated peer. */
    drop_reverse(replacement, 3, replacement_sockets); drop_reverse(other_peer, 4, peer_sockets);
    assert(!raop_session_is_connected(server));
    raop_session_announce(server); assert(!events[event_count - 1]);
    conn_destroy(probe); conn_destroy(local);
    assert(!server->mgu_session_connections);
    raop_destroy(server); unlink(key); assert(rmdir(directory) == 0);
    puts("Session status: verified/digest SETUP, combined teardown, probe exclusion, accepted play/insert, bound PTTH retention/replacement and final disconnect passed");
    return 0;
}
