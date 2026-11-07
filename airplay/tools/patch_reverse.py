"""Serialize bounded reverse AirPlay events on complete sender ACKs."""
from pathlib import Path

def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Unexpected reverse-channel source: ' + old[:80])
    return text.replace(old, new)

def patch(source, upstream=None):
    upstream = upstream or Path(__file__).resolve().parents[2] / '.local/airplay/UxPlay'
    file = source / 'lib/raop.c'
    text = file.read_text()
    text = once(text, 'struct raop_s {', 'struct raop_s {\n    void *mgu_reverse_queue;\n    void *mgu_reverse_owner;\n    int mgu_reverse_fd;')
    text = once(text, 'struct raop_conn_s {', 'struct raop_conn_s {\n    char mgu_ack[8192];\n    size_t mgu_ack_length;')
    text = once(text, '#include "http_handlers.h"', '#include "mgu_reverse.h"\n#include "http_handlers.h"')
    text = once(text, '    httpd_cbs.conn_destroy = &conn_destroy;', '    httpd_cbs.conn_destroy = &conn_destroy;\n    httpd_cbs.conn_reverse_data = &mgu_reverse_ack;\n    httpd_cbs.conn_reverse_tick = &mgu_reverse_tick;\n    httpd_cbs.conn_reverse_ready = &mgu_reverse_bind;')
    anchor = '    logger_log(raop->logger, LOGGER_DEBUG, "Destroying connection");'
    text = once(text, anchor, anchor + '\n    mgu_reverse_disconnected(conn);')
    text = once(text, '        raop_stop_httpd(raop);', '        raop_stop_httpd(raop);\n        mgu_reverse_destroy(raop);')
    file.write_text(text)
    file = source / 'lib/httpd.h'; text = (upstream / 'lib/httpd.h').read_text()
    text = once(text, '    void  (*conn_destroy)(void *ptr);', '    void  (*conn_destroy)(void *ptr);\n    void  (*conn_reverse_data)(void *ptr, const char *data, size_t length);\n    void  (*conn_reverse_tick)(void *ptr);\n    void  (*conn_reverse_ready)(void *ptr);')
    file.write_text(text)
    file = source / 'lib/httpd.c'; text = (upstream / 'lib/httpd.c').read_text()
    anchor = '               socket_fd, connection->user_data);\n    if (connection->user_data) {'
    text = once(text, anchor, '               socket_fd, connection->user_data);\n    connection->type = CONNECTION_TYPE_UNKNOWN;\n    if (connection->user_data) {')
    anchor = '                    if (http_response_get_disconnect(response)) {'
    text = once(text, anchor, '''                    /* Publish PTTH only after the complete upgrade response is
                       on wire, so EOS cannot precede the sender's 101. */
                    if (written == datalen && datalen >= 12 &&
                        connection->type == CONNECTION_TYPE_PTTH &&
                        !strncmp(data, "HTTP/1.1 101", 12) && httpd->callbacks.conn_reverse_ready)
                        httpd->callbacks.conn_reverse_ready(connection->user_data);
''' + anchor)
    text = once(text, '            if (httpd->connections[i].pending_remove) {', '            if (httpd->callbacks.conn_reverse_tick) httpd->callbacks.conn_reverse_tick(httpd->connections[i].user_data);\n            if (httpd->connections[i].pending_remove) {')
    text = once(text, '            /* If not in the middle of request, allocate one */', """            /* A reverse ACK may arrive one byte at a time. Read it once per
               select cycle; the request-prefix sniff below must not wait for
               eight bytes and block unrelated playback/control requests. */
            if (connection->type == CONNECTION_TYPE_PTTH) {
                int ret = recv(connection->socket_fd, buffer, sizeof(buffer), MSG_DONTWAIT);
                if (ret > 0 && httpd->callbacks.conn_reverse_data)
                    httpd->callbacks.conn_reverse_data(connection->user_data, buffer, (size_t)ret);
                else if (ret == 0 || (ret < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK))
                    httpd_remove_connection(httpd, connection, ret < 0 ? SOCKET_GET_ERROR() : 0);
                continue;
            }
            /* If not in the middle of request, allocate one */""")
    start = text.index('            if (http_request_is_reverse(connection->request)) {', text.index('            /* reverse-http responses'))
    end = text.index('\n            /* Parse HTTP request', start)
    text = text[:start] + '''            if (http_request_is_reverse(connection->request)) {
                if (httpd->callbacks.conn_reverse_data)
                    httpd->callbacks.conn_reverse_data(connection->user_data, buffer, (size_t)recv_datalen);
                continue;
            }
''' + text[end:]
    file.write_text(text)
    file = source / 'lib/fcup_request.h'; text = (upstream / 'lib/fcup_request.h').read_text()
    start = text.index('int fcup_request(')
    text = text[:start] + '''int fcup_request(void *conn_opaque, const char *media_url, const char *client_session_id, int request_id) {
    raop_conn_t *conn = conn_opaque;
    int length = 0;
    char *xml = create_fcup_request(media_url, request_id, client_session_id, &length);
    int result = mgu_reverse_enqueue(conn->raop, client_session_id, xml, length);
    plist_mem_free(xml);
    return result;
}
'''
    file.write_text(text)
