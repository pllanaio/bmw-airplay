/* Sender-driven AirPlay item transitions. Included only by http_handlers.h.
 * GPL-3.0-or-later. The sender owns the YouTube queue; never guess a next URL. */
#include <math.h>
#include <strings.h>
#include <pthread.h>
/* Serializes HTTP control with the GLib EOS callback. Local HLS GETs never
 * acquire this lock: renderer teardown may wait for those HTTP responses. */
static pthread_mutex_t mgu_playlist_mutex;
static pthread_once_t mgu_playlist_once = PTHREAD_ONCE_INIT;
static void mgu_playlist_lock_init(void) {
    pthread_mutexattr_t attr; pthread_mutexattr_init(&attr);
    pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&mgu_playlist_mutex, &attr); pthread_mutexattr_destroy(&attr);
}
static void mgu_playlist_unlock(pthread_mutex_t **mutex) { if (*mutex) pthread_mutex_unlock(*mutex); }
static pthread_mutex_t *mgu_playlist_lock(void) {
    pthread_once(&mgu_playlist_once, mgu_playlist_lock_init);
    pthread_mutex_lock(&mgu_playlist_mutex); return &mgu_playlist_mutex;
}
static pthread_mutex_t *mgu_playlist_trylock(void) {
    pthread_once(&mgu_playlist_once, mgu_playlist_lock_init);
    return pthread_mutex_trylock(&mgu_playlist_mutex) == 0 ? &mgu_playlist_mutex : NULL;
}
#define MGU_PLAYLIST_GUARD pthread_mutex_t *mgu_playlist_guard __attribute__((cleanup(mgu_playlist_unlock))) = mgu_playlist_lock()
static void mgu_http_handler_play_original(raop_conn_t *, http_request_t *, http_response_t *, char **, int *);
static void http_handler_play(raop_conn_t *, http_request_t *, http_response_t *, char **, int *);

