/* Private MGU AirPlay prototype: I420 frames to mgu-render's MGVF protocol. */
#define _GNU_SOURCE
#include <gst/video/gstvideosink.h>
#include <gst/video/video.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define SLOT_COUNT 3u
#define MAX_EDGE 2048u
#define MAP_BYTES (64u + SLOT_COUNT * MAX_EDGE * MAX_EDGE * 3u / 2u)
#define MGVF_MAGIC 0x4656474du
#ifndef PACKAGE
#define PACKAGE "mgu-airplay"
#endif

typedef struct {
    int fd;
    guint8 *map;
    char *path;
    dev_t device;
    ino_t inode;
    unsigned refs;
    guint32 seq;
    guint32 slot;
} FrameFile;

typedef struct {
    GstVideoSink parent;
    char *location;
    GstVideoInfo info;
    gboolean have_caps;
    FrameFile *file;
} MguVideoSink;
typedef struct { GstVideoSinkClass parent; } MguVideoSinkClass;

G_DEFINE_TYPE(MguVideoSink, mgu_video_sink, GST_TYPE_VIDEO_SINK)
static GMutex file_lock;
static FrameFile *shared_file;
enum { PROP_0, PROP_LOCATION };

static gboolean valid_path(const char *p) {
    const char *prefix = "/dev/shm/mgu-video-";
    if (!p || !g_str_has_prefix(p, prefix)) return FALSE;
    p += strlen(prefix);
    if (!*p || *p == '.' || strlen(p) > 64) return FALSE;
    for (; *p; ++p)
        if (!g_ascii_isalnum(*p) && *p != '-' && *p != '_' && *p != '.') return FALSE;
    return TRUE;
}

static gboolean sink_start(GstBaseSink *base) {
    MguVideoSink *self = (MguVideoSink *)base;
    gboolean ok = FALSE;
    g_mutex_lock(&file_lock);
    if (!valid_path(self->location)) goto done;
    if (shared_file) {
        if (strcmp(shared_file->path, self->location)) goto done;
        shared_file->refs++;
        self->file = shared_file;
        ok = TRUE;
        goto done;
    }
    int fd = open(self->location, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) goto done;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != geteuid() || st.st_nlink != 1 ||
        ftruncate(fd, MAP_BYTES)) {
        close(fd);
        unlink(self->location);
        goto done;
    }
    guint8 *map = mmap(NULL, MAP_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (map == MAP_FAILED) { close(fd); unlink(self->location); goto done; }
    FrameFile *file = g_new0(FrameFile, 1);
    file->fd = fd; file->map = map; file->path = g_strdup(self->location);
    file->device = st.st_dev; file->inode = st.st_ino; file->refs = 1;
    memset(map, 0, 64);
    shared_file = self->file = file;
    ok = TRUE;
done:
    g_mutex_unlock(&file_lock);
    if (!ok) GST_ELEMENT_ERROR(self, RESOURCE, OPEN_WRITE,
                              ("Cannot create private MGU frame file"), ("%s", g_strerror(errno)));
    return ok;
}

static gboolean sink_stop(GstBaseSink *base) {
    MguVideoSink *self = (MguVideoSink *)base;
    g_mutex_lock(&file_lock);
    FrameFile *file = self->file;
    self->file = NULL;
    if (file && --file->refs == 0) {
        struct stat st;
        munmap(file->map, MAP_BYTES);
        close(file->fd);
        if (!lstat(file->path, &st) && st.st_dev == file->device && st.st_ino == file->inode)
            unlink(file->path);
        g_free(file->path); g_free(file);
        shared_file = NULL;
    }
    g_mutex_unlock(&file_lock);
    return TRUE;
}

static gboolean sink_caps(GstBaseSink *base, GstCaps *caps) {
    MguVideoSink *self = (MguVideoSink *)base;
    GstVideoInfo info;
    if (!gst_video_info_from_caps(&info, caps) || GST_VIDEO_INFO_FORMAT(&info) != GST_VIDEO_FORMAT_I420)
        return FALSE;
    guint w = GST_VIDEO_INFO_WIDTH(&info), h = GST_VIDEO_INFO_HEIGHT(&info);
    if (w < 16 || h < 16 || w > MAX_EDGE || h > MAX_EDGE || (w & 1) || (h & 1)) return FALSE;
    self->info = info; self->have_caps = TRUE;
    return TRUE;
}

