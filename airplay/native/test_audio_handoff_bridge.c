/* Test-only bridge around the actual parsed RAOP request handler. A known
 * local AES session replaces FairPlay negotiation, while SETUP, RTP sockets,
 * decryption and receiver callbacks all use the production implementation. */
#include "../../.build/airplay/uxplay-source/lib/raop.c"
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

typedef struct {
    raop_conn_t *connection;
    int sender;
    unsigned short control, data, sequence;
    uint32_t timestamp;
} mgu_test_audio_session;

static const unsigned char test_key[16] = {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15};
static const unsigned char test_iv[16] = {16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31};

void *mgu_test_audio_session_create(raop_t *raop) {
    unsigned char address[] = {127,0,0,1};
    mgu_test_audio_session *session = calloc(1, sizeof *session);
    assert(session);
    session->connection = conn_init(raop, address, 4, address, 4, 0);
    assert(session->connection);
    session->connection->connection_type = CONNECTION_TYPE_RAOP;
    session->connection->authenticated = true;
    timing_protocol_t protocol = TP_UNSPECIFIED;
    session->connection->raop_ntp = raop_ntp_init(raop->logger, &raop->callbacks, "127.0.0.1", 4, 0, &protocol);
    assert(session->connection->raop_ntp);
    session->connection->raop_rtp = raop_rtp_init(raop->logger, &raop->callbacks,
        session->connection->raop_ntp, "127.0.0.1", 4, test_key, test_iv);
    assert(session->connection->raop_rtp);
    session->connection->raop_rtp_mirror = raop_rtp_mirror_init(raop->logger, &raop->callbacks,
        session->connection->raop_ntp, "127.0.0.1", 4, test_key);
    assert(session->connection->raop_rtp_mirror);
    session->sender = socket(AF_INET, SOCK_DGRAM, 0);
    assert(session->sender >= 0);
    return session;
}

static plist_t parsed_bytes(mgu_test_audio_session *session, const char *method, const char *type, const char *binary, uint32_t size) {
    char header[512];
    int header_size = snprintf(header, sizeof header,
        "%s /stream RTSP/1.0\r\nCSeq: 7\r\nContent-Type: %s\r\nContent-Length: %u\r\n\r\n",
        method, type, size);
    http_request_t *request = http_request_init();
    assert(request);
    http_request_add_data(request, header, header_size);
    http_request_add_data(request, binary, size);
    assert(http_request_is_complete(request));
    http_response_t *response = NULL;
    conn_request(session->connection, request, &response);
    assert(response && http_response_get_status(response) == 200 && !http_response_get_disconnect(response));
    int response_size = 0;
    const char *response_bytes = http_response_get_data(response, &response_size);
    int start = 0;
    for (; start + 4 <= response_size; ++start)
        if (!memcmp(response_bytes + start, "\r\n\r\n", 4)) { start += 4; break; }
    plist_t result = NULL;
    if (start < response_size) plist_from_bin(response_bytes + start, response_size - start, &result);
    http_request_destroy(request); http_response_destroy(response);
    return result;
}

static plist_t parsed_request(mgu_test_audio_session *session, const char *method, plist_t body) {
    char *binary = NULL; uint32_t size = 0;
    plist_to_bin(body, &binary, &size); assert(binary && size);
    plist_t response = parsed_bytes(session, method, "application/x-apple-binary-plist", binary, size);
    plist_mem_free(binary); return response;
}

void mgu_test_audio_setup(void *opaque, unsigned int codec, bool screen, bool media) {
    mgu_test_audio_session *session = opaque;
    plist_t body = plist_new_dict(), streams = plist_new_array(), stream = plist_new_dict();
    plist_dict_set_item(stream, "type", plist_new_uint(96));
    plist_dict_set_item(stream, "ct", plist_new_uint(codec));
    plist_dict_set_item(stream, "spf", plist_new_uint(352));
    plist_dict_set_item(stream, "audioFormat", plist_new_uint(0x40000));
    plist_dict_set_item(stream, "controlPort", plist_new_uint(0));
    plist_dict_set_item(stream, "usingScreen", plist_new_bool(screen));
    plist_dict_set_item(stream, "isMedia", plist_new_bool(media));
    plist_array_append_item(streams, stream); plist_dict_set_item(body, "streams", streams);
    plist_t response = parsed_request(session, "SETUP", body);
    assert(response);
    plist_t reply_stream = plist_array_get_item(plist_dict_get_item(response, "streams"), 0);
    uint64_t port = 0;
    plist_get_uint_val(plist_dict_get_item(reply_stream, "controlPort"), &port); session->control = port;
    plist_get_uint_val(plist_dict_get_item(reply_stream, "dataPort"), &port); session->data = port;
    assert(session->control && session->data && raop_rtp_is_running(session->connection->raop_rtp));
    plist_free(response); plist_free(body);
}

