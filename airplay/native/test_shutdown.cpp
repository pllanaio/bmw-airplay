/* Full disconnect against the actual patched UxPlay main loop, live RAOP and
 * PTTH clients, and actual RAOP RTP data/control UDP sockets. No iPhone needed. */
#define main mgu_upstream_main
#include "../../.build/airplay/uxplay-source/uxplay.cpp"
#undef main
#include <cassert>
#include <poll.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <cerrno>
#include <chrono>
extern "C" {
#include "../../.build/airplay/uxplay-source/lib/raop_rtp.h"
}

struct Ports { unsigned short tcp, data, control; int pipe; };
static void audio(void *, raop_ntp_t *, audio_decode_struct *) {}
static void video(void *, raop_ntp_t *, video_decode_struct *) {}
static void quiet(void *, int, const char *) {}
static gboolean ready(gpointer data) {
    Ports *ports = (Ports *)data;
    assert(write(ports->pipe, ports, sizeof *ports) == sizeof *ports);
    close(ports->pipe);
    return G_SOURCE_REMOVE;
}
static void child_server(int pipe, const char *directory) {
    signal(SIGTERM, CtrlHandler); signal(SIGINT, CtrlHandler); signal(SIGHUP, CtrlHandler);
    use_video = false; use_audio = false;
    raop_callbacks_t callbacks = {}; callbacks.audio_process = audio; callbacks.video_process = video;
    raop = raop_init(&callbacks); assert(raop);
    raop_set_log_callback(raop, quiet, NULL); raop_set_log_level(raop, LOGGER_ERR);
    std::string key = std::string(directory) + "/key";
    assert(raop_init2(raop, 0, "02:00:00:00:04:05", key.c_str()) == 0);
    raop_set_plist(raop, "hls", 1);
    Ports ports = {}; ports.pipe = pipe;
    assert(raop_start_httpd(raop, &ports.tcp) == 1 && ports.tcp);
    raop_set_port(raop, ports.tcp);
    render_logger = logger_init(); logger_set_level(render_logger, LOGGER_ERR);
    timing_protocol_t protocol = TP_NONE;
    raop_ntp_t *ntp = raop_ntp_init(render_logger, &callbacks, "127.0.0.1", 4, 0, &protocol); assert(ntp);
    unsigned char aes[16] = {};
    raop_rtp_t *rtp = raop_rtp_init(render_logger, &callbacks, ntp, "127.0.0.1", 4, aes, aes); assert(rtp);
    unsigned short remote = 0; unsigned char codec = 2; unsigned int rate = 44100;
    raop_rtp_start_audio(rtp, &remote, &ports.control, &ports.data, &codec, &rate);
    assert(ports.control && ports.data && raop_rtp_is_running(rtp));
    g_idle_add(ready, &ports);
    main_loop();
    /* The old GLib SIGTERM path returned here and then hung joining HTTPD's
     * incomplete request. A full receiver termination must never return. */
    stop_raop_server();
    _exit(71);
}
static int connect_peer(unsigned short port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0); assert(fd >= 0);
    sockaddr_in address = {}; address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons(port);
    assert(connect(fd, (sockaddr *)&address, sizeof address) == 0);
    timeval timeout = {2, 0}; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
    return fd;
}
static void request(int fd, const char *wire, const char *status) {
    size_t length = strlen(wire); assert(send(fd, wire, length, MSG_NOSIGNAL) == (ssize_t)length);
    char header[2048]; int at = 0;
    while (at < (int)sizeof header - 1) {
        assert(recv(fd, header + at, 1, 0) == 1); header[++at] = 0;
        if (strstr(header, "\r\n\r\n")) break;
    }
    assert(strstr(header, "\r\n\r\n") && !strncmp(header, status, strlen(status)));
}
static int bind_udp(unsigned short port) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0); assert(fd >= 0);
    sockaddr_in address = {}; address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY); address.sin_port = htons(port);
    if (bind(fd, (sockaddr *)&address, sizeof address)) { int error = errno; close(fd); errno = error; return -1; }
    return fd;
}
int main(void) {
    const int signals[] = {SIGTERM, SIGINT, SIGHUP};
    for (int signum : signals) {
        char directory[] = "/tmp/mgu-shutdown-XXXXXX"; assert(mkdtemp(directory));
        int pipe[2]; assert(::pipe(pipe) == 0);
        pid_t child = fork(); assert(child >= 0);
        if (!child) { close(pipe[0]); child_server(pipe[1], directory); }
        close(pipe[1]); pollfd readiness = {pipe[0], POLLIN, 0}; assert(poll(&readiness, 1, 3000) == 1);
        Ports ports = {}; assert(read(pipe[0], &ports, sizeof ports) == sizeof ports); close(pipe[0]);
        assert(bind_udp(ports.control) == -1 && errno == EADDRINUSE);
        assert(bind_udp(ports.data) == -1 && errno == EADDRINUSE);
        int peers[3]; peers[0] = connect_peer(ports.tcp);
        request(peers[0], "OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n", "RTSP/1.0 200");
        peers[1] = connect_peer(ports.tcp);
        request(peers[1], "POST /reverse HTTP/1.1\r\nHost: receiver\r\nX-Apple-Session-ID: 11111111-2222-4333-8444-555555555555\r\nX-Apple-Purpose: event\r\nConnection: Upgrade\r\nUpgrade: PTTH/1.0\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 101");
        peers[2] = connect_peer(ports.tcp);
        assert(send(peers[2], "O", 1, MSG_NOSIGNAL) == 1);
        assert(kill(child, signum) == 0);
        int status = 0; pid_t result = 0;
        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (!(result = waitpid(child, &status, WNOHANG)) && std::chrono::steady_clock::now() < deadline) usleep(5000);
        if (!result) { kill(child, SIGKILL); waitpid(child, &status, 0); assert(!"receiver termination waited for media/network cleanup"); }
        assert(result == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
        for (int fd : peers) {
            char byte; pollfd closed = {fd, POLLIN, 0}; assert(poll(&closed, 1, 500) == 1);
            ssize_t count = recv(fd, &byte, 1, 0); assert(count == 0 || (count == -1 && errno == ECONNRESET)); close(fd);
        }
        int control = bind_udp(ports.control), data = bind_udp(ports.data);
        assert(control >= 0 && data >= 0); close(control); close(data);
        int check = socket(AF_INET, SOCK_STREAM, 0); assert(check >= 0);
        sockaddr_in address = {}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons(ports.tcp);
        assert(connect(check, (sockaddr *)&address, sizeof address) == -1 && errno == ECONNREFUSED); close(check);
        unlink((std::string(directory) + "/key").c_str()); assert(rmdir(directory) == 0);
    }
    puts("Full receiver TERM/INT/HUP: process exits, RAOP/PTTH/partial TCP peers close, RTP UDP ports release, listener cannot relaunch");
    return 0;
}
