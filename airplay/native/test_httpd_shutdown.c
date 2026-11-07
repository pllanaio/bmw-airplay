/* The real HTTPD must close every peer even when a request prefix is partial
 * and a connection destructor is deliberately held at a synchronization gate. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <pthread.h>
#include <poll.h>
#include <time.h>
#include <unistd.h>
static ssize_t instrumented_recv(int, void *, size_t, int);
#define recv instrumented_recv
#include "../../.build/airplay/uxplay-source/lib/httpd.c"
#undef recv

static pthread_mutex_t fixture_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t fixture_condition = PTHREAD_COND_INITIALIZER;
static int prefix_read, destructor_entered, release_destructor, destroyed;
static httpd_t *server;
static ssize_t instrumented_recv(int fd, void *buffer, size_t bytes, int flags) {
    ssize_t count = recv(fd, buffer, bytes, flags);
    if (count == 1 && !flags && ((char *)buffer)[0] == 'O') {
        pthread_mutex_lock(&fixture_mutex); prefix_read = 1;
        pthread_cond_broadcast(&fixture_condition); pthread_mutex_unlock(&fixture_mutex);
    }
    return count;
}
static void wait_for(int *value) {
    struct timespec deadline; clock_gettime(CLOCK_REALTIME, &deadline); deadline.tv_sec += 2;
    pthread_mutex_lock(&fixture_mutex);
    while (!*value) assert(pthread_cond_timedwait(&fixture_condition, &fixture_mutex, &deadline) == 0);
    pthread_mutex_unlock(&fixture_mutex);
}
static void *connection(void *opaque, unsigned char *local, int local_length, unsigned char *remote,
                        int remote_length, unsigned int zone) {
    (void)opaque; (void)local; (void)local_length; (void)remote; (void)remote_length; (void)zone;
    return malloc(1);
}
static void disconnected(void *owner) {
    pthread_mutex_lock(&fixture_mutex);
    destructor_entered = 1; pthread_cond_broadcast(&fixture_condition);
    while (!release_destructor) pthread_cond_wait(&fixture_condition, &fixture_mutex);
    destroyed++; pthread_mutex_unlock(&fixture_mutex); free(owner);
}
static void request(void *owner, http_request_t *request, http_response_t **response) {
    const char *url = http_request_get_url(request);
    connection_type_t type = !strcmp(url, "/reverse") ? CONNECTION_TYPE_PTTH :
        !strcmp(url, "/audio") ? CONNECTION_TYPE_RAOP :
        !strcmp(url, "/playlist") ? CONNECTION_TYPE_HLS : CONNECTION_TYPE_AIRPLAY;
    httpd_set_connection_type(server, owner, type);
    *response = http_response_create();
    http_response_init(*response, "HTTP/1.1", type == CONNECTION_TYPE_PTTH ? 101 : 200, "OK");
    http_response_add_header(*response, "Content-Length", "0");
    if (type == CONNECTION_TYPE_PTTH) http_response_add_header(*response, "Upgrade", "PTTH/1.0");
    http_response_finish(*response, NULL, 0);
}
static int connect_peer(unsigned short port, const char *route) {
    int fd = socket(AF_INET, SOCK_STREAM, 0); assert(fd >= 0);
    struct sockaddr_in address = {0}; address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons(port);
    assert(connect(fd, (struct sockaddr *)&address, sizeof address) == 0);
    struct timeval timeout = {2, 0}; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
    if (route) {
        char wire[256]; int bytes = snprintf(wire, sizeof wire, "GET %s HTTP/1.1\r\nHost: fixture\r\n\r\n", route);
        assert(send(fd, wire, bytes, MSG_NOSIGNAL) == bytes);
        int at = 0;
        while (at < (int)sizeof wire - 1) {
            assert(recv(fd, wire + at, 1, 0) == 1); wire[++at] = 0;
            if (strstr(wire, "\r\n\r\n")) break;
        }
        assert(strstr(wire, "\r\n\r\n"));
    }
    return fd;
}
static void *stop_server(void *unused) { (void)unused; httpd_stop(server); return NULL; }
int main(void) {
    logger_t *logger = logger_init(); logger_set_level(logger, LOGGER_ERR);
    httpd_callbacks_t callbacks = {0}; callbacks.conn_init = connection;
    callbacks.conn_request = request; callbacks.conn_destroy = disconnected;
    server = httpd_init(logger, &callbacks, 0); assert(server);
    unsigned short port = 0; assert(httpd_start(server, &port) == 1 && port);
    int peers[5]; const char *routes[] = {"/audio", "/reverse", "/playlist", "/control"};
    for (int i = 0; i < 4; i++) peers[i] = connect_peer(port, routes[i]);
    peers[4] = connect_peer(port, NULL);
    assert(send(peers[4], "O", 1, MSG_NOSIGNAL) == 1); wait_for(&prefix_read);
    pthread_t stopper; assert(pthread_create(&stopper, NULL, stop_server, NULL) == 0);
    wait_for(&destructor_entered);
    /* No destructor can finish yet: TCP shutdown must precede all joins. */
    for (int i = 0; i < 5; i++) {
        char byte; struct pollfd ready = {peers[i], POLLIN, 0};
        assert(poll(&ready, 1, 500) == 1); assert(recv(peers[i], &byte, 1, 0) == 0); close(peers[i]);
    }
    pthread_mutex_lock(&fixture_mutex); assert(!destroyed); release_destructor = 1;
    pthread_cond_broadcast(&fixture_condition); pthread_mutex_unlock(&fixture_mutex);
    assert(pthread_join(stopper, NULL) == 0); assert(destroyed == 5);
    assert(!httpd_is_running(server));
    httpd_stop(server); /* Already stopped/joined remains safe. */
    httpd_destroy(server); logger_destroy(logger);
    puts("HTTPD shutdown: partial request interrupted, RAOP/PTTH/HLS/control peers closed before slow destructor, listener joined");
    return 0;
}
