/* Real native metadata parser/export tests; no media source or display needed. */
#include <cassert>
#include <fstream>
#include <vector>
#include <string>
static bool mgu_audio_only = true;
static bool mgu_audio_auto = false;
#include "mgu_audio_metadata.h"

static void append32(std::vector<unsigned char> &output, uint32_t value) {
    for (int shift = 24; shift >= 0; shift -= 8) output.push_back((value >> shift) & 255);
}

static void field(std::vector<unsigned char> &output, const char *tag, const std::string &text) {
    output.insert(output.end(), tag, tag + 4);
    append32(output, text.size());
    output.insert(output.end(), text.begin(), text.end());
}

static std::vector<unsigned char> metadata(const std::string &title, const std::string &artist, const std::string &album) {
    std::vector<unsigned char> fields;
    field(fields, "minm", title);
    field(fields, "asar", artist);
    field(fields, "asal", album);
    std::vector<unsigned char> value = {'m', 'l', 'i', 't'};
    append32(value, fields.size());
    value.insert(value.end(), fields.begin(), fields.end());
    return value;
}

static std::string read_file(const std::string &path) {
    std::ifstream file(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

int main() {
    char temporary[] = "/tmp/mgu-audio-metadata-XXXXXX";
    char *directory = mkdtemp(temporary);
    assert(directory);
    setenv("MGU_MUSIC_DIR", directory, 1);
    mgu_audio_metadata_clear();
    std::string json_path = std::string(directory) + "/current.json";
    std::string cover_path = std::string(directory) + "/cover.png";
    struct stat st;
    assert(!stat(json_path.c_str(), &st) && (st.st_mode & 0777) == 0600);
    assert(read_file(json_path).find("\"artwork\":null") != std::string::npos);

    auto track = metadata("  Café\n\t🎵 \"Song\" ", " Artist\001 ", "Album");
    mgu_audio_metadata_receive(track.data(), track.size());
    assert(mgu_metadata_title == "Café 🎵 \"Song\"");
    assert(mgu_metadata_artist == "Artist");
    assert(mgu_metadata_album == "Album");
    std::string valid_json = read_file(json_path);
    assert(valid_json.find("Café 🎵 \\\"Song\\\"") != std::string::npos);
    assert(valid_json.find("\"artist\":\"Artist\"") != std::string::npos);

    auto malformed = track;
    malformed[15] = 255; /* Inner DMAP item length extends past its buffer. */
    mgu_audio_metadata_receive(malformed.data(), malformed.size());
    assert(read_file(json_path) == valid_json);
    malformed = track;
    malformed.pop_back();
    mgu_audio_metadata_receive(malformed.data(), malformed.size());
    assert(read_file(json_path) == valid_json);
    mgu_audio_metadata_receive(NULL, 1);
    assert(read_file(json_path) == valid_json);

    /* A bounded PNG header is sufficient for native transport validation.
     * The JS decoder separately rejects any image that does not decode. */
    unsigned char png[33] = {137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 'I', 'H', 'D', 'R',
                            0, 0, 1, 0, 0, 0, 1, 0, 8, 6};
    mgu_audio_metadata_artwork(png, sizeof png);
    assert(!stat(cover_path.c_str(), &st) && st.st_size == sizeof png && (st.st_mode & 0777) == 0600);
    assert(mgu_metadata_art_width == 256 && mgu_metadata_art_height == 256);
    assert(read_file(json_path).find("\"file\":\"cover.png\"") != std::string::npos);
    assert(read_file(json_path).find("\"mime\":\"image/png\"") != std::string::npos);

    track = metadata("Next track", "New artist", "");
    mgu_audio_metadata_receive(track.data(), track.size());
    assert(mgu_metadata_title == "Next track" && mgu_metadata_artist == "New artist");
    assert(mgu_metadata_art_file.empty() && access(cover_path.c_str(), F_OK));
    assert(read_file(json_path).find("\"artwork\":null") != std::string::npos);

    png[16] = 1; /* Reject excessive image dimensions before decoder allocation. */
    mgu_audio_metadata_artwork(png, sizeof png);
    assert(mgu_metadata_art_file.empty() && access(cover_path.c_str(), F_OK));
    png[16] = 0;
    unsigned char jpeg[] = {255, 216, 255, 192, 0, 8, 8, 1, 0, 2, 0, 3, 255, 217};
    unsigned int width = 0, height = 0;
    bool is_png = true;
    assert(mgu_metadata_image_size(jpeg, sizeof jpeg, &width, &height, &is_png));
    assert(width == 512 && height == 256 && !is_png);
    jpeg[5] = 255;
    assert(!mgu_metadata_image_size(jpeg, sizeof jpeg, &width, &height, &is_png));

    std::vector<unsigned char> huge(65537, 0);
    mgu_audio_metadata_receive(huge.data(), huge.size());
    assert(mgu_metadata_title == "Next track");
    track = metadata(std::string(10000, 'a'), "", "");
    mgu_audio_metadata_receive(track.data(), track.size());
    assert(mgu_metadata_title.size() == 256 && read_file(json_path).size() <= 4096);
    mgu_audio_metadata_clear();
    assert(mgu_metadata_title.empty() && mgu_metadata_artist.empty() && mgu_metadata_art_file.empty());
    assert(read_file(json_path).find("\"title\":\"\"") != std::string::npos);

    /* Existing temp links are never followed, overwritten or removed. */
    std::string target = std::string(directory) + "/target";
    { std::ofstream output(target); output << "keep"; }
    std::string link = std::string(directory) + "/current.json.tmp";
    assert(!symlink(target.c_str(), link.c_str()));
    mgu_audio_metadata_clear();
    assert(read_file(target) == "keep" && !lstat(link.c_str(), &st) && S_ISLNK(st.st_mode));
    unlink(link.c_str());
    unlink(target.c_str());
    unlink(json_path.c_str());
    close(mgu_metadata_directory);
    mgu_metadata_directory = -1;
    assert(!rmdir(directory));
    puts("Native bounded DMAP metadata, atomic private export, artwork validation and stale-art clearing passed");
}
