/* Resolve only the current sender's exact DACP service via the system daemon.
 * No network address or credential is accepted/output. GPL-3.0-or-later. */
#include <dns_sd.h>
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>

static int finished = 0;
static unsigned int found_port = 0;
static void DNSSD_API resolved(DNSServiceRef ref, DNSServiceFlags flags, uint32_t index,
    DNSServiceErrorType error, const char *name, const char *host, uint16_t port,
    uint16_t length, const unsigned char *txt, void *context) {
    (void)ref; (void)flags; (void)index; (void)name; (void)host;
    (void)length; (void)txt; (void)context;
    if (!error) found_port = ntohs(port);
    finished = 1;
}
int main(int argc, char **argv) {
    if (argc != 2 || !*argv[1] || strlen(argv[1]) > 16) return 64;
    for (const char *p = argv[1]; *p; ++p) if (!isxdigit((unsigned char)*p)) return 64;
    char service[40];
    snprintf(service, sizeof service, "iTunes_Ctrl_%s", argv[1]);
    DNSServiceRef ref = NULL;
    if (DNSServiceResolve(&ref, 0, 0, service, "_dacp._tcp", "local.", resolved, NULL)) return 69;
    int fd = DNSServiceRefSockFD(ref);
    struct timespec start, now;
    clock_gettime(CLOCK_MONOTONIC, &start);
    while (!finished && fd >= 0) {
        clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec - start.tv_sec >= 3) break;
        fd_set readers; FD_ZERO(&readers); FD_SET(fd, &readers);
        struct timeval timeout = {0, 200000};
        int result = select(fd + 1, &readers, NULL, NULL, &timeout);
        if (result > 0 && DNSServiceProcessResult(ref)) break;
        if (result < 0 && errno != EINTR) break;
    }
    DNSServiceRefDeallocate(ref);
    if (!found_port) return 69;
    printf("%u\n", found_port);
    return 0;
}
