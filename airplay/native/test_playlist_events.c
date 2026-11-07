/* Exercise the real AirPlay HTTP server with a synthetic playlist sender.
   Reverse events must be ordered by complete ACKs, including split headers. */
#define _GNU_SOURCE
#include "../../.build/airplay/uxplay-source/lib/raop.c"
#include <poll.h>
#include <sys/time.h>

static int plays, resets;
static void log_message(void *cls, int level, const char *message) {
    (void)cls; (void)level; fprintf(stderr, "%s\n", message);
}
static void audio(void *cls, raop_ntp_t *ntp, audio_decode_struct *data) {(void)cls;(void)ntp;(void)data;}
static void video(void *cls, raop_ntp_t *ntp, video_decode_struct *data) {(void)cls;(void)ntp;(void)data;}
static void play(void *cls, const char *uri, float start) {(void)cls;(void)uri;(void)start;__sync_add_and_fetch(&plays, 1);}
static void reset(void *cls, reset_type_t type) {(void)cls;(void)type;__sync_add_and_fetch(&resets, 1);}
static void info(void *cls, playback_info_t *out) {
    (void)cls; memset(out, 0, sizeof(*out));
    out->duration = out->position = out->seek_duration = 42.0;
    out->rate = 1.0f; out->ready_to_play = true; out->playback_buffer_empty = true;
}
static void send_all(int fd, const char *data, size_t length) {
    while (length) { ssize_t sent = send(fd, data, length, MSG_NOSIGNAL); assert(sent > 0); data += sent; length -= sent; }
}
static int connect_sender(unsigned short port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0); assert(fd >= 0);
    struct sockaddr_in address = {0}; address.sin_family = AF_INET; address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0);
    return fd;
}
/* Read exactly one frame, leaving any following event unread in the socket. */
static void read_frame(int fd, char *header, size_t capacity, char **body) {
    size_t used = 0;
    while (used < capacity - 1) {
        struct pollfd pollfd = {fd, POLLIN, 0}; assert(poll(&pollfd, 1, 3000) == 1);
        assert(recv(fd, header + used, 1, 0) == 1); header[++used] = '\0';
        if (used >= 4 && !memcmp(header + used - 4, "\r\n\r\n", 4)) break;
    }
    assert(used < capacity - 1);
    const char *size = strcasestr(header, "\r\nContent-Length:");
    size_t length = size ? strtoul(size + strlen("\r\nContent-Length:"), NULL, 10) : 0;
    assert(length < 16384);
    *body = calloc(length + 1, 1); assert(*body);
    for (size_t got = 0; got < length;) {
        struct pollfd pollfd = {fd, POLLIN, 0}; assert(poll(&pollfd, 1, 3000) == 1);
        ssize_t count = recv(fd, *body + got, length - got, 0); assert(count > 0); got += count;
    }
}
static void request_bytes(int fd, const char *method, const char *uri, const char *payload, size_t length, char **body) {
    char header[1024];
    int bytes = snprintf(header, sizeof header, "%s %s HTTP/1.1\r\nHost: receiver\r\nX-Apple-Session-ID: 11111111-2222-4333-8444-555555555555\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: %zu\r\n\r\n", method, uri, length);
    send_all(fd, header, bytes); if (length) send_all(fd, payload, length);
    read_frame(fd, header, sizeof header, body); assert(!strncmp(header, "HTTP/1.1 200", 12));
}
static void request(int fd, const char *method, const char *uri, const char *payload, char **body) {
    request_bytes(fd, method, uri, payload, payload ? strlen(payload) : 0, body);
}
static void play_item(int fd, const char *uuid, bool insert) {
    plist_t item = plist_new_dict();
    plist_dict_set_item(item, "uuid", plist_new_string(uuid));
    plist_dict_set_item(item, "Content-Location", plist_new_string("http://127.0.0.1/video.m3u8"));
    plist_dict_set_item(item, "clientProcName", plist_new_string("YouTube"));
    plist_dict_set_item(item, "Start-Position-Seconds", plist_new_real(0.0));
    plist_t root = item;
    if (insert) {
        root = plist_new_dict(); plist_t params = plist_new_dict();
        plist_dict_set_item(root, "type", plist_new_string("playlistInsert"));
        plist_dict_set_item(params, "item", item); plist_dict_set_item(root, "params", params);
    }
    char *payload = NULL; uint32_t length = 0; plist_to_bin(root, &payload, &length); assert(payload);
    char *body = NULL; request_bytes(fd, "POST", insert ? "/action" : "/play", payload, length, &body);
    free(body); plist_mem_free(payload); plist_free(root);
}
static plist_t event(int fd, const char *key, const char *expected) {
    char header[2048], *body = NULL; read_frame(fd, header, sizeof header, &body);
    assert(!strncmp(header, "POST /event HTTP/1.1", 19));
    assert(strstr(header, "X-Apple-Session-ID: 11111111-2222-4333-8444-555555555555"));
    plist_t root = NULL; plist_from_xml(body, strlen(body), &root); assert(root); free(body);
    char *value = NULL; plist_get_string_val(plist_dict_get_item(root, key), &value);
    assert(value && !strcmp(value, expected)); plist_mem_free(value);
    return root;
}
static void no_event(int fd) {
    struct pollfd pollfd = {fd, POLLIN, 0}; assert(poll(&pollfd, 1, 100) == 0);
}
static void ack(int fd) { const char text[] = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"; send_all(fd, text, sizeof text - 1); }
static int upgrade_reverse(unsigned short port) {
    int reverse = connect_sender(port);
    const char upgrade[] = "POST /reverse HTTP/1.1\r\nHost: receiver\r\nX-Apple-Session-ID: 11111111-2222-4333-8444-555555555555\r\nX-Apple-Purpose: event\r\nConnection: Upgrade\r\nUpgrade: PTTH/1.0\r\nContent-Length: 0\r\n\r\n";
    send_all(reverse, upgrade, sizeof upgrade - 1);
    char header[2048], *body = NULL; read_frame(reverse, header, sizeof header, &body);
    assert(!strncmp(header, "HTTP/1.1 101", 12)); free(body); return reverse;
}
static void wait_unbound(raop_t *server) {
    for (int i = 0; i < 200; i++) {
        pthread_mutex_lock(&mgu_reverse_mutex); bool bound = server->mgu_reverse_owner != NULL; pthread_mutex_unlock(&mgu_reverse_mutex);
        if (!bound) return;
        usleep(10000);
    }
    assert(!"reverse disconnect timeout");
}
static void closed_reverse(int fd) {
    struct pollfd pollfd = {fd, POLLIN, 0}; assert(poll(&pollfd, 1, 3000) == 1);
    char byte; assert(recv(fd, &byte, 1, 0) == 0); close(fd);
}
static void simple_end(raop_t *server, int control, int reverse) {
    char *body = NULL; request(control, "GET", "/playback-info", NULL, &body); free(body);
    raop_handle_eos(server);
    plist_t item = event(reverse, "type", "itemPlayedToEnd"); plist_free(item); ack(reverse);
    item = event(reverse, "state", "stopped"); plist_free(item); ack(reverse);
    item = event(reverse, "type", "itemRemoved"); plist_free(item); ack(reverse);
    item = event(reverse, "type", "currentItemChanged"); plist_free(item); ack(reverse); no_event(reverse);
}
static void queue_fixture(raop_t *server, const char *name) {
    for (int i = 0; i < 200; i++) {
        pthread_mutex_lock(&mgu_reverse_mutex); bool bound = server->mgu_reverse_owner != NULL; pthread_mutex_unlock(&mgu_reverse_mutex);
        if (bound) break;
        assert(i < 199); usleep(10000);
    }
    plist_t fixture = plist_new_dict(); plist_dict_set_item(fixture, "type", plist_new_string(name));
    assert(mgu_reverse_send_plist(server, "11111111-2222-4333-8444-555555555555", fixture) == 0); plist_free(fixture);
}
static void busy_control_keeps_hls_responsive(int control, unsigned short port) {
    pthread_mutex_t *held = mgu_playlist_lock();
    const char busy[] = "GET /playback-info HTTP/1.1\r\nHost: receiver\r\nX-Apple-Session-ID: 11111111-2222-4333-8444-555555555555\r\nContent-Length: 0\r\n\r\n";
    send_all(control, busy, sizeof busy - 1);
    struct pollfd ready = {control, POLLIN, 0}; assert(poll(&ready, 1, 1000) == 1);
    char header[2048], *body = NULL; read_frame(control, header, sizeof header, &body);
    assert(!strncmp(header, "HTTP/1.1 503", 12));
    assert(strstr(header, "\r\nRetry-After: 1\r\n"));
    assert(strstr(header, "\r\nContent-Length: 0\r\n")); free(body);
    /* Renderer shutdown may await this GET while holding the playlist lock. */
    int hls = connect_sender(port);
    const char missing[] = "GET /missing.m3u8 HTTP/1.1\r\nHost: receiver\r\nContent-Length: 0\r\n\r\n";
    send_all(hls, missing, sizeof missing - 1);
    ready.fd = hls; ready.revents = 0; assert(poll(&ready, 1, 1000) == 1);
    read_frame(hls, header, sizeof header, &body);
    assert(!strncmp(header, "HTTP/1.1 404", 12)); free(body);
    shutdown(hls, SHUT_RDWR); close(hls);
    mgu_playlist_unlock(&held);
    /* The busy response preserves the original control connection. */
    request(control, "GET", "/playback-info", NULL, &body); free(body);
}
int main(void) {
    raop_callbacks_t callbacks = {0}; callbacks.audio_process = audio; callbacks.video_process = video;
    callbacks.on_video_play = play; callbacks.video_reset = reset; callbacks.on_video_acquire_playback_info = info;
    raop_t *server = raop_init(&callbacks); assert(server);
    raop_set_log_callback(server, log_message, NULL);
    char temporary[] = "/tmp/mgu-playlist-events-XXXXXX"; assert(mkdtemp(temporary));
    char keyfile[256]; snprintf(keyfile, sizeof keyfile, "%s/key", temporary);
    assert(raop_init2(server, 0, "02:11:22:33:44:55", keyfile) == 0);
    server->hls_support = true; logger_set_level(server->logger, LOGGER_ERR);
    unsigned short port = 0; assert(raop_start_httpd(server, &port) == 1); assert(port);
    raop_set_port(server, port);
    int reverse = upgrade_reverse(port);
    char *body = NULL;
    int control = connect_sender(port);
    play_item(control, "aaaaaaaa-1111-4222-8333-444444444444", false); assert(plays == 1);
    assert(server->current_video >= 0);
    request(control, "GET", "/playback-info", NULL, &body); free(body);
    busy_control_keeps_hls_responsive(control, port);
    raop_handle_eos(server);
    /* Calling EOS twice for the same item must not repeat the notification. */
    raop_handle_eos(server);
    plist_t item = event(reverse, "type", "itemPlayedToEnd"); plist_free(item);
    no_event(reverse);
    /* A partial response is not a complete ACK and cannot release the next event. */
    const char first[] = "HTTP/1.1 200 OK\r\nContent-Length:";
    send_all(reverse, first, 4); no_event(reverse);
    request(control, "GET", "/playback-info", NULL, &body); free(body);
    send_all(reverse, first + 4, sizeof first - 1 - 4); no_event(reverse);
    send_all(reverse, " 0\r\n\r\n", 6);
    item = event(reverse, "state", "stopped");
    char *reason = NULL; plist_get_string_val(plist_dict_get_item(item, "reason"), &reason);
    assert(reason && !strcmp(reason, "ended")); plist_mem_free(reason); plist_free(item); ack(reverse);
    item = event(reverse, "type", "itemRemoved");
    char *session = NULL; plist_get_string_val(plist_dict_get_item(item, "sessionID"), &session);
    assert(session && !strcmp(session, "11111111-2222-4333-8444-555555555555")); plist_mem_free(session); plist_free(item); ack(reverse);
    item = event(reverse, "type", "currentItemChanged"); plist_free(item); ack(reverse); no_event(reverse);
    request(control, "GET", "/playback-info", NULL, &body);
    item = NULL; plist_from_xml(body, strlen(body), &item); assert(item); free(body);
    double duration = 0, position = 0, rate = 0;
    plist_get_real_val(plist_dict_get_item(item, "duration"), &duration);
    plist_get_real_val(plist_dict_get_item(item, "position"), &position);
    plist_get_real_val(plist_dict_get_item(item, "rate"), &rate);
    assert(duration == 42.0 && position == duration && rate == 1.0); plist_free(item);
    /* The sender can issue the next item on the same control and reverse links. */
    play_item(control, "bbbbbbbb-1111-4222-8333-444444444444", true); assert(plays == 2); no_event(reverse);
    simple_end(server, control, reverse);
    play_item(control, "cccccccc-1111-4222-8333-444444444444", true); assert(plays == 3); no_event(reverse);
    simple_end(server, control, reverse);
    /* Returning to mirror/stop must permit replaying the same cached UUID. */
    raop_playlist_cancel(server);
    play_item(control, "cccccccc-1111-4222-8333-444444444444", false); assert(plays == 4);
    /* An ACK body must also be complete before the FIFO advances. */
    queue_fixture(server, "bodyFirst"); queue_fixture(server, "bodySecond");
    item = event(reverse, "type", "bodyFirst"); plist_free(item);
    const char body_ack[] = "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nx";
    send_all(reverse, body_ack, sizeof body_ack - 1); no_event(reverse);
    send_all(reverse, "yz", 2); item = event(reverse, "type", "bodySecond"); plist_free(item); ack(reverse); no_event(reverse);
    /* Cancelling an in-flight request closes that stream, so a stale ACK can
       never release an unrelated event subsequently sent on the same socket. */
    queue_fixture(server, "cancelled"); item = event(reverse, "type", "cancelled"); plist_free(item);
    mgu_reverse_clear(server); closed_reverse(reverse); wait_unbound(server);
    request(control, "GET", "/playback-info", NULL, &body); free(body);
    reverse = upgrade_reverse(port); queue_fixture(server, "reconnected");
    item = event(reverse, "type", "reconnected"); plist_free(item);
    shutdown(reverse, SHUT_RDWR); close(reverse); wait_unbound(server);
    /* Expiry is injected deterministically; HTTPD must keep serving controls. */
    reverse = upgrade_reverse(port); queue_fixture(server, "expired");
    item = event(reverse, "type", "expired"); plist_free(item);
    pthread_mutex_lock(&mgu_reverse_mutex);
    ((struct mgu_reverse_queue *)server->mgu_reverse_queue)->deadline = 0;
    pthread_mutex_unlock(&mgu_reverse_mutex);
    closed_reverse(reverse); wait_unbound(server);
    request(control, "GET", "/playback-info", NULL, &body); free(body);
    shutdown(control, SHUT_RDWR); close(control);
    raop_stop_httpd(server); raop_destroy(server); unlink(keyfile); assert(rmdir(temporary) == 0);
    puts("Playlist sender: three items on retained session, split header/body ACK FIFO, terminal clock, replay, cancellation, reconnect, expiry and busy-control HLS responsiveness passed");
    return 0;
}
