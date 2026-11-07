#include <gst/app/gstappsrc.h>
#include <gst/video/video.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <string.h>

static GstBuffer *frame(guint w, guint h) {
    gint strides[GST_VIDEO_MAX_PLANES] = {(gint)w + 8, (gint)w / 2 + 4, (gint)w / 2 + 4, 0};
    gsize offsets[GST_VIDEO_MAX_PLANES] = {0, (gsize)strides[0] * h, 0, 0};
    offsets[2] = offsets[1] + strides[1] * (h / 2);
    GstBuffer *b = gst_buffer_new_allocate(NULL, offsets[2] + strides[2] * (h / 2), NULL);
    GstMapInfo map;
    g_assert(gst_buffer_map(b, &map, GST_MAP_WRITE));
    memset(map.data, 0xee, map.size);
    for (guint p = 0; p < 3; p++) for (guint y = 0; y < (p ? h / 2 : h); y++)
        memset(map.data + offsets[p] + y * strides[p], 30 + 70 * p, p ? w / 2 : w);
    gst_buffer_unmap(b, &map);
    gst_buffer_add_video_meta_full(b, GST_VIDEO_FRAME_FLAG_NONE, GST_VIDEO_FORMAT_I420, w, h, 3, offsets, strides);
    return b;
}
static void check_frame(const char *path, guint w, guint h, guint sequence) {
    guint32 header[16] = {0}; int fd = -1;
    for (guint i = 0; i < 300; i++) {
        fd = open(path, O_RDONLY);
        if (fd >= 0 && read(fd, header, sizeof(header)) == sizeof(header) && GUINT32_FROM_LE(header[4]) >= sequence &&
            GUINT32_FROM_LE(header[2]) == w && GUINT32_FROM_LE(header[3]) == h) break;
        if (fd >= 0) close(fd);
        fd = -1; g_usleep(10000);
    }
    g_assert_cmpint(fd, >=, 0);
    g_assert_cmpuint(GUINT32_FROM_LE(header[0]), ==, 0x4656474d);
    g_assert_cmpuint(GUINT32_FROM_LE(header[2]), ==, w);
    g_assert_cmpuint(GUINT32_FROM_LE(header[3]), ==, h);
    g_assert_cmpuint(GUINT32_FROM_LE(header[6]), ==, 3);
    gsize size = w * h * 3 / 2;
    guint8 *data = g_malloc(size);
    g_assert_cmpint(pread(fd, data, size, 64 + GUINT32_FROM_LE(header[5]) * size), ==, (gssize)size);
    gsize at = 0;
    for (guint p = 0; p < 3; p++) for (guint i = 0; i < (p ? w * h / 4 : w * h); i++)
        g_assert_cmpuint(data[at++], ==, 30 + 70 * p);
    g_free(data); close(fd);
}
int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    gchar *path = g_strdup_printf("/dev/shm/mgu-video-test-%d", getpid());
    gchar *launch = g_strdup_printf("appsrc name=input format=time ! mguvideosink location=%s sync=false async=false", path);
    GError *error = NULL;
    GstElement *pipeline = gst_parse_launch(launch, &error);
    g_assert_no_error(error); g_assert_nonnull(pipeline);
    GstElement *src = gst_bin_get_by_name(GST_BIN(pipeline), "input");
    g_assert(gst_element_set_state(pipeline, GST_STATE_PLAYING) != GST_STATE_CHANGE_FAILURE);
    const guint sizes[][2] = {{18,16}, {32,18}, {332,720}, {720,332}, {332,720}};
    for (guint i = 0; i < G_N_ELEMENTS(sizes); i++) {
        guint w = sizes[i][0], h = sizes[i][1];
        GstCaps *caps = gst_caps_new_simple("video/x-raw", "format", G_TYPE_STRING, "I420",
            "width", G_TYPE_INT, w, "height", G_TYPE_INT, h, "framerate", GST_TYPE_FRACTION, 30, 1, NULL);
        gst_app_src_set_caps(GST_APP_SRC(src), caps); gst_caps_unref(caps);
        g_assert_cmpint(gst_app_src_push_buffer(GST_APP_SRC(src), frame(w, h)), ==, GST_FLOW_OK);
        check_frame(path, w, h, i + 1);
    }
    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_object_unref(src); gst_object_unref(pipeline);
    g_assert_cmpint(access(path, F_OK), ==, -1);
    g_free(path); g_free(launch);
    g_print("I420 stride copying, renegotiation, frame headers and cleanup passed\n");
    return 0;
}