static bool mgu_uuid(const char *s) {
    if (!s || strlen(s) != 36) return false;
    for (int i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
        else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f') || (s[i] >= 'A' && s[i] <= 'F'))) return false;
    }
    return true;
}
static char *mgu_item_string(plist_t dict, const char *key) {
    char *s = NULL; plist_t value = dict ? plist_dict_get_item(dict, key) : NULL;
    if (PLIST_IS_STRING(value)) plist_get_string_val(value, &s);
    return s;
}
static plist_t mgu_request_plist(http_request_t *request) {
    int length = 0; const char *data = http_request_get_data(request, &length);
    plist_t root = NULL;
    if (!data || length < 8 || length > 65536) return NULL;
    if (!memcmp(data, "bplist00", 8)) plist_from_bin(data, length, &root);
    else if (data[0] == '<') plist_from_xml(data, length, &root);
    if (!PLIST_IS_DICT(root)) { if (root) plist_free(root); return NULL; }
    return root;
}
static void mgu_playlist_bad(http_response_t *response, int status) {
    http_response_init(response, "HTTP/1.1", status, status == 409 ? "Conflict" : "Bad Request");
    http_response_add_header(response, "Content-Length", "0");
}
static bool mgu_media_location(const char *location) {
    if (!location || strlen(location) > 8192 || !*location) return false;
    for (const unsigned char *p = (const unsigned char *)location; *p; p++) if (*p <= 0x20 || *p == 0x7f) return false;
    return !strncasecmp(location, "https://", 8) || !strncasecmp(location, "http://", 7) ||
           (!strncasecmp(location, "mlhls://", 8) && strstr(location, "/master.m3u8"));
}
static bool mgu_playlist_session(raop_t *raop, http_request_t *request) {
    const char *session = http_request_get_header(request, "X-Apple-Session-ID");
    const char *active = raop->mgu_active_session;
    if (!*active && raop->current_video >= 0 && raop->airplay_video[raop->current_video])
        active = get_apple_session_id(raop->airplay_video[raop->current_video]);
    return mgu_uuid(session) && (!active || !*active || !strcmp(session, active));
}
static http_request_t *mgu_item_request(plist_t item, const char *session) {
    char *body = NULL; uint32_t length = 0;
    plist_to_bin(item, &body, &length);
    if (!body || length > 65536) { plist_mem_free(body); return NULL; }
    char header[512]; int bytes = snprintf(header, sizeof header,
        "POST /play HTTP/1.1\r\nContent-Type: application/x-apple-binary-plist\r\nX-Apple-Session-ID: %s\r\nContent-Length: %u\r\n\r\n", session, length);
    http_request_t *request = http_request_init();
    http_request_add_data(request, header, bytes); http_request_add_data(request, body, length);
    plist_mem_free(body);
    if (!http_request_is_complete(request)) { http_request_destroy(request); return NULL; }
    return request;
}
/* Terminal information is intentionally independent of a destroyed renderer. */
static void mgu_playlist_snapshot(raop_t *raop, playback_info_t *info) {
    memset(info, 0, sizeof *info);
    *info = raop->mgu_terminal_info;
    info->loadedTimeRanges = info->seekableTimeRanges = NULL;
    info->num_loaded_time_ranges = info->num_seekable_time_ranges = 0;
}
static plist_t mgu_playlist_event(const char *type, const char *uuid) {
    plist_t event = plist_new_dict();
    plist_dict_set_item(event, "category", plist_new_string("video"));
    plist_dict_set_item(event, "sessionID", plist_new_uint(1));
    plist_dict_set_item(event, "type", plist_new_string(type));
    if (uuid) plist_dict_set_item(event, "uuid", plist_new_string(uuid));
    return event;
}
static void mgu_playlist_end_events(raop_t *raop) {
    const char *session = raop->mgu_active_session, *uuid = raop->mgu_active_uuid;
    if (!mgu_uuid(session) || !mgu_uuid(uuid)) return;
    plist_t event = mgu_playlist_event("itemPlayedToEnd", uuid);
    mgu_reverse_send_plist(raop, session, event); plist_free(event);
    event = plist_new_dict(); plist_t params = plist_new_dict();
    plist_dict_set_item(event, "category", plist_new_string("video"));
    plist_dict_set_item(event, "sessionID", plist_new_uint(1));
    plist_dict_set_item(event, "state", plist_new_string("stopped"));
    plist_dict_set_item(event, "reason", plist_new_string("ended"));
    plist_dict_set_item(params, "uuid", plist_new_string(uuid));
    plist_dict_set_item(event, "params", params);
    mgu_reverse_send_plist(raop, session, event); plist_free(event);
    event = mgu_playlist_event("itemRemoved", uuid);
    plist_dict_set_item(event, "sessionID", plist_new_string(session));
    mgu_reverse_send_plist(raop, session, event); plist_free(event);
    event = mgu_playlist_event("currentItemChanged", NULL);
    mgu_reverse_send_plist(raop, session, event); plist_free(event);
}
static bool mgu_playlist_action(raop_conn_t *conn, http_request_t *request, http_response_t *response,
                                 char **response_data, int *response_datalen) {
    plist_t root = mgu_request_plist(request);
    if (!root) { mgu_playlist_bad(response, 400); return true; }
    char *type = mgu_item_string(root, "type");
    bool insert = type && !strcmp(type, "playlistInsert"), remove = type && !strcmp(type, "playlistRemove");
    if (!insert && !remove) { plist_mem_free(type); plist_free(root); return false; }
    raop_t *raop = conn->raop;
    plist_t params = plist_dict_get_item(root, "params");
    plist_t item = PLIST_IS_DICT(params) ? plist_dict_get_item(params, "item") : NULL;
    char *uuid = PLIST_IS_DICT(item) ? mgu_item_string(item, "uuid") : NULL;
    if (!mgu_uuid(uuid) || !mgu_playlist_session(raop, request)) {
        mgu_playlist_bad(response, 400); goto done;
    }
    if (remove) {
        /* An old item's removal can arrive after its successor has started. */
        if (raop->mgu_terminal || (raop->mgu_active_uuid[0] && strcmp(uuid, raop->mgu_active_uuid))) goto done;
        if (get_playlist_by_uuid(raop, uuid) < 0) goto done;
        /* Active removal keeps the existing detach-aware handling. */
        plist_mem_free(uuid); plist_mem_free(type); plist_free(root); return false;
    }
    if (raop->mgu_playlist_cancelled) { mgu_playlist_bad(response, 409); goto done; }
    char *location = mgu_item_string(item, "Content-Location");
    int known = get_playlist_by_uuid(raop, uuid);
    if (!location && known >= 0) {
        const char *stored = get_playback_location(raop->airplay_video[known]);
        if (stored) location = strdup(stored);
    }
    if (!mgu_media_location(location)) {
        plist_mem_free(location); mgu_playlist_bad(response, 400); goto done;
    }
    plist_t play = plist_copy(item);
    plist_dict_set_item(play, "Content-Location", plist_new_string(location));
    if (!plist_dict_get_item(play, "clientProcName")) plist_dict_set_item(play, "clientProcName", plist_new_string("YouTube"));
    const char *session = http_request_get_header(request, "X-Apple-Session-ID");
    http_request_t *normalized = mgu_item_request(play, session);
    if (normalized) {
        bool continuation = raop->mgu_terminal && raop->mgu_terminal_detached &&
            !strcmp(session, raop->mgu_active_session) && strcmp(uuid, raop->mgu_active_uuid);
        raop->mgu_inserting = true;
        raop->mgu_continue_detached = continuation;
        http_handler_play(conn, normalized, response, response_data, response_datalen);
        raop->mgu_inserting = false;
        if (http_response_get_status(response) == 200) { printf("MGU_PLAYLIST_INSERT\n"); fflush(stdout); }
        else raop->mgu_continue_detached = false;
        http_request_destroy(normalized);
    } else mgu_playlist_bad(response, 400);
    plist_mem_free(location); plist_free(play);
 done:
    plist_mem_free(uuid); plist_mem_free(type); plist_free(root); return true;
}
static bool mgu_playlist_property(raop_conn_t *conn, http_request_t *request, http_response_t *response,
                                  char **response_data, int *response_datalen) {
    const char *url = http_request_get_url(request);
    if (!url || strcmp(url, "/setProperty?actionAtItemEnd")) return false;
    plist_t root = mgu_request_plist(request), value = root ? plist_dict_get_item(root, "value") : NULL;
    uint64_t action = 99;
    if (PLIST_IS_UINT(value)) plist_get_uint_val(value, &action);
    if (!mgu_playlist_session(conn->raop, request) || action > 2) mgu_playlist_bad(response, 400);
    else {
        conn->raop->mgu_action_at_end = (int)action;
        plist_t result = plist_new_dict(); plist_dict_set_item(result, "errorCode", plist_new_uint(0));
        plist_to_xml(result, response_data, (uint32_t *)response_datalen); plist_free(result);
        http_response_add_header(response, "Content-Type", "text/x-apple-plist+xml");
    }
    if (root) plist_free(root);
    return true;
}
static void http_handler_play(raop_conn_t *conn, http_request_t *request, http_response_t *response,
                               char **response_data, int *response_datalen) {
    MGU_PLAYLIST_GUARD;
    raop_t *raop = conn->raop;
    plist_t root = mgu_request_plist(request);
    /* Preserve text/direct AirPlay requests without imposing playlist rules. */
    if (!root) {
        raop_playlist_cancel(raop);
        mgu_http_handler_play_original(conn, request, response, response_data, response_datalen);
        goto legacy;
    }
    char *uuid = mgu_item_string(root, "uuid"), *location = mgu_item_string(root, "Content-Location");
    const char *session = http_request_get_header(request, "X-Apple-Session-ID");
    /* Standard direct requests can omit uuid; UxPlay's existing direct path handles them. */
    if (!uuid && location && mgu_media_location(location)) {
        raop_playlist_cancel(raop); mgu_http_handler_play_original(conn, request, response, response_data, response_datalen);
        plist_mem_free(location); plist_free(root); goto legacy;
    }
    if (!mgu_uuid(uuid) || !mgu_uuid(session) || !mgu_media_location(location)) { mgu_playlist_bad(response, 400); goto done; }
    plist_t start = plist_dict_get_item(root, "Start-Position-Seconds"); double seconds = 0.0;
    if (start && plist_get_node_type(start) != PLIST_REAL && plist_get_node_type(start) != PLIST_UINT) { mgu_playlist_bad(response, 400); goto done; }
    if (start) { if (PLIST_IS_UINT(start)) {uint64_t n;plist_get_uint_val(start,&n);seconds=(double)n;} else plist_get_real_val(start,&seconds); }
    if (!isfinite(seconds) || seconds < 0.0 || seconds > 604800.0) { mgu_playlist_bad(response, 400); goto done; }
    if (strstr(location, "/master.m3u8") && !PLIST_IS_STRING(plist_dict_get_item(root, "clientProcName"))) {
        mgu_playlist_bad(response, 400); goto done;
    }
    if (raop->current_video >= 0 && !raop->mgu_terminal && !raop->mgu_playlist_cancelled && seconds == raop->mgu_active_start &&
        !strcmp(uuid, raop->mgu_active_uuid) && !strcmp(session, raop->mgu_active_session) &&
        !strcmp(location, raop->mgu_active_source)) goto done; /* retransmission */
    if (!raop->mgu_inserting) raop->mgu_continue_detached = false;
    mgu_http_handler_play_original(conn, request, response, response_data, response_datalen);
    if (http_response_get_status(response) == 200 && raop->current_video >= 0 && raop->airplay_video[raop->current_video]) {
        airplay_video_t *video = raop->airplay_video[raop->current_video];
        /* Standard HTTP media and FCUP must expose the same sender item UUID. */
        set_playback_uuid(video, uuid, strlen(uuid)); set_apple_session_id(video, session, strlen(session));
        raop->mgu_terminal = false; raop->mgu_playlist_cancelled = false;
        memset(&raop->mgu_last_info, 0, sizeof raop->mgu_last_info);
        snprintf(raop->mgu_active_session, sizeof raop->mgu_active_session, "%s", session);
        snprintf(raop->mgu_active_uuid, sizeof raop->mgu_active_uuid, "%s", uuid);
        snprintf(raop->mgu_active_source, sizeof raop->mgu_active_source, "%s", location);
        raop->mgu_active_start = seconds;
        raop->mgu_action_at_end = 0;
    }
 done:
    plist_mem_free(uuid); plist_mem_free(location); plist_free(root);
    return;
 legacy:
    /* Text/direct media has a receiver-generated item identity. Track that
     * accepted item too, so EOS never accidentally names an earlier title. */
    if (http_response_get_status(response) == 200 && raop->current_video >= 0 && raop->airplay_video[raop->current_video]) {
        airplay_video_t *video = raop->airplay_video[raop->current_video];
        snprintf(raop->mgu_active_uuid, sizeof raop->mgu_active_uuid, "%s", get_playback_uuid(video));
        snprintf(raop->mgu_active_session, sizeof raop->mgu_active_session, "%s", get_apple_session_id(video));
        snprintf(raop->mgu_active_source, sizeof raop->mgu_active_source, "%s", get_playback_location(video));
        raop->mgu_terminal = raop->mgu_playlist_cancelled = false;
        raop->mgu_action_at_end = 0; memset(&raop->mgu_last_info, 0, sizeof raop->mgu_last_info);
    }
}
