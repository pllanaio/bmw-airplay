#define _GNU_SOURCE
/* Root-only Bonjour reply routing. Fixed table/priority; the supervisor owns
 * an exact-rule journal and checks collisions before requesting mutations. */
#include <arpa/inet.h>
#include <errno.h>
#include <linux/fib_rules.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define ROUTE_TABLE 110
#define RULE_PRIORITY 1099
#define MAX_RULES 64

struct rule { uint32_t uid, network, prefix; };
struct request { struct nlmsghdr header; struct fib_rule_hdr rule; char attributes[256]; };

static int number(const char *text, uint32_t maximum, uint32_t *value) {
    if (!text || !*text) return -1;
    uint64_t n = 0;
    for (const char *p = text; *p; p++) {
        if (*p < '0' || *p > '9') return -1;
        n = n * 10 + (unsigned)(*p - '0');
        if (n > maximum) return -1;
    }
    *value = (uint32_t)n; return 0;
}
static uint32_t mask(uint32_t prefix) { return prefix ? UINT32_MAX << (32 - prefix) : 0; }
static int private_network(uint32_t network, uint32_t prefix) {
    if (prefix < 8 || prefix > 32 || (network & mask(prefix)) != network) return 0;
    return (prefix >= 8 && (network & 0xff000000U) == 0x0a000000U) ||
        (prefix >= 12 && (network & 0xfff00000U) == 0xac100000U) ||
        (prefix >= 16 && (network & 0xffff0000U) == 0xc0a80000U) ||
        (prefix >= 16 && (network & 0xffff0000U) == 0xa9fe0000U);
}
static int arguments(char **argv, struct rule *rule) {
    struct in_addr address;
    if (number(argv[2], 65535, &rule->uid) || number(argv[4], 32, &rule->prefix) ||
        inet_pton(AF_INET, argv[3], &address) != 1) return -1;
    rule->network = ntohl(address.s_addr);
    return private_network(rule->network, rule->prefix) ? 0 : -1;
}
static void print_rule(const struct rule *rule) {
    struct in_addr address = { htonl(rule->network) }; char text[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &address, text, sizeof(text));
    printf("{\"uid\":%u,\"network\":\"%s\",\"prefix\":%u}", rule->uid, text, rule->prefix);
}
static int attribute(struct request *request, unsigned type, const void *data, size_t size) {
    size_t at = NLMSG_ALIGN(request->header.nlmsg_len), length = RTA_LENGTH(size);
    if (at + RTA_ALIGN(length) > sizeof(*request)) return -1;
    struct rtattr *attr = (struct rtattr *)((char *)request + at);
    attr->rta_type = type; attr->rta_len = length; memcpy(RTA_DATA(attr), data, size);
    request->header.nlmsg_len = at + RTA_ALIGN(length); return 0;
}
static int channel(void) {
    int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
    struct sockaddr_nl address = { .nl_family = AF_NETLINK };
    struct timeval timeout = { .tv_sec = 2 };
    if (fd < 0) return -1;
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) ||
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))) { close(fd); return -1; }
    return fd;
}
static int transmit(int fd, const struct request *request) {
    struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
    return sendto(fd, request, request->header.nlmsg_len, 0, (struct sockaddr *)&kernel, sizeof(kernel)) ==
        (ssize_t)request->header.nlmsg_len ? 0 : -1;
}
static int mutate(int fd, const struct rule *rule, int adding) {
    struct request request; memset(&request, 0, sizeof(request));
    request.header.nlmsg_len = NLMSG_LENGTH(sizeof(request.rule));
    request.header.nlmsg_type = adding ? RTM_NEWRULE : RTM_DELRULE;
    request.header.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | (adding ? NLM_F_CREATE | NLM_F_EXCL : 0);
    request.header.nlmsg_seq = 1;
    request.rule.family = AF_INET; request.rule.dst_len = rule->prefix;
    request.rule.table = ROUTE_TABLE; request.rule.action = FR_ACT_TO_TBL;
    uint32_t priority = RULE_PRIORITY, suppress = 0, network = htonl(rule->network);
    struct fib_rule_uid_range range = { rule->uid, rule->uid };
    if (attribute(&request, FRA_PRIORITY, &priority, sizeof(priority)) ||
        attribute(&request, FRA_DST, &network, sizeof(network)) ||
        attribute(&request, FRA_UID_RANGE, &range, sizeof(range)) ||
        attribute(&request, FRA_SUPPRESS_PREFIXLEN, &suppress, sizeof(suppress)) || transmit(fd, &request)) return -1;
    char buffer[8192];
    for (int tries = 0; tries < 16; tries++) {
        ssize_t length = recv(fd, buffer, sizeof(buffer), 0);
        if (length < 0) return -1;
        for (struct nlmsghdr *header = (struct nlmsghdr *)buffer; NLMSG_OK(header, length); header = NLMSG_NEXT(header, length)) {
            if (header->nlmsg_seq != 1 || header->nlmsg_type != NLMSG_ERROR) continue;
            if (header->nlmsg_len < NLMSG_LENGTH(sizeof(struct nlmsgerr))) return -1;
            int error = ((struct nlmsgerr *)NLMSG_DATA(header))->error;
            if (!error || (!adding && error == -ENOENT)) return 0;
            errno = -error; return -1;
        }
    }
    errno = EIO; return -1;
}
/* Returns 0 for another priority, 1 for our exact bounded shape, 2 for a
 * colliding rule. Foreign rules are reported, never deleted or replaced. */
