/* Standard unprotected AirPlay HTTP/HLS/MP4 requests, in addition to YouTube FCUP.
 * Included by lib/http_handlers.h; GPL-3.0-or-later.
 */
#include <strings.h>
#include <math.h>
static char *mgu_parameter(const char *body, int length, const char *key) {
    size_t k = strlen(key);
    const char *at = body, *limit = body + length;
    while (at < limit) {
        const char *end = memchr(at, '\n', (size_t)(limit - at));
        if (!end) end = limit;
        if ((size_t)(end - at) > k && !strncasecmp(at, key, k) && at[k] == ':') {
            const char *value = at + k + 1;
            while (value < end && (*value == ' ' || *value == '\t')) value++;
            while (end > value && (end[-1] == '\r' || end[-1] == ' ')) end--;
            size_t n = (size_t)(end - value);
            char *copy = (char *)malloc(n + 1);
            if (!copy) return NULL;
            memcpy(copy, value, n); copy[n] = '\0'; return copy;
        }
        at = end < limit ? end + 1 : limit;
    }
    return NULL;
}
static bool mgu_direct_play(raop_conn_t *conn, http_request_t *request, http_response_t *response) {
    raop_t *raop = conn->raop;
    int size = 0;
    const char *body = http_request_get_data(request, &size);
    char *location = NULL; plist_t root = NULL;
    double start = 0.0; bool seconds = false, has_uuid = false;
    if (body && size > 0 && size <= 65536) {
        if (size >= 8 && !memcmp(body, "bplist00", 8)) plist_from_bin(body, size, &root);
        else if (body[0] == '<') plist_from_xml(body, size, &root);
        if (root && plist_get_node_type(root) == PLIST_DICT) {
            plist_t value = plist_dict_get_item(root, "Content-Location");
            if (PLIST_IS_STRING(value)) plist_get_string_val(value, &location);
            has_uuid = PLIST_IS_STRING(plist_dict_get_item(root, "uuid"));
            value = plist_dict_get_item(root, "Start-Position-Seconds");
            if (value) { plist_get_real_val(value, &start); seconds = true; }
            else {
                value = plist_dict_get_item(root, "Start-Position");
                if (value) plist_get_real_val(value, &start);
            }
        } else {
            location = mgu_parameter(body, size, "Content-Location");
            char *position = mgu_parameter(body, size, "Start-Position");
            if (position) { start = strtod(position, NULL); free(position); }
        }
    }
    if (root) plist_free(root);
    /* YouTube's proxy requests must retain the original FCUP exchange. */
    if (location && has_uuid && strstr(location, "/master.m3u8")) {
        plist_mem_free(location); return false;
    }
    bool allowed = location && strlen(location) <= 8192 &&
        (!strncasecmp(location, "https://", 8) || !strncasecmp(location, "http://", 7));
    if (allowed) for (const unsigned char *p = (unsigned char *)location; *p; p++)
        if (*p < 0x20 || *p == 0x7f) { allowed = false; break; }
    if (!allowed) {
        if (location) plist_mem_free(location);
        http_response_init(response, "HTTP/1.1", 415, "Unsupported Media Type");
        if (raop->callbacks.on_video_stop) raop->callbacks.on_video_stop(raop->callbacks.cls);
        printf("MGU_MEDIA_REJECTED\n"); fflush(stdout); return true;
    }
    int id = -1;
    for (int i = 0; i < MAX_AIRPLAY_VIDEO; i++) if (!raop->airplay_video[i]) { id = i; break; }
    if (id < 0) { id = (raop->current_video + 1) % MAX_AIRPLAY_VIDEO; raop_destroy_airplay_video(raop, id); }
    airplay_video_t *video = airplay_video_init(raop, raop->port, raop->lang);
    raop->airplay_video[id] = video; raop->current_video = id;
    static unsigned int sequence = 0;
    char identity[37];
    unsigned int serial = ++sequence;
    snprintf(identity, sizeof identity, "%08x-0000-4000-8000-%012x", serial, serial);
    set_playback_uuid(video, identity, strlen(identity));
    const char *session = http_request_get_header(request, "X-Apple-Session-ID");
    if (!session || strlen(session) != 36) session = identity;
    set_apple_session_id(video, session, strlen(session));
    set_playback_location(video, location, strlen(location));
    if (!isfinite(start) || start < 0.0) start = 0.0;
    /* Negative values encode a standard fractional Start-Position internally;
       no change is made to the external AirPlay protocol. */
    float position = seconds ? (float)start : (start > 0.0 && start <= 1.0 ? -(float)start : 0.0f);
    raop->callbacks.on_video_play(raop->callbacks.cls, location, position);
    plist_mem_free(location);
    http_response_init(response, "HTTP/1.1", 200, "OK");
    printf("MGU_DIRECT_PLAY\n"); fflush(stdout); return true;
}
