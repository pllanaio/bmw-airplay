#include "mgu_music_control.h"
#include <cassert>
#include <fstream>
#include <string>

static std::string read(const std::string &file) {
    std::ifstream stream(file);
    return std::string((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
}
int main() {
    char directory[] = "/tmp/mgu-controls-XXXXXX"; assert(mkdtemp(directory));
    assert(!chmod(directory, 0700)); assert(!setenv("MGU_MUSIC_DIR", directory, 1));
    const std::string file = std::string(directory) + "/control.json";
    unsigned char ipv4[] = {192, 168, 1, 15}; int first, second;
    mgu_music_control(NULL, &first, ipv4, 4, 0, "ABCD1234", "123456789");
    struct stat st; assert(!lstat(file.c_str(), &st)); assert((st.st_mode & 0777) == 0600);
    std::string initial = read(file);
    assert(initial.find("\"host\":\"192.168.1.15\"") != std::string::npos);
    assert(initial.find("\"activeRemote\":\"123456789\"") != std::string::npos);
    mgu_music_control(NULL, &second, NULL, 0, 0, NULL, NULL); assert(read(file) == initial);
    mgu_music_control(NULL, &second, ipv4, 4, 0, "bad-id", "123456789"); assert(read(file) == initial);
    mgu_music_control(NULL, &second, ipv4, 4, 0, "ABCD1234", "1\r\nX: y"); assert(read(file) == initial);
    mgu_music_control(NULL, &second, ipv4, 4, 0, "ABCD1234", "234567890");
    assert(read(file) != initial);
    mgu_music_control(NULL, &first, NULL, 0, 0, NULL, NULL); assert(!access(file.c_str(), F_OK));
    mgu_music_control(NULL, &second, NULL, 0, 0, NULL, NULL); assert(access(file.c_str(), F_OK));
    unsigned char ipv6[16]; assert(inet_pton(AF_INET6, "fe80::1234", ipv6) == 1);
    mgu_music_control(NULL, &first, ipv6, 16, 3, "1", "2");
    assert(read(file).find("\"host\":\"fe80::1234%3\"") != std::string::npos);
    mgu_music_control(NULL, &first, NULL, 0, 0, NULL, NULL);
    assert(!chmod(directory, 0755));
    mgu_music_control(NULL, &first, ipv4, 4, 0, "1", "2"); assert(access(file.c_str(), F_OK));
    assert(!rmdir(directory));
    puts("Private DACP export validates credentials, preserves current owner, scopes IPv6 and clears on disconnect");
}