static int decode(struct nlmsghdr *header, struct rule *result) {
    if (header->nlmsg_len < NLMSG_LENGTH(sizeof(struct fib_rule_hdr))) return 2;
    struct fib_rule_hdr *rule = NLMSG_DATA(header);
    uint32_t priority = 0, table = rule->table, suppress = UINT32_MAX, network = 0;
    struct fib_rule_uid_range uid = { UINT32_MAX, UINT32_MAX };
    int unusual = rule->family != AF_INET || rule->src_len || rule->tos || rule->action != FR_ACT_TO_TBL || rule->flags;
    int left = header->nlmsg_len - NLMSG_LENGTH(sizeof(*rule));
    for (struct rtattr *attr = (struct rtattr *)((char *)rule + NLMSG_ALIGN(sizeof(*rule))); RTA_OK(attr, left); attr = RTA_NEXT(attr, left)) {
        unsigned type = attr->rta_type;
        size_t size = RTA_PAYLOAD(attr);
        if (type == FRA_UID_RANGE && size == sizeof(uid)) memcpy(&uid, RTA_DATA(attr), size);
        else if (size == sizeof(uint32_t)) {
            uint32_t value; memcpy(&value, RTA_DATA(attr), sizeof(value));
            if (type == FRA_PRIORITY) priority = value;
            else if (type == FRA_TABLE) table = value;
            else if (type == FRA_SUPPRESS_PREFIXLEN) suppress = value;
            else if (type == FRA_DST) network = ntohl(value);
            else if (type != FRA_SUPPRESS_IFGROUP || value != UINT32_MAX) unusual = 1;
        } else if (type != FRA_PAD && !(type == FRA_PROTOCOL && size == 1 && !*(unsigned char *)RTA_DATA(attr))) unusual = 1;
    }
    if (priority != RULE_PRIORITY) return 0;
    if (left || unusual || table != ROUTE_TABLE || suppress || uid.start != uid.end || uid.start > 65535 ||
        !private_network(network, rule->dst_len)) return 2;
    result->uid = uid.start; result->network = network; result->prefix = rule->dst_len; return 1;
}
static int show(int fd) {
    struct request request; memset(&request, 0, sizeof(request));
    request.header.nlmsg_len = NLMSG_LENGTH(sizeof(request.rule)); request.header.nlmsg_type = RTM_GETRULE;
    request.header.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP; request.header.nlmsg_seq = 2; request.rule.family = AF_INET;
    if (transmit(fd, &request)) return -1;
    struct rule rules[MAX_RULES]; int count = 0, foreign = 0, done = 0;
    char buffer[32768];
    for (int tries = 0; !done && tries < 64; tries++) {
        ssize_t length = recv(fd, buffer, sizeof(buffer), 0); if (length < 0) return -1;
        for (struct nlmsghdr *header = (struct nlmsghdr *)buffer; NLMSG_OK(header, length); header = NLMSG_NEXT(header, length)) {
            if (header->nlmsg_seq != 2) continue;
            if (header->nlmsg_type == NLMSG_DONE) { if (header->nlmsg_flags & NLM_F_DUMP_INTR) return -1; done = 1; break; }
            if (header->nlmsg_type == NLMSG_ERROR) return -1;
            if (header->nlmsg_type != RTM_NEWRULE) continue;
            struct rule rule; int kind = decode(header, &rule);
            if (kind == 2) foreign = 1;
            if (kind == 1) { if (count == MAX_RULES) return -1; rules[count++] = rule; }
        }
    }
    if (!done) return -1;
    printf("{\"table\":%d,\"priority\":%d,\"foreign\":%s,\"rules\":[", ROUTE_TABLE, RULE_PRIORITY, foreign ? "true" : "false");
    for (int i = 0; i < count; i++) { if (i) putchar(','); print_rule(&rules[i]); }
    puts("]}"); return 0;
}
int main(int argc, char **argv) {
    struct rule rule;
    int listing = argc == 2 && !strcmp(argv[1], "show");
    int checking = argc == 5 && !strcmp(argv[1], "--check");
    int adding = argc == 5 && !strcmp(argv[1], "add");
    int deleting = argc == 5 && !strcmp(argv[1], "delete");
    if ((!listing && !checking && !adding && !deleting) || (!listing && arguments(argv, &rule))) return 64;
    if (checking) { print_rule(&rule); putchar('\n'); return 0; }
    if (getuid() || geteuid()) return 77;
    int fd = channel(); if (fd < 0) return 70;
    int result = listing ? show(fd) : mutate(fd, &rule, adding); close(fd);
    if (result) { fprintf(stderr, "mdns_route_failed:%d\n", errno); return errno == EEXIST ? 72 : 71; }
    return 0;
}
