/* Native control regression against the actual patched UxPlay handlers. */
#define _GNU_SOURCE
#include "../../.build/airplay/uxplay-source/lib/raop.c"
static const char *session = "11111111-2222-4333-8444-555555555555";
static const char *a = "aaaaaaaa-1111-4222-8333-444444444444";
static const char *b = "bbbbbbbb-1111-4222-8333-444444444444";
static const char *c = "cccccccc-1111-4222-8333-444444444444";
static const char *d = "dddddddd-1111-4222-8333-444444444444";
static int plays, resets, stops;
static bool detached, inherited;
static void play(void *cls, const char *uri, float start) {
    (void)uri; (void)start; plays++; inherited = raop_playlist_continue_detached(cls);
}
static bool is_detached(void *cls) { (void)cls; return detached; }
static void reset(void *cls, reset_type_t type) { (void)cls; assert(type == RESET_TYPE_HLS_EOS); resets++; detached = false; }
static void stop(void *cls) { (void)cls; stops++; }
static float removed(void *cls) { (void)cls; return 42.0f; }
static void info(void *cls, playback_info_t *out) {
    (void)cls; memset(out, 0, sizeof *out); out->duration = 42.0; out->position = 41.0; out->rate = 1.0f;
}
static int dispatch(raop_t *raop, const char *path, plist_t root) {
    char *body = NULL; uint32_t bytes = 0; if (root) plist_to_bin(root, &body, &bytes);
    char header[512]; int size = snprintf(header, sizeof header,
        "POST %s HTTP/1.1\r\nHost: receiver\r\nX-Apple-Session-ID: %s\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: %u\r\n\r\n", path, session, bytes);
    http_request_t *request = http_request_init(); http_request_add_data(request, header, size);
    if (bytes) http_request_add_data(request, body, bytes); assert(http_request_is_complete(request));
    http_response_t *response = http_response_create(); http_response_init(response, "HTTP/1.1", 200, "OK");
    raop_conn_t conn = {0}; conn.raop = raop; char *reply = NULL; int length = 0;
    if (!strcmp(path, "/play")) http_handler_play(&conn, request, response, &reply, &length);
    else if (!strcmp(path, "/action")) http_handler_action(&conn, request, response, &reply, &length);
    else if (!strcmp(path, "/playback-info")) http_handler_playback_info(&conn, request, response, &reply, &length);
    else http_handler_set_property(&conn, request, response, &reply, &length);
    int status = http_response_get_status(response); free(reply); plist_mem_free(body);
    http_request_destroy(request); http_response_destroy(response); return status;
}
static int item(raop_t *raop, const char *uuid, const char *location, bool insert) {
    plist_t play = plist_new_dict(); plist_dict_set_item(play, "uuid", plist_new_string(uuid));
    if (location) plist_dict_set_item(play, "Content-Location", plist_new_string(location));
    plist_dict_set_item(play, "clientProcName", plist_new_string("YouTube"));
    plist_t root = play;
    if (insert) {
        root = plist_new_dict(); plist_t params = plist_new_dict();
        plist_dict_set_item(params, "item", play); plist_dict_set_item(root, "params", params);
        plist_dict_set_item(root, "type", plist_new_string("playlistInsert"));
    }
    int status = dispatch(raop, insert ? "/action" : "/play", root); plist_free(root); return status;
}
static void action(raop_t *raop, unsigned value) {
    plist_t root = plist_new_dict(); plist_dict_set_item(root, "value", plist_new_uint(value));
    assert(dispatch(raop, "/setProperty?actionAtItemEnd", root) == 200); plist_free(root);
}
static int remove_item(raop_t *raop, const char *uuid) {
    plist_t root = plist_new_dict(), params = plist_new_dict(), play = plist_new_dict();
    plist_dict_set_item(play, "uuid", plist_new_string(uuid)); plist_dict_set_item(params, "item", play);
    plist_dict_set_item(root, "params", params); plist_dict_set_item(root, "type", plist_new_string("playlistRemove"));
    int status = dispatch(raop, "/action", root); plist_free(root); return status;
}
static pthread_mutex_t test_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t test_condition = PTHREAD_COND_INITIALIZER;
static pthread_t successor;
static raop_t *concurrent_server;
static bool attempting;
static void *next_item(void *unused) {
    (void)unused; pthread_mutex_lock(&test_mutex); attempting = true;
    pthread_cond_signal(&test_condition); pthread_mutex_unlock(&test_mutex);
    assert(item(concurrent_server, d, "https://media.example/d.mp4", false) == 200); return NULL;
}
static bool ended_with_concurrent_play(void) {
    assert(pthread_create(&successor, NULL, next_item, NULL) == 0);
    pthread_mutex_lock(&test_mutex);
    while (!attempting) pthread_cond_wait(&test_condition, &test_mutex);
    pthread_mutex_unlock(&test_mutex); return true;
}
static bool natural(void) { return true; }
static void ready(void) { assert(!strcmp(concurrent_server->mgu_active_uuid, c)); }
int main(void) {
    raop_t server = {0}; server.current_video = -1; server.logger = logger_init();
    server.callbacks.cls = &server; server.callbacks.on_video_play = play; server.callbacks.video_reset = reset;
    server.callbacks.is_hls_detached = is_detached; server.callbacks.on_video_stop = stop;
    server.callbacks.on_video_acquire_playback_info = info;
    server.callbacks.on_video_playlist_remove = removed;
    assert(item(&server, a, "https://media.example/a.mp4", false) == 200); assert(plays == 1);
    assert(get_playlist_by_uuid(&server, a) == server.current_video);
    assert(item(&server, a, "https://media.example/a.mp4", false) == 200 && plays == 1);
    assert(item(&server, b, "file:///invalid", false) == 400);
    assert(!strcmp(server.mgu_active_uuid, a));
    assert(item(&server, b, "https://media.example/b.mp4", false) == 200 && plays == 2);
    assert(dispatch(&server, "/playback-info", NULL) == 200); detached = true;
    raop_handle_eos(&server); raop_handle_eos(&server);
    assert(resets == 1 && server.mgu_terminal && server.mgu_terminal_info.position == 42.0);
    assert(item(&server, c, "https://media.example/c.mp4", true) == 200 && plays == 3 && inherited);
    assert(get_playlist_by_uuid(&server, c) == server.current_video);
    assert(item(&server, c, "https://media.example/c.mp4", true) == 200 && plays == 3);
    assert(item(&server, "bad", "https://media.example/x.mp4", true) == 400);
    /* The whole watcher sequence owns state until reset is finished. */
    concurrent_server = &server;
    raop_playlist_poll_end(&server, ended_with_concurrent_play, natural, ready);
    assert(pthread_join(successor, NULL) == 0);
    assert(plays == 4 && !server.mgu_terminal && !strcmp(server.mgu_active_uuid, d));
    raop_playlist_cancel(&server);
    assert(item(&server, c, "https://media.example/c.mp4", true) == 409);
    assert(item(&server, d, "https://media.example/d.mp4", false) == 200 && plays == 5);
    assert(get_playlist_by_uuid(&server, d) == server.current_video);
    assert(remove_item(&server, d) == 200 && server.current_video == -1);
    assert(item(&server, d, "https://media.example/d.mp4", false) == 200 && plays == 6);
    /* Pause/none never produce the four-message advance handshake. */
    action(&server, 1); raop_handle_eos(&server);
    assert(server.mgu_terminal_info.rate == 0.0f && (!server.mgu_reverse_queue || !((struct mgu_reverse_queue *)server.mgu_reverse_queue)->count));
    assert(item(&server, a, "https://media.example/a.mp4", false) == 200);
    action(&server, 2); raop_handle_eos(&server);
    assert(!server.mgu_reverse_queue || !((struct mgu_reverse_queue *)server.mgu_reverse_queue)->count);
    assert(item(&server, b, "https://media.example/b.mp4", false) == 200);
    raop_handle_hls_stop(&server); assert(!server.mgu_terminal && server.current_video == -1);
    assert(item(&server, c, "https://media.example/c.mp4", true) == 409);
    raop_destroy_airplay_video(&server, -1); mgu_reverse_destroy(&server); logger_destroy(server.logger);
    puts("Playlist control: sequential items, UUID identity, duplicate/retry, detached continuation, serialized EOS, pause/none and stop passed");
    return 0;
}