static GstFlowReturn sink_frame(GstVideoSink *sink, GstBuffer *buffer) {
    MguVideoSink *self = (MguVideoSink *)sink;
    GstVideoFrame frame;
    if (!self->have_caps || !gst_video_frame_map(&frame, &self->info, buffer, GST_MAP_READ))
        return GST_FLOW_NOT_NEGOTIATED;
    guint w = GST_VIDEO_INFO_WIDTH(&self->info), h = GST_VIDEO_INFO_HEIGHT(&self->info);
    gsize size = (gsize)w * h * 3 / 2;
    g_mutex_lock(&file_lock);
    FrameFile *file = self->file;
    if (!file) { g_mutex_unlock(&file_lock); gst_video_frame_unmap(&frame); return GST_FLOW_FLUSHING; }
    guint next = (file->slot + 1) % SLOT_COUNT;
    guint8 *dest = file->map + 64 + next * size;
    for (guint plane = 0; plane < 3; ++plane) {
        guint rows = plane ? h / 2 : h, columns = plane ? w / 2 : w;
        guint8 *src = GST_VIDEO_FRAME_PLANE_DATA(&frame, plane);
        gint stride = GST_VIDEO_FRAME_PLANE_STRIDE(&frame, plane);
        if ((guint)stride == columns) {
            /* Tightly packed plane (the 1280x720 output): one copy. */
            memcpy(dest, src, (gsize)rows * columns);
            dest += (gsize)rows * columns;
        } else for (guint row = 0; row < rows; ++row) {
            memcpy(dest, src + (gssize)row * stride, columns);
            dest += columns;
        }
    }
    guint32 *header = (guint32 *)file->map;
    header[0] = GUINT32_TO_LE(MGVF_MAGIC); header[1] = GUINT32_TO_LE(1);
    header[2] = GUINT32_TO_LE(w); header[3] = GUINT32_TO_LE(h);
    header[6] = GUINT32_TO_LE(SLOT_COUNT);
    header[7] = GUINT32_TO_LE(self->info.colorimetry.matrix == GST_VIDEO_COLOR_MATRIX_BT709 ? 1 : 0);
    header[8] = GUINT32_TO_LE(self->info.colorimetry.range == GST_VIDEO_COLOR_RANGE_0_255 ? 1 : 0);
    __atomic_store_n(&header[5], GUINT32_TO_LE(next), __ATOMIC_RELEASE);
    file->slot = next; file->seq++;
    __atomic_store_n(&header[4], GUINT32_TO_LE(file->seq), __ATOMIC_RELEASE);
    g_mutex_unlock(&file_lock);
    gst_video_frame_unmap(&frame);
    return GST_FLOW_OK;
}

static void set_property(GObject *object, guint id, const GValue *value, GParamSpec *spec) {
    MguVideoSink *self = (MguVideoSink *)object;
    if (id == PROP_LOCATION && !self->file) { g_free(self->location); self->location = g_value_dup_string(value); }
    else G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
}
static void get_property(GObject *object, guint id, GValue *value, GParamSpec *spec) {
    if (id == PROP_LOCATION) g_value_set_string(value, ((MguVideoSink *)object)->location);
    else G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
}
static void finalize(GObject *object) {
    MguVideoSink *self = (MguVideoSink *)object;
    if (self->file) sink_stop(GST_BASE_SINK(self));
    g_free(self->location);
    G_OBJECT_CLASS(mgu_video_sink_parent_class)->finalize(object);
}
static void mgu_video_sink_class_init(MguVideoSinkClass *klass) {
    GObjectClass *object = G_OBJECT_CLASS(klass);
    GstElementClass *element = GST_ELEMENT_CLASS(klass);
    object->set_property = set_property; object->get_property = get_property; object->finalize = finalize;
    g_object_class_install_property(object, PROP_LOCATION,
        g_param_spec_string("location", "Frame file", "Private mgu-render frame path", NULL,
                            G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS));
    GstCaps *caps = gst_caps_from_string("video/x-raw,format=I420,width=[16,2048],height=[16,2048],framerate=[0/1,240/1]");
    GstPadTemplate *pad = gst_pad_template_new("sink", GST_PAD_SINK, GST_PAD_ALWAYS, caps);
    gst_element_class_add_pad_template(element, pad); gst_caps_unref(caps);
    gst_element_class_set_static_metadata(element, "MGU video sink", "Sink/Video",
        "I420 shared frame transport for mgu-render", "MGU AirPlay prototype");
    GstBaseSinkClass *base = GST_BASE_SINK_CLASS(klass);
    base->start = sink_start; base->stop = sink_stop; base->set_caps = sink_caps;
    GST_VIDEO_SINK_CLASS(klass)->show_frame = sink_frame;
}
static void mgu_video_sink_init(MguVideoSink *self) { gst_video_info_init(&self->info); }
static gboolean plugin_init(GstPlugin *plugin) {
    return gst_element_register(plugin, "mguvideosink", GST_RANK_NONE, mgu_video_sink_get_type());
}
GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mguvideo, "MGU I420 frame sink",
                  plugin_init, "0.1.0", "Proprietary", PACKAGE, "https://github.com/FDH2/UxPlay")
