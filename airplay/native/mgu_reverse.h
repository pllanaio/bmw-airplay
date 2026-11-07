/* Bounded, ACK-serialized reverse AirPlay requests. Included by lib/raop.c.
 * The HTTP thread consumes ACKs; no request handler waits for its own thread.
 * GPL-3.0-or-later, like the private receiver patches. */
#include <time.h>
#include <strings.h>
#define MGU_REVERSE_MAX 16
#define MGU_REVERSE_BYTES 65536
#define MGU_REVERSE_ACK 8192
struct mgu_reverse_queue {
    char *messages[MGU_REVERSE_MAX];
    int lengths[MGU_REVERSE_MAX];
    int count, bytes, fd, inflight;
    raop_conn_t *owner;
    char session[129];
    uint64_t deadline;
};
static pthread_mutex_t mgu_reverse_mutex = PTHREAD_MUTEX_INITIALIZER;
static uint64_t mgu_reverse_now(void) {
    struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static void mgu_reverse_drop(struct mgu_reverse_queue *queue) {
    if (!queue) return;
    for (int i = 0; i < queue->count; i++) free(queue->messages[i]);
    memset(queue, 0, sizeof(*queue)); queue->fd = -1;
}
static void mgu_reverse_clear(raop_t *raop) {
    pthread_mutex_lock(&mgu_reverse_mutex);
    struct mgu_reverse_queue *queue = raop->mgu_reverse_queue;
    if (queue && queue->inflight && queue->fd >= 0) shutdown(queue->fd, SHUT_RDWR);
    mgu_reverse_drop(queue);
    pthread_mutex_unlock(&mgu_reverse_mutex);
}
static void mgu_reverse_destroy(raop_t *raop) {
    pthread_mutex_lock(&mgu_reverse_mutex);
    mgu_reverse_drop(raop->mgu_reverse_queue); free(raop->mgu_reverse_queue); raop->mgu_reverse_queue = NULL;
    pthread_mutex_unlock(&mgu_reverse_mutex);
}
static void mgu_reverse_close(struct mgu_reverse_queue *queue) {
    if (queue && queue->fd >= 0) shutdown(queue->fd, SHUT_RDWR);
    mgu_reverse_drop(queue);
}
/* Bind on the HTTP thread, where the connection cannot be removed concurrently.
   Disconnect clears this token under the same mutex before freeing the owner. */
static void mgu_reverse_bind(void *ptr) {
    raop_conn_t *conn = ptr;
    raop_t *raop = conn->raop;
    int fd = httpd_get_connection_socket(raop->httpd, conn);
    pthread_mutex_lock(&mgu_reverse_mutex);
    struct mgu_reverse_queue *queue = raop->mgu_reverse_queue;
    if (queue && queue->owner && queue->owner != conn) mgu_reverse_close(queue);
    raop->mgu_reverse_owner = conn; raop->mgu_reverse_fd = fd;
    conn->mgu_ack_length = 0;
    pthread_mutex_unlock(&mgu_reverse_mutex);
}
/* Called only with the queue mutex held. Socket I/O never blocks media/control. */
static int mgu_reverse_flush(struct mgu_reverse_queue *queue) {
    if (!queue || !queue->count || queue->inflight) return 0;
    size_t offset = 0; int attempts = 0;
    while (offset < (size_t)queue->lengths[0] && attempts++ < 64) {
        ssize_t sent = send(queue->fd, queue->messages[0] + offset, queue->lengths[0] - offset, MSG_NOSIGNAL | MSG_DONTWAIT);
        if (sent <= 0) { if (sent < 0 && errno == EINTR) continue; mgu_reverse_close(queue); return -1; }
        offset += sent;
    }
    if (offset != (size_t)queue->lengths[0]) { mgu_reverse_close(queue); return -1; }
    queue->inflight = 1; queue->deadline = mgu_reverse_now() + 5000;
    return 0;
}
static int mgu_reverse_enqueue(raop_t *raop, const char *session, const char *body, int length) {
    if (!session || !*session || strlen(session) > 128 || strpbrk(session, "\r\n") || !body || length <= 0 || length > 32768) return -1;
    http_response_t *event = http_response_create();
    http_response_reverse_request_init(event, "POST", "/event", "HTTP/1.1");
    http_response_add_header(event, "X-Apple-Session-ID", session);
    http_response_add_header(event, "Content-Type", "text/x-apple-plist+xml");
    http_response_finish(event, body, length);
    int bytes = 0; const char *wire = http_response_get_data(event, &bytes);
    char *copy = malloc(bytes); if (!copy) { http_response_destroy(event); return -1; }
    memcpy(copy, wire, bytes); http_response_destroy(event);
    pthread_mutex_lock(&mgu_reverse_mutex);
    struct mgu_reverse_queue *queue = raop->mgu_reverse_queue;
    if (!queue) { queue = calloc(1, sizeof(*queue)); raop->mgu_reverse_queue = queue; if (queue) queue->fd = -1; }
    if (!queue) { free(copy); pthread_mutex_unlock(&mgu_reverse_mutex); return -1; }
    if (queue->inflight && queue->deadline <= mgu_reverse_now()) mgu_reverse_close(queue);
    int fd = raop->mgu_reverse_fd;
    raop_conn_t *owner = raop->mgu_reverse_owner;
    if (fd <= 0 || !owner || (queue->count && (queue->owner != owner || strcmp(queue->session, session)))) {
        if (queue->count) mgu_reverse_close(queue);
        free(copy); pthread_mutex_unlock(&mgu_reverse_mutex); return -1;
    }
    if (queue->count >= MGU_REVERSE_MAX || bytes > MGU_REVERSE_BYTES - queue->bytes) {
        mgu_reverse_close(queue); free(copy); pthread_mutex_unlock(&mgu_reverse_mutex); return -1;
    }
    queue->owner = owner; queue->fd = fd; snprintf(queue->session, sizeof queue->session, "%s", session);
    queue->messages[queue->count] = copy; queue->lengths[queue->count++] = bytes; queue->bytes += bytes;
    int result = mgu_reverse_flush(queue);
    pthread_mutex_unlock(&mgu_reverse_mutex); return result;
}
static int mgu_reverse_send_plist(raop_t *raop, const char *session, plist_t root) {
    char *xml = NULL; uint32_t length = 0; plist_to_xml(root, &xml, &length);
    if (!xml) return -1;
    int result = mgu_reverse_enqueue(raop, session, xml, (int)length); plist_mem_free(xml); return result;
}
static void mgu_reverse_disconnected(raop_conn_t *conn) {
    pthread_mutex_lock(&mgu_reverse_mutex);
    if (conn->raop->mgu_reverse_owner == conn) {
        conn->raop->mgu_reverse_owner = NULL; conn->raop->mgu_reverse_fd = -1;
    }
    struct mgu_reverse_queue *queue = conn->raop->mgu_reverse_queue;
    if (queue && queue->owner == conn) mgu_reverse_drop(queue);
    pthread_mutex_unlock(&mgu_reverse_mutex);
}
static void mgu_reverse_tick(void *ptr) {
    raop_conn_t *conn = ptr; pthread_mutex_lock(&mgu_reverse_mutex);
    struct mgu_reverse_queue *queue = conn->raop->mgu_reverse_queue;
    if (queue && queue->owner == conn && queue->inflight && queue->deadline <= mgu_reverse_now()) mgu_reverse_close(queue);
    pthread_mutex_unlock(&mgu_reverse_mutex);
}
/* ACKs may be split over TCP reads. Consume headers plus an optional bounded
   body before releasing the next request; never mistake a partial ACK for it. */
static void mgu_reverse_ack(void *ptr, const char *data, size_t length) {
    raop_conn_t *conn = ptr; pthread_mutex_lock(&mgu_reverse_mutex);
    struct mgu_reverse_queue *queue = conn->raop->mgu_reverse_queue;
    if (!queue || queue->owner != conn || !queue->inflight) { conn->mgu_ack_length = 0; pthread_mutex_unlock(&mgu_reverse_mutex); return; }
    if (length > MGU_REVERSE_ACK - 1 - conn->mgu_ack_length) goto invalid;
    memcpy(conn->mgu_ack + conn->mgu_ack_length, data, length); conn->mgu_ack_length += length;
    conn->mgu_ack[conn->mgu_ack_length] = '\0';
    char *end = strstr(conn->mgu_ack, "\r\n\r\n");
    if (!end) { pthread_mutex_unlock(&mgu_reverse_mutex); return; }
    size_t headers = (size_t)(end + 4 - conn->mgu_ack), body = 0;
    if (strncmp(conn->mgu_ack, "HTTP/1.1 200 ", 13) && strncmp(conn->mgu_ack, "EVENT/1.0 200 ", 14)) goto invalid;
    for (char *at = strstr(conn->mgu_ack, "\r\n") + 2; at < end;) {
        char *line_end = strstr(at, "\r\n"); if (!line_end || line_end > end) goto invalid;
        if (!strncasecmp(at, "Content-Length:", 15)) {
            char *value = at + 15; while (value < line_end && (*value == ' ' || *value == '\t')) value++;
            char *number_end = NULL; unsigned long parsed = strtoul(value, &number_end, 10);
            if (number_end == value || number_end != line_end || parsed > MGU_REVERSE_ACK) goto invalid;
            body = parsed;
        } else if (!strncasecmp(at, "Transfer-Encoding:", 18)) goto invalid;
        at = line_end + 2;
    }
    if (headers + body > MGU_REVERSE_ACK - 1) goto invalid;
    if (conn->mgu_ack_length < headers + body) { pthread_mutex_unlock(&mgu_reverse_mutex); return; }
    /* There is only one in-flight request, so unsolicited trailing ACKs are
       rejected instead of accidentally acknowledging an event not sent yet. */
    if (conn->mgu_ack_length != headers + body) goto invalid;
    conn->mgu_ack_length = 0;
    free(queue->messages[0]); queue->bytes -= queue->lengths[0];
    for (int i = 1; i < queue->count; i++) { queue->messages[i - 1] = queue->messages[i]; queue->lengths[i - 1] = queue->lengths[i]; }
    queue->count--; queue->inflight = 0; queue->deadline = 0;
    mgu_reverse_flush(queue); pthread_mutex_unlock(&mgu_reverse_mutex); return;
 invalid:
    conn->mgu_ack_length = 0; mgu_reverse_close(queue); pthread_mutex_unlock(&mgu_reverse_mutex);
}