void mgu_test_mirror_setup(void *opaque) {
    mgu_test_audio_session *session = opaque;
    plist_t body = plist_new_dict(), streams = plist_new_array(), stream = plist_new_dict();
    plist_dict_set_item(stream, "type", plist_new_uint(110));
    plist_dict_set_item(stream, "streamConnectionID", plist_new_uint(42));
    plist_array_append_item(streams, stream); plist_dict_set_item(body, "streams", streams);
    plist_t response = parsed_request(session, "SETUP", body);
    assert(response); plist_free(response); plist_free(body);
}

static void send_udp(mgu_test_audio_session *session, unsigned short port, const void *bytes, size_t length) {
    struct sockaddr_in destination = {0}; destination.sin_family = AF_INET;
    destination.sin_port = htons(port); destination.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(sendto(session->sender, bytes, length, 0, (struct sockaddr *)&destination, sizeof destination) == (ssize_t)length);
}

void mgu_test_audio_send(void *opaque, const unsigned char *alac, unsigned int length) {
    mgu_test_audio_session *session = opaque;
    assert(length > 8 && length < RAOP_PACKET_LEN - 12 && alac[0] == 0x20);
    unsigned char sync[20] = {0x80,0xd4,0,4};
    uint32_t timestamp = htonl(session->timestamp); memcpy(sync + 4, &timestamp, 4);
    uint64_t now = raop_ntp_get_local_time();
    uint32_t seconds = htonl(now / 1000000000ULL), fraction = htonl(((now % 1000000000ULL) << 32) / 1000000000ULL);
    memcpy(sync + 8, &seconds, 4); memcpy(sync + 12, &fraction, 4);
    memcpy(sync + 16, &timestamp, 4); send_udp(session, session->control, sync, sizeof sync);
    unsigned char *packet = calloc(1, length + 12);
    assert(packet); packet[0] = 0x80; packet[1] = 0x60;
    unsigned short sequence = htons(session->sequence++); memcpy(packet + 2, &sequence, 2);
    memcpy(packet + 4, &timestamp, 4);
    aes_ctx_t *cipher = aes_cbc_init(test_key, test_iv, AES_ENCRYPT);
    assert(cipher);
    int encrypted = length / 16 * 16;
    aes_cbc_encrypt(cipher, alac, packet + 12, encrypted);
    aes_cbc_destroy(cipher);
    memcpy(packet + 12 + encrypted, alac + encrypted, length - encrypted);
    send_udp(session, session->data, packet, length + 12);
    session->timestamp += 352;
    free(packet);
}

void mgu_test_audio_metadata(void *opaque, const char *title) {
    mgu_test_audio_session *session = opaque;
    size_t title_size = strlen(title); assert(title_size < 256);
    unsigned char metadata[272] = {'m','l','i','t',0,0,0,0,'m','i','n','m',0,0,0,0};
    uint32_t size = htonl(title_size + 8); memcpy(metadata + 4, &size, 4);
    size = htonl(title_size); memcpy(metadata + 12, &size, 4); memcpy(metadata + 16, title, title_size);
    plist_t response = parsed_bytes(session, "SET_PARAMETER", "application/x-dmap-tagged", (const char *)metadata, title_size + 16);
    if (response) plist_free(response);
}

void mgu_test_audio_stale_events(void *opaque) {
    mgu_test_audio_session *session = opaque;
    plist_t response = parsed_bytes(session, "FLUSH", "text/parameters", "", 0);
    if (response) plist_free(response);
    mgu_test_audio_metadata(session, "OLD OWNER");
}

void mgu_test_audio_session_destroy(void *opaque) {
    mgu_test_audio_session *session = opaque;
    close(session->sender); conn_destroy(session->connection); free(session);
}
