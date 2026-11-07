/* Private, bounded RAOP Now Playing export. No video renderer or network I/O.
 * GPL-3.0-or-later. Included once by the patched UxPlay translation unit. */
#ifndef MGU_AUDIO_METADATA_H
#define MGU_AUDIO_METADATA_H
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdint.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <glib.h>

static GMutex mgu_metadata_mutex;
static int mgu_metadata_directory = -1;
static uint64_t mgu_metadata_revision = 0;
static std::string mgu_metadata_title, mgu_metadata_artist, mgu_metadata_album;
static std::string mgu_metadata_art_file, mgu_metadata_art_mime;
static unsigned int mgu_metadata_art_width = 0, mgu_metadata_art_height = 0;
static uint64_t mgu_metadata_art_revision = 0;

struct mgu_metadata_guard {
    mgu_metadata_guard() { g_mutex_lock(&mgu_metadata_mutex); }
    ~mgu_metadata_guard() { g_mutex_unlock(&mgu_metadata_mutex); }
};

static int mgu_metadata_dir(void) {
    if (mgu_metadata_directory >= 0) return mgu_metadata_directory;
    const char *directory = getenv("MGU_MUSIC_DIR");
    if (!directory || !*directory) directory = getenv("MGU_AUDIO_METADATA_DIR");
    if (!directory || directory[0] != '/' || strlen(directory) > 4095) return -1;
    int fd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat st;
    if (fstat(fd, &st) || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 0777) != 0700) {
        close(fd);
        return -1;
    }
    mgu_metadata_directory = fd;
    return fd;
}

static bool mgu_metadata_write(const char *name, const char *temporary, const void *data, size_t size) {
    int directory = mgu_metadata_dir();
    if (directory < 0) return false;
    int fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    bool valid = true;
    const unsigned char *bytes = (const unsigned char *) data;
    size_t done = 0;
    while (done < size) {
        ssize_t count = write(fd, bytes + done, size - done);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { valid = false; break; }
        done += (size_t) count;
    }
    if (close(fd)) valid = false;
    if (valid && renameat(directory, temporary, directory, name)) valid = false;
    if (!valid) unlinkat(directory, temporary, 0);
    return valid;
}

static std::string mgu_metadata_string(const unsigned char *bytes, size_t size) {
    /* Never let sender-provided strings escape the small metadata document.
     * Repair UTF-8, remove controls, and normalize whitespace for the car UI. */
    if (size > 4096) size = 4096;
    gchar *valid = g_utf8_make_valid((const gchar *) bytes, (gssize) size);
    std::string result;
    bool space = false;
    unsigned int count = 0;
    for (const gchar *at = valid; *at && count < 256; at = g_utf8_next_char(at)) {
        gunichar ch = g_utf8_get_char(at);
        if (g_unichar_isspace(ch)) { space = !result.empty(); continue; }
        if (g_unichar_iscntrl(ch)) continue;
        if (space && count < 256) { result += ' '; ++count; }
        space = false;
        if (count >= 256) break;
        gchar encoded[6];
        int length = g_unichar_to_utf8(ch, encoded);
        result.append(encoded, length);
        ++count;
    }
    g_free(valid);
    return result;
}

static std::string mgu_metadata_json_string(const std::string &value) {
    std::string json = "\"";
    for (unsigned char ch : value) {
        if (ch == '"' || ch == '\\') json += '\\';
        json += ch;
    }
    json += '"';
    return json;
}

static void mgu_metadata_publish(void) {
    std::string json = "{\"revision\":" + std::to_string(++mgu_metadata_revision) +
        ",\"title\":" + mgu_metadata_json_string(mgu_metadata_title) +
        ",\"artist\":" + mgu_metadata_json_string(mgu_metadata_artist) +
        ",\"album\":" + mgu_metadata_json_string(mgu_metadata_album) + ",\"artwork\":";
    if (mgu_metadata_art_file.empty()) json += "null";
    else json += "{\"file\":" + mgu_metadata_json_string(mgu_metadata_art_file) +
        ",\"mime\":" + mgu_metadata_json_string(mgu_metadata_art_mime) +
        ",\"width\":" + std::to_string(mgu_metadata_art_width) +
        ",\"height\":" + std::to_string(mgu_metadata_art_height) +
        ",\"revision\":" + std::to_string(mgu_metadata_art_revision) + "}";
    json += "}\n";
    if (json.size() <= 4096) mgu_metadata_write("current.json", "current.json.tmp", json.data(), json.size());
}

static void mgu_metadata_clear_art(void) {
    mgu_metadata_art_file.clear();
    mgu_metadata_art_mime.clear();
    mgu_metadata_art_width = mgu_metadata_art_height = 0;
    int directory = mgu_metadata_dir();
    if (directory >= 0) {
        /* Remove only our private regular files. A replaced link or unexpected
         * ownership is left untouched for the receiver's safe cleanup. */
        for (const char *name : {"cover.jpg", "cover.png"}) {
            struct stat st;
            if (!fstatat(directory, name, &st, AT_SYMLINK_NOFOLLOW) && S_ISREG(st.st_mode) &&
                st.st_uid == geteuid() && st.st_nlink == 1) unlinkat(directory, name, 0);
        }
    }
}

