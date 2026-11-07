/* Private DACP credentials, owned by the verified RAOP connection. GPL-3.0-or-later. */
#ifndef MGU_MUSIC_CONTROL_H
#define MGU_MUSIC_CONTROL_H
#include <arpa/inet.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>

static std::mutex mgu_control_mutex;
static void *mgu_control_owner = NULL;
static unsigned long mgu_control_generation = 0;

static bool mgu_control_digits(const char *value, size_t maximum, bool hex) {
    if (!value || !*value || strlen(value) > maximum) return false;
    for (const char *p = value; *p; ++p)
        if (!(*p >= '0' && *p <= '9') && !(hex && ((*p >= 'a' && *p <= 'f') || (*p >= 'A' && *p <= 'F')))) return false;
    return true;
}

static void mgu_music_control(void *, void *owner, const unsigned char *remote,
                              int length, unsigned int zone, const char *id, const char *token) {
    const char *directory = getenv("MGU_MUSIC_DIR");
    if (!directory || !*directory) return;
    std::lock_guard<std::mutex> lock(mgu_control_mutex);
    int dir = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dir < 0) return;
    struct stat st;
    if (fstat(dir, &st) || st.st_uid != getuid() || (st.st_mode & 077) != 0) { close(dir); return; }
    if (!token) {
        if (owner == mgu_control_owner) {
            unlinkat(dir, "control.json", 0);
            mgu_control_owner = NULL;
        }
        close(dir); return;
    }
    if (!remote || (length != 4 && length != 16) ||
        !mgu_control_digits(id, 16, true) || !mgu_control_digits(token, 20, false)) { close(dir); return; }
    char address[INET6_ADDRSTRLEN], host[INET6_ADDRSTRLEN + 16];
    if (!inet_ntop(length == 4 ? AF_INET : AF_INET6, remote, address, sizeof address)) { close(dir); return; }
    /* Scope belongs to the actual inbound connection, not an mDNS hostname. */
    in6_addr ipv6 = {};
    if (length == 16) memcpy(&ipv6, remote, sizeof ipv6);
    if (length == 16 && IN6_IS_ADDR_LINKLOCAL(&ipv6))
        snprintf(host, sizeof host, "%s%%%u", address, zone);
    else snprintf(host, sizeof host, "%s", address);
    struct timespec now = {};
    clock_gettime(CLOCK_MONOTONIC, &now);
    char json[512];
    const int count = snprintf(json, sizeof json,
        "{\"epoch\":\"%ld-%ld-%ld-%lu\",\"host\":\"%s\",\"dacpId\":\"%s\",\"activeRemote\":\"%s\"}\n",
        (long)getpid(), (long)now.tv_sec, now.tv_nsec, ++mgu_control_generation, host, id, token);
    /* O_EXCL prevents following a malicious replacement; no credential logs. */
    unlinkat(dir, "control.json.tmp", 0);
    int fd = openat(dir, "control.json.tmp", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd >= 0) {
        bool ok = count > 0 && count < (int)sizeof json && write(fd, json, (size_t)count) == count;
        if (close(fd)) ok = false;
        if (ok && !renameat(dir, "control.json.tmp", dir, "control.json")) mgu_control_owner = owner;
        else unlinkat(dir, "control.json.tmp", 0);
    }
    close(dir);
}
#endif
