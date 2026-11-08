"""Full receiver disconnect must end the process, including blocked media I/O.

SIGTERM/INT/HUP stop the whole ephemeral receiver. Kernel descriptor cleanup
closes every RTSP/PTTH/RTP, ALSA and DNS-SD connection without waiting for a
GStreamer lock. Pairing entries are persisted on registration; the backend
owns temporary-file cleanup. SIGUSR2/WINCH keep their media-only meanings.

Internal HTTPD resets still use orderly thread cleanup, interrupting sockets
before joining so an incomplete request cannot keep a phone connected.
Applied last, after the other private receiver patches. GPL-3.0-or-later.
"""


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected UxPlay shutdown source: ' + old[:80])
    return text.replace(old, new)


def patch(source, ux):
    ux = once(ux, '''static void CtrlHandler(int signum) {
    cleanup();
    exit(0);
}''', '''static void CtrlHandler(int signum) {
    (void) signum;
    /* Full disconnect: no heap, logging, joins or GStreamer from a signal
     * handler. The kernel closes every receiver transport and audio device. */
    _exit(0);
}''')
    ux = once(ux, '''    signal(SIGINT, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    guint sigterm_watch_id = g_unix_signal_add(SIGTERM, (GSourceFunc) sigterm_callback, (gpointer) loop);
    guint sigint_watch_id = g_unix_signal_add(SIGINT, (GSourceFunc) sigint_callback, (gpointer) loop);
    guint sighup_watch_id = g_unix_signal_add(SIGHUP, (GSourceFunc) sigint_callback, (gpointer) loop);''', '''    /* Keep termination immediate even during a renderer rebuild or a
     * blocked GLib callback. Only media controls use GLib signal sources. */
    signal(SIGINT, CtrlHandler);
    signal(SIGTERM, CtrlHandler);
    signal(SIGHUP, CtrlHandler);''')
    for line in [
        '    if (sigint_watch_id > 0) g_source_remove(sigint_watch_id);\n',
        '    if (sigterm_watch_id > 0) g_source_remove(sigterm_watch_id);\n',
        '    if (sighup_watch_id > 0) g_source_remove(sighup_watch_id);\n',
    ]:
        ux = once(ux, line, '')
    ux = once(ux, 'MGU_FEATURES media-stop\\n', 'MGU_FEATURES media-stop\\nMGU_FEATURES full-disconnect\\n')

    raop_path = source / 'lib/raop.c'
    raop = raop_path.read_text()
    raop = once(raop, '''        raop_destroy_airplay_video(raop, -1);
        raop_stop_httpd(raop);''', '''        /* Stop request callbacks before freeing their cached playlists. */
        raop_stop_httpd(raop);
        raop_destroy_airplay_video(raop, -1);''')
    raop_path.write_text(raop)

    httpd_path = source / 'lib/httpd.c'
    httpd = httpd_path.read_text()
    httpd = once(httpd, '    httpd->nohold = (nohold ? 1 : 0);', '''    MUTEX_CREATE(httpd->run_mutex);
    httpd->server_fd4 = httpd->server_fd6 = -1;
    httpd->nohold = (nohold ? 1 : 0);''')
    httpd = once(httpd, '        free(httpd->connections);', '        MUTEX_DESTROY(httpd->run_mutex);\n        free(httpd->connections);')
    httpd = once(httpd, '''    if (!httpd->connections) {
        free(httpd);''', '''    if (!httpd->connections) {
        MUTEX_DESTROY(httpd->run_mutex);
        free(httpd);''')
    httpd = once(httpd, '    int socket_fd = connection->socket_fd;', '''    int socket_fd = connection->socket_fd;
    /* Tell the peer immediately, before slow RTP/renderer destructors. Keep
     * the FD owned until conn_destroy clears its reverse-channel binding. */
    MUTEX_LOCK(httpd->run_mutex);
    if (socket_fd != -1) shutdown(socket_fd, SHUT_RDWR);
    MUTEX_UNLOCK(httpd->run_mutex);''')
    httpd = once(httpd, '''    if (socket_fd != -1) {
        if (!sock_err) {''', '''    MUTEX_LOCK(httpd->run_mutex);
    if (socket_fd != -1) {
        if (!sock_err) {''')
    httpd = once(httpd, '''    connection->type = CONNECTION_TYPE_UNKNOWN;
}

static int
httpd_add_connection''', '''    connection->type = CONNECTION_TYPE_UNKNOWN;
    MUTEX_UNLOCK(httpd->run_mutex);
}

static int
httpd_add_connection''')
    httpd = once(httpd, '    httpd->open_connections++;', '''    MUTEX_LOCK(httpd->run_mutex);
    if (!httpd->running) {
        MUTEX_UNLOCK(httpd->run_mutex);
        httpd->callbacks.conn_destroy(user_data);
        return -1;
    }
    httpd->open_connections++;''')
    httpd = once(httpd, '''    httpd->connections[i].type = CONNECTION_TYPE_UNKNOWN;   //should not be necessary ...
    return 0;''', '''    httpd->connections[i].type = CONNECTION_TYPE_UNKNOWN;   //should not be necessary ...
    MUTEX_UNLOCK(httpd->run_mutex);
    return 0;''')
    httpd = once(httpd, '    /* Close server sockets since they are not used any more */', '''    MUTEX_LOCK(httpd->run_mutex);
    /* Close server sockets since they are not used any more */''')
    httpd = once(httpd, '''    // Ensure running reflects the actual state
    MUTEX_LOCK(httpd->run_mutex);
    httpd->running = 0;''', '''    // Ensure running reflects the actual state
    httpd->running = 0;''')
    # This is the stop function's early return, not the worker-loop check.
    httpd = once(httpd, '    if (!httpd->running || httpd->joined) {', '    if (httpd->joined) {')
    httpd = once(httpd, '''    httpd->running = 0;
    MUTEX_UNLOCK(httpd->run_mutex);

    THREAD_JOIN(httpd->thread);''', '''    httpd->running = 0;
    /* recv/send can otherwise wait forever on a sender's partial request.
     * Publication, retirement and this interrupt share the same mutex, so
     * an FD cannot be closed/reused underneath shutdown(). */
    if (httpd->server_fd4 != -1) shutdown(httpd->server_fd4, SHUT_RDWR);
    if (httpd->server_fd6 != -1) shutdown(httpd->server_fd6, SHUT_RDWR);
    for (int i = 0; i < httpd->max_connections; i++)
        if (httpd->connections[i].connected && httpd->connections[i].socket_fd != -1)
            shutdown(httpd->connections[i].socket_fd, SHUT_RDWR);
    MUTEX_UNLOCK(httpd->run_mutex);

    THREAD_JOIN(httpd->thread);''')
    httpd_path.write_text(httpd)
    return ux