static void mgu_audio_metadata_clear(void) {
    if (!mgu_audio_only && !mgu_audio_auto) return;
    mgu_metadata_guard guard;
    mgu_metadata_title.clear();
    mgu_metadata_artist.clear();
    mgu_metadata_album.clear();
    mgu_metadata_clear_art();
    mgu_metadata_publish();
}

static uint32_t mgu_metadata_u32(const unsigned char *value) {
    return ((uint32_t) value[0] << 24) | ((uint32_t) value[1] << 16) | ((uint32_t) value[2] << 8) | value[3];
}

static void mgu_audio_metadata_receive(const void *buffer, int length) {
    if ((!mgu_audio_only && !mgu_audio_auto) || !buffer || length < 8 || length > 65536) return;
    const unsigned char *bytes = (const unsigned char *) buffer;
    if (memcmp(bytes, "mlit", 4) || mgu_metadata_u32(bytes + 4) != (uint32_t) length - 8) return;
    std::string title, artist_name, album_name;
    bool have_title = false, have_artist = false, have_album = false;
    size_t at = 8;
    while (at < (size_t) length) {
        if ((size_t) length - at < 8) return;
        uint32_t size = mgu_metadata_u32(bytes + at + 4);
        const unsigned char *tag = bytes + at;
        at += 8;
        if (size > (size_t) length - at) return;
        if (!memcmp(tag, "minm", 4)) { title = mgu_metadata_string(bytes + at, size); have_title = true; }
        if (!memcmp(tag, "asar", 4)) { artist_name = mgu_metadata_string(bytes + at, size); have_artist = true; }
        if (!memcmp(tag, "asal", 4)) { album_name = mgu_metadata_string(bytes + at, size); have_album = true; }
        at += size;
    }
    if (!have_title && !have_artist && !have_album) return;
    mgu_metadata_guard guard;
    bool new_title = have_title && title != mgu_metadata_title;
    if (!have_title) title = mgu_metadata_title;
    if (!have_artist) artist_name = new_title ? "" : mgu_metadata_artist;
    if (!have_album) album_name = new_title ? "" : mgu_metadata_album;
    if (title == mgu_metadata_title && artist_name == mgu_metadata_artist && album_name == mgu_metadata_album) return;
    mgu_metadata_clear_art(); /* Never label the previous track's image as the new track. */
    mgu_metadata_title = title;
    mgu_metadata_artist = artist_name;
    mgu_metadata_album = album_name;
    mgu_metadata_publish();
}

static bool mgu_metadata_image_size(const unsigned char *bytes, size_t length, unsigned int *width, unsigned int *height, bool *png) {
    *width = *height = 0;
    static const unsigned char signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (length >= 33 && !memcmp(bytes, signature, 8) && mgu_metadata_u32(bytes + 8) == 13 && !memcmp(bytes + 12, "IHDR", 4)) {
        *png = true;
        *width = mgu_metadata_u32(bytes + 16);
        *height = mgu_metadata_u32(bytes + 20);
    } else if (length >= 4 && bytes[0] == 0xff && bytes[1] == 0xd8) {
        *png = false;
        size_t at = 2;
        while (at < length) {
            if (bytes[at++] != 0xff) return false;
            while (at < length && bytes[at] == 0xff) ++at;
            if (at >= length) return false;
            unsigned char marker = bytes[at++];
            if (marker == 0xd9 || marker == 0xda || marker == 0) return false;
            if (marker == 0xd8 || marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (length - at < 2) return false;
            size_t size = ((size_t) bytes[at] << 8) | bytes[at + 1];
            if (size < 2 || size > length - at) return false;
            if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
                if (size < 8) return false;
                *height = ((unsigned int) bytes[at + 3] << 8) | bytes[at + 4];
                *width = ((unsigned int) bytes[at + 5] << 8) | bytes[at + 6];
                break;
            }
            at += size;
        }
    }
    return *width && *height && *width <= 4096 && *height <= 4096 && (uint64_t) *width * *height <= 16777216;
}

static void mgu_audio_metadata_artwork(const void *buffer, int length) {
    if (!mgu_audio_only && !mgu_audio_auto) return;
    mgu_metadata_guard guard;
    unsigned int width = 0, height = 0;
    bool png = false;
    if (!buffer || length <= 0 || length > 2097152 ||
        !mgu_metadata_image_size((const unsigned char *) buffer, (size_t) length, &width, &height, &png)) {
        mgu_metadata_clear_art();
        mgu_metadata_publish();
        return;
    }
    const char *file = png ? "cover.png" : "cover.jpg";
    if (!mgu_metadata_write(file, "cover.tmp", buffer, (size_t) length)) return;
    int directory = mgu_metadata_dir();
    if (directory >= 0) {
        const char *old = png ? "cover.jpg" : "cover.png";
        struct stat st;
        if (!fstatat(directory, old, &st, AT_SYMLINK_NOFOLLOW) && S_ISREG(st.st_mode) &&
            st.st_uid == geteuid() && st.st_nlink == 1) unlinkat(directory, old, 0);
    }
    mgu_metadata_art_file = file;
    mgu_metadata_art_mime = png ? "image/png" : "image/jpeg";
    mgu_metadata_art_width = width;
    mgu_metadata_art_height = height;
    mgu_metadata_art_revision = mgu_metadata_revision + 1;
    mgu_metadata_publish();
}
#endif
