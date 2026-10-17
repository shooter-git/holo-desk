/*
 * HO[LO] Engine's native piece, for Node through Node-API: the sound device (miniaudio: WASAPI on
 * Windows, Core Audio on macOS, ALSA, PulseAudio or JACK on Linux) and every MIDI input (WinMM,
 * CoreMIDI, the ALSA sequencer).
 *
 * The engine is JavaScript (@holo/engine, the same code as the studio's audio thread). It renders
 * 128-frame blocks on a worker thread when the device asks for sound: the device's callback says how
 * much it needs, waits (part of its period at most) for the worker to render it, and plays it. MIDI
 * is queued as it arrives and the worker takes it in just before each block, so a note sounds in the
 * very next callback's sound.
 */
#if defined(__linux__)
#define _GNU_SOURCE /* RTLD_DEFAULT */
#elif defined(__APPLE__)
#define _DARWIN_C_SOURCE /* RTLD_DEFAULT, which -std=c11 would otherwise hide */
#endif
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#if defined(_WIN32)
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MA_ENABLE_NULL
#elif defined(__APPLE__)
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_COREAUDIO
#define MA_ENABLE_NULL
#define MA_NO_RUNTIME_LINKING
#endif
#define MINIAUDIO_IMPLEMENTATION
/* the build passes the path of miniaudio.h: the release it fetched and checked (build.mjs) */
#include HOLO_MINIAUDIO

#include <math.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "napi_min.h"

#if defined(_WIN32)
#include <avrt.h>
#include <mmsystem.h>
#include <wchar.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <CoreMIDI/CoreMIDI.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <pthread.h>
#else
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <semaphore.h>
#include <time.h>
#endif

#if defined(_WIN32)
#define HOLO_EXPORT __declspec(dllexport)
#else
#define HOLO_EXPORT __attribute__((visibility("default")))
#endif

/* ---- Node-API, found in the Node that loaded us ---- */

#define HOLO_DECLARE(ret, name, args) \
  typedef ret(*name##_fn) args;       \
  static name##_fn p_##name;
HOLO_NAPI_CALLS(HOLO_DECLARE)

static void *find_napi(const char *name) {
#if defined(_WIN32)
  void *f = (void *)GetProcAddress(GetModuleHandleW(NULL), name);
  if (!f) {
    HMODULE lib = GetModuleHandleW(L"libnode.dll");
    if (lib) f = (void *)GetProcAddress(lib, name);
  }
  return f;
#else
  return dlsym(RTLD_DEFAULT, name);
#endif
}

/* ---- clocks and events ---- */

#if defined(_WIN32)
static double qpc_to_us;
#elif defined(__APPLE__)
static double mach_to_us;
#endif

/* Microseconds on a monotonic clock: the audio callbacks, MIDI and the worker all read this one. */
static double now_us(void) {
#if defined(_WIN32)
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * qpc_to_us;
#elif defined(__APPLE__)
  return (double)mach_absolute_time() * mach_to_us;
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1e6 + (double)ts.tv_nsec / 1e3;
#endif
}

/* A wake-up that doesn't count: set any number of times, one wait takes it. */
typedef struct {
#if defined(_WIN32)
  HANDLE h;
#elif defined(__APPLE__)
  dispatch_semaphore_t s;
  atomic_int flag;
#else
  sem_t s;
  atomic_int flag;
#endif
} hevent;

static void ev_init(hevent *e) {
#if defined(_WIN32)
  e->h = CreateEventW(NULL, FALSE, FALSE, NULL);
#elif defined(__APPLE__)
  e->s = dispatch_semaphore_create(0);
  atomic_store(&e->flag, 0);
#else
  sem_init(&e->s, 0, 0);
  atomic_store(&e->flag, 0);
#endif
}

static void ev_set(hevent *e) {
#if defined(_WIN32)
  SetEvent(e->h);
#elif defined(__APPLE__)
  if (atomic_exchange(&e->flag, 1) == 0) dispatch_semaphore_signal(e->s);
#else
  if (atomic_exchange(&e->flag, 1) == 0) sem_post(&e->s);
#endif
}

/* 1 when it was set, 0 when the time ran out. */
static int ev_wait(hevent *e, double us) {
#if defined(_WIN32)
  DWORD ms = us <= 0 ? 0 : (DWORD)ceil(us / 1000.0);
  return WaitForSingleObject(e->h, ms) == WAIT_OBJECT_0;
#elif defined(__APPLE__)
  long r = dispatch_semaphore_wait(e->s, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(us > 0 ? us * 1000.0 : 0)));
  if (r != 0) return 0;
  atomic_store(&e->flag, 0);
  return 1;
#else
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  long long ns = (long long)ts.tv_nsec + (long long)(us > 0 ? us * 1000.0 : 0);
  ts.tv_sec += (time_t)(ns / 1000000000LL);
  ts.tv_nsec = (long)(ns % 1000000000LL);
  int r;
  do r = sem_timedwait(&e->s, &ts);
  while (r != 0 && errno == EINTR);
  if (r != 0) return 0;
  atomic_store(&e->flag, 0);
  return 1;
#endif
}

/* ---- a small lock ---- */

#if defined(_WIN32)
typedef SRWLOCK hlock;
#define LOCK_INIT SRWLOCK_INIT
#define lock_take(l) AcquireSRWLockExclusive(l)
#define lock_give(l) ReleaseSRWLockExclusive(l)
#else
typedef pthread_mutex_t hlock;
#define LOCK_INIT PTHREAD_MUTEX_INITIALIZER
#define lock_take(l) pthread_mutex_lock(l)
#define lock_give(l) pthread_mutex_unlock(l)
#endif

/* ---- the sound device ---- */

#define RING_FRAMES 8192 /* a power of two */
#define MARKS 256
#define LATENCIES 64
#define BLOCK 128

static struct {
  ma_context ctx;
  int ctx_ok;
  int ctx_null;
  ma_device dev;
  int dev_ok;
  /* rendered sound, interleaved stereo, written by the worker and read by the callback */
  float ring[RING_FRAMES * 2];
  _Atomic uint64_t w, r;
  /* frames a callback is waiting for, and how many the worker keeps ready between callbacks */
  atomic_uint demand, cushion;
  atomic_int alive;
  _Atomic uint64_t underruns, late;
  atomic_int lost;
  /*
   * Which frame the device takes when: frame ≈ clock + t·rate, the clock smoothed over half a second
   * of callbacks (devices that ask in bursts would otherwise make it jump by a burst).
   */
  _Atomic double clock;
  int clock_set;
  hevent render_ev, ready_ev;
  double budget_us;
  double buffer_us;
  uint32_t rate, period, buffer;
} A;

/* Notes played live: the frame each one is rendered at, and when it arrived (worker → callback). */
static struct {
  atomic_uint head, tail;
  uint64_t frame[MARKS];
  double t[MARKS];
} Marks;

/* How long they took from the cable to the speakers (µs), the last LATENCIES of them. */
static struct {
  atomic_uint n;
  float us[LATENCIES];
} Lat;

/*
 * The default input (a microphone, an interface's inputs), at the engine's rate: for audio tracks
 * (into a ring the worker reads a block at a time) and for measuring the round trip. Open while
 * either wants it.
 */
#define IN_FRAMES 8192 /* a power of two */
#define IN_TRACKS 1
#define IN_MEASURE 2
static struct {
  ma_device dev;
  int ok;
  int users;
  float ring[IN_FRAMES * 2];
  _Atomic uint64_t w, r;
  atomic_int recording;
  uint32_t buffer;
} In;
static void capture_close(int user);

/* The round trip, measured: clicks out, the microphone listening. */
static struct {
  atomic_int on;
  uint64_t frame;
  uint64_t click_at;
  _Atomic double click_us;
  atomic_int armed;
  double noise;
  float rt[64];
  atomic_int count;
} Ms;

static void measure_clicks(float *out, ma_uint32 frames, double t0) {
  uint32_t period = A.rate / 2;
  for (ma_uint32 i = 0; i < frames; i++) {
    uint64_t f = Ms.frame + i;
    if (f % period == 0 && f > (uint64_t)(A.rate * 0.4)) {
      Ms.click_at = f;
      atomic_store(&Ms.click_us, t0 + (double)i * 1e6 / A.rate);
      atomic_store(&Ms.armed, 1);
    }
    int64_t k = (int64_t)(f - Ms.click_at);
    float s = 0.0f;
    if (Ms.click_at > 0 && k >= 0 && k < 64) s = (float)(sin(2 * MA_PI_D * 2500.0 * (double)k / A.rate) * (1.0 - k / 64.0) * 0.9);
    out[i * 2] = s;
    out[i * 2 + 1] = s;
  }
  Ms.frame += frames;
}

static void on_capture(ma_device *dev, void *out, const void *in, ma_uint32 frames) {
  (void)dev;
  (void)out;
  const float *x = (const float *)in;
  if (!x) return;
  if (atomic_load(&In.recording)) {
    /* stereo frames into the ring (a full ring drops the newest: the worker has stopped reading) */
    uint64_t w = atomic_load(&In.w);
    uint64_t r = atomic_load(&In.r);
    for (ma_uint32 i = 0; i < frames && w - r < IN_FRAMES; i++, w++) {
      uint32_t at = (uint32_t)(w & (IN_FRAMES - 1)) * 2;
      In.ring[at] = x[i * 2];
      In.ring[at + 1] = x[i * 2 + 1];
    }
    atomic_store(&In.w, w);
  }
  if (!atomic_load(&Ms.on)) return;
  double t_end = now_us();
  double click = atomic_load(&Ms.click_us);
  for (ma_uint32 i = 0; i < frames; i++) {
    double t = t_end - (double)(frames - i) * 1e6 / A.rate;
    double v = fabs((double)x[i * 2]);
    double dt = t - click;
    if (click <= 0 || dt > 250000) {
      /* between clicks: how loud the room is */
      Ms.noise = v > Ms.noise * 0.9995 ? v : Ms.noise * 0.9995;
    } else if (atomic_load(&Ms.armed) && dt > 2000 && v > (Ms.noise * 5 > 0.03 ? Ms.noise * 5 : 0.03)) {
      atomic_store(&Ms.armed, 0);
      int c = atomic_load(&Ms.count);
      if (c < 64) {
        Ms.rt[c] = (float)(dt / 1000.0);
        atomic_store(&Ms.count, c + 1);
      }
    }
  }
}

static uint32_t ring_fill(void) { return (uint32_t)(atomic_load(&A.w) - atomic_load(&A.r)); }

static void on_audio(ma_device *dev, void *out, const void *in, ma_uint32 frames) {
  (void)dev;
  (void)in;
  float *o = (float *)out;
  double t0 = now_us();
  uint64_t r = atomic_load(&A.r);
  uint64_t w = atomic_load(&A.w);
  if (w - r < frames) {
    /* ask the worker for this callback's sound and wait for it, not past the budget (before its
       first block there's nothing to wait for: the request stands and this callback is silent) */
    atomic_store(&A.demand, frames);
    ev_set(&A.render_ev);
    if (atomic_load(&A.alive)) {
      double deadline = t0 + A.budget_us;
      for (;;) {
        w = atomic_load(&A.w);
        if (w - r >= frames) break;
        double now = now_us();
        if (now >= deadline) {
          atomic_fetch_add(&A.late, 1);
          break;
        }
        ev_wait(&A.ready_ev, deadline - now);
      }
      atomic_store(&A.demand, 0);
    }
  }
  uint32_t have = (uint32_t)(w - r);
  uint32_t n = have < frames ? have : frames;
  for (uint32_t i = 0; i < n; i++) {
    uint32_t at = (uint32_t)((r + i) & (RING_FRAMES - 1)) * 2;
    o[i * 2] = A.ring[at];
    o[i * 2 + 1] = A.ring[at + 1];
  }
  if (n < frames) {
    memset(o + n * 2, 0, (size_t)(frames - n) * 2 * sizeof(float));
    if (atomic_load(&A.alive)) atomic_fetch_add(&A.underruns, 1);
  }
  if (atomic_load(&Ms.on)) measure_clicks(o, frames, t0);
  /* the clock: this callback's frame and time, smoothed; silence played for want of sound moves it on */
  double offset = (double)r - t0 * A.rate / 1e6;
  double clock = atomic_load(&A.clock);
  if (!A.clock_set) {
    clock = offset;
    A.clock_set = 1;
  } else {
    clock += (offset - clock) * ((double)frames / (A.rate * 0.5));
  }
  clock -= (double)(frames - n);
  atomic_store(&A.clock, clock);
  /*
   * notes rendered in what this callback takes: from their arrival to when the device took their
   * first frame, plus its buffer (a device that stalls shows here as late)
   */
  unsigned tail = atomic_load(&Marks.tail);
  while (tail != atomic_load(&Marks.head)) {
    unsigned i = tail % MARKS;
    if (Marks.frame[i] >= r + n) break;
    double heard = t0 + (double)(int64_t)(Marks.frame[i] - r) * 1e6 / A.rate + A.buffer_us;
    unsigned k = atomic_load(&Lat.n);
    Lat.us[k % LATENCIES] = (float)(heard - Marks.t[i]);
    atomic_store(&Lat.n, k + 1);
    tail++;
  }
  atomic_store(&Marks.tail, tail);
  atomic_store(&A.r, r + n);
  /* the worker tops up whatever cushion it keeps */
  ev_set(&A.render_ev);
}

static void on_notification(const ma_device_notification *n) {
  if (n->type == ma_device_notification_type_stopped && A.dev_ok) atomic_store(&A.lost, 1);
}

/* The system's default output changed while the device has it exclusively (shared mode follows by itself). */
static atomic_int default_changed;

#if defined(_WIN32)
/*
 * Windows says when the default output changes. miniaudio moves a shared stream to the new device but
 * leaves an exclusive one where it is, so this notices, and the worker opens the device again.
 */
static HRESULT STDMETHODCALLTYPE nt_query(ma_IMMNotificationClient *self, const IID *const riid, void **out) {
  if (ma_is_guid_equal(riid, &MA_IID_IUnknown) || ma_is_guid_equal(riid, &MA_IID_IMMNotificationClient)) {
    *out = self;
    return S_OK;
  }
  *out = NULL;
  return E_NOINTERFACE;
}
static ULONG STDMETHODCALLTYPE nt_ref(ma_IMMNotificationClient *self) {
  (void)self;
  return 1; /* one static object */
}
static HRESULT STDMETHODCALLTYPE nt_state(ma_IMMNotificationClient *self, const WCHAR *id, DWORD state) {
  (void)self;
  (void)id;
  (void)state;
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE nt_device(ma_IMMNotificationClient *self, const WCHAR *id) {
  (void)self;
  (void)id;
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE nt_default(ma_IMMNotificationClient *self, ma_EDataFlow flow, ma_ERole role,
                                            const WCHAR *id) {
  (void)self;
  (void)id;
  if (flow == ma_eRender && role == ma_eConsole && A.dev_ok && A.dev.playback.shareMode == ma_share_mode_exclusive)
    atomic_store(&default_changed, 1);
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE nt_property(ma_IMMNotificationClient *self, const WCHAR *id, const PROPERTYKEY key) {
  (void)self;
  (void)id;
  (void)key;
  return S_OK;
}
static ma_IMMNotificationClientVtbl notifier_vtbl = {nt_query,  nt_ref,    nt_ref,     nt_state,
                                                     nt_device, nt_device, nt_default, nt_property};
static ma_IMMNotificationClient notifier = {&notifier_vtbl, 0, NULL};
static ma_IMMDeviceEnumerator *notifier_en;

static void notifier_start(ma_context *ctx) {
  if (notifier_en) return;
  ma_IMMDeviceEnumerator *en = NULL;
  if (FAILED(ma_CoCreateInstance(ctx, &MA_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &MA_IID_IMMDeviceEnumerator,
                                 (void **)&en)))
    return;
  if (FAILED(ma_IMMDeviceEnumerator_RegisterEndpointNotificationCallback(en, &notifier))) {
    ma_IMMDeviceEnumerator_Release(en);
    return;
  }
  notifier_en = en;
}

static void notifier_stop(void) {
  if (!notifier_en) return;
  ma_IMMDeviceEnumerator_UnregisterEndpointNotificationCallback(notifier_en, &notifier);
  ma_IMMDeviceEnumerator_Release(notifier_en);
  notifier_en = NULL;
}

/* PKEY_Device_EnumeratorName: the bus the device hangs off ("BTHENUM", "BTHHFENUM", "BTHLEDEVICE": Bluetooth). */
static const PROPERTYKEY H_PKEY_Device_EnumeratorName = {
    {0xA45C254E, 0xDF1C, 0x4EFD, {0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 24};

/* Whether the default output is a Bluetooth device (its own link adds 100–250 ms; exclusive mode only crackles). */
static int default_is_bluetooth(ma_context *ctx) {
  ma_IMMDeviceEnumerator *en = NULL;
  ma_IMMDevice *device = NULL;
  ma_IPropertyStore *props = NULL;
  int bt = 0;
  if (FAILED(ma_CoCreateInstance(ctx, &MA_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &MA_IID_IMMDeviceEnumerator,
                                 (void **)&en)))
    return 0;
  if (SUCCEEDED(ma_IMMDeviceEnumerator_GetDefaultAudioEndpoint(en, ma_eRender, ma_eConsole, &device)) &&
      SUCCEEDED(ma_IMMDevice_OpenPropertyStore(device, STGM_READ, &props))) {
    MA_PROPVARIANT var;
    ma_PropVariantInit(&var);
    if (SUCCEEDED(ma_IPropertyStore_GetValue(props, &H_PKEY_Device_EnumeratorName, &var))) {
      if (var.vt == VT_LPWSTR && var.pwszVal && wcsncmp(var.pwszVal, L"BTH", 3) == 0) bt = 1;
      ma_PropVariantClear(ctx, &var);
    }
    ma_IPropertyStore_Release(props);
  }
  if (device) ma_IMMDevice_Release(device);
  ma_IMMDeviceEnumerator_Release(en);
  return bt;
}

/* The shortest period the device takes in exclusive mode, in frames at its mix rate (0 if unknown). */
static uint32_t exclusive_period(ma_context *ctx) {
  ma_IMMDeviceEnumerator *en = NULL;
  ma_IMMDevice *device = NULL;
  ma_IAudioClient *client = NULL;
  uint32_t frames = 0;
  HRESULT hr = ma_CoCreateInstance(ctx, &MA_CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &MA_IID_IMMDeviceEnumerator,
                                   (void **)&en);
  if (FAILED(hr)) return 0;
  hr = ma_IMMDeviceEnumerator_GetDefaultAudioEndpoint(en, ma_eRender, ma_eConsole, &device);
  if (SUCCEEDED(hr)) hr = ma_IMMDevice_Activate(device, &MA_IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&client);
  if (SUCCEEDED(hr)) {
    MA_REFERENCE_TIME def = 0, min = 0;
    MA_WAVEFORMATEX *mix = NULL;
    if (SUCCEEDED(ma_IAudioClient_GetDevicePeriod(client, &def, &min)) &&
        SUCCEEDED(ma_IAudioClient_GetMixFormat(client, &mix)) && mix) {
      frames = (uint32_t)ceil((double)min * mix->nSamplesPerSec / 1e7);
      ma_CoTaskMemFree(ctx, mix);
    }
    ma_IAudioClient_Release(client);
  }
  if (device) ma_IMMDevice_Release(device);
  ma_IMMDeviceEnumerator_Release(en);
  return frames;
}
#endif

/* ---- MIDI ---- */

#define MIDIQ 4096
#define MAXPORTS 64

static struct {
  struct {
    double t;
    int32_t slot;
    uint32_t word;
  } q[MIDIQ];
  uint32_t head, tail;
  hlock lock;
  atomic_uint dropped;
} Q = {.lock = LOCK_INIT};

static void midi_push(int slot, uint32_t word) {
  double t = now_us();
  lock_take(&Q.lock);
  if (Q.head - Q.tail < MIDIQ) {
    uint32_t i = Q.head % MIDIQ;
    Q.q[i].t = t;
    Q.q[i].slot = slot;
    Q.q[i].word = word;
    Q.head++;
  } else {
    atomic_fetch_add(&Q.dropped, 1);
  }
  lock_give(&Q.lock);
}

#if defined(__APPLE__)
/* Bytes into messages (running status, sysex and real time skipped): CoreMIDI hands over bytes. */
typedef struct {
  uint8_t status, have, need, sysex;
  uint8_t data[2];
} mparse;

static void parse_bytes(mparse *p, int slot, const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    uint8_t c = b[i];
    if (c >= 0xf8) continue;
    if (c == 0xf0) {
      p->sysex = 1;
      continue;
    }
    if (c & 0x80) {
      p->sysex = 0;
      p->have = 0;
      if (c >= 0xf0) {
        p->status = 0;
        continue;
      }
      p->status = c;
      p->need = (c & 0xe0) == 0xc0 ? 1 : 2;
      continue;
    }
    if (p->sysex || !p->status) continue;
    p->data[p->have++] = c;
    if (p->have == p->need) {
      midi_push(slot, (uint32_t)p->status | ((uint32_t)p->data[0] << 8) | (p->need == 2 ? (uint32_t)p->data[1] << 16 : 0));
      p->have = 0;
    }
  }
}
#endif

typedef struct {
  int used, open, seen;
  char name[256];
  char key[320];
#if defined(_WIN32)
  HMIDIIN h;
#elif defined(__APPLE__)
  MIDIEndpointRef src;
  mparse parse;
#else
  int client, port;
#endif
} mport;

static mport P[MAXPORTS];
static hlock ports_lock = LOCK_INIT;
static atomic_int midi_running;

/*
 * What the MIDI thread last found. Scanning can take a while (Windows asks each device's driver), so
 * it happens on that thread, never the render thread, which only copies this, in a moment.
 */
static struct {
  int count;
  struct {
    int slot, open;
    char name[256];
  } p[MAXPORTS];
} Snap;
static hlock snap_lock = LOCK_INIT;

/* With ports_lock held: the ports as they are now, for the render thread to read. */
static void publish(void) {
  lock_take(&snap_lock);
  Snap.count = 0;
  for (int i = 0; i < MAXPORTS; i++) {
    if (!P[i].used) continue;
    Snap.p[Snap.count].slot = i;
    Snap.p[Snap.count].open = P[i].open;
    memcpy(Snap.p[Snap.count].name, P[i].name, sizeof P[i].name);
    Snap.count++;
  }
  lock_give(&snap_lock);
}

static int slot_for(const char *key) {
  for (int i = 0; i < MAXPORTS; i++)
    if (P[i].used && strcmp(P[i].key, key) == 0) return i;
  for (int i = 0; i < MAXPORTS; i++)
    if (!P[i].used) {
      memset(&P[i], 0, sizeof P[i]);
      P[i].used = 1;
      snprintf(P[i].key, sizeof P[i].key, "%s", key);
      return i;
    }
  return -1;
}

#if defined(_WIN32)

static void CALLBACK winmm_in(HMIDIIN h, UINT msg, DWORD_PTR inst, DWORD_PTR p1, DWORD_PTR p2) {
  (void)h;
  (void)p2;
  /* channel messages only: clock and active sensing come many times a second and mean nothing here */
  if (msg == MIM_DATA && (p1 & 0x80) && (p1 & 0xff) < 0xf0) midi_push((int)inst, (uint32_t)(p1 & 0xffffff));
}

static void midi_close_port(mport *p) {
  if (p->open && p->h) {
    midiInStop(p->h);
    midiInReset(p->h);
    midiInClose(p->h);
  }
  p->h = NULL;
  p->open = 0;
}

static void midi_scan_os(void) {
  for (int i = 0; i < MAXPORTS; i++) P[i].seen = 0;
  UINT n = midiInGetNumDevs();
  for (UINT d = 0; d < n; d++) {
    MIDIINCAPSW caps;
    if (midiInGetDevCapsW(d, &caps, sizeof caps) != MMSYSERR_NOERROR) continue;
    char name[256];
    WideCharToMultiByte(CP_UTF8, 0, caps.szPname, -1, name, sizeof name, NULL, NULL);
    /* devices with the same name are told apart by their order */
    int same = 0;
    for (UINT e = 0; e < d; e++) {
      MIDIINCAPSW c2;
      if (midiInGetDevCapsW(e, &c2, sizeof c2) == MMSYSERR_NOERROR && wcscmp(c2.szPname, caps.szPname) == 0) same++;
    }
    char key[320];
    snprintf(key, sizeof key, "%s#%d", name, same);
    int s = slot_for(key);
    if (s < 0) continue;
    mport *p = &P[s];
    p->seen = 1;
    snprintf(p->name, sizeof p->name, "%s", name);
    if (!p->open) {
      HMIDIIN h = NULL;
      if (midiInOpen(&h, d, (DWORD_PTR)winmm_in, (DWORD_PTR)s, CALLBACK_FUNCTION) == MMSYSERR_NOERROR) {
        p->h = h;
        p->open = 1;
        midiInStart(h);
      }
    }
  }
  for (int i = 0; i < MAXPORTS; i++)
    if (P[i].used && !P[i].seen) {
      midi_close_port(&P[i]);
      P[i].used = 0;
    }
}

static HANDLE scan_thread;

/* Devices coming and going: looked for once a second. */
static DWORD WINAPI scan_main(LPVOID arg) {
  (void)arg;
  while (midi_running) {
    for (int i = 0; i < 10 && midi_running; i++) Sleep(100);
    if (!midi_running) break;
    lock_take(&ports_lock);
    midi_scan_os();
    publish();
    lock_give(&ports_lock);
  }
  return 0;
}

static void midi_start_os(void) {
  lock_take(&ports_lock);
  midi_scan_os();
  publish();
  lock_give(&ports_lock);
  if (!scan_thread) scan_thread = CreateThread(NULL, 0, scan_main, NULL, 0, NULL);
}

static void midi_stop_os(void) {
  if (scan_thread) {
    WaitForSingleObject(scan_thread, INFINITE);
    CloseHandle(scan_thread);
    scan_thread = NULL;
  }
  lock_take(&ports_lock);
  for (int i = 0; i < MAXPORTS; i++)
    if (P[i].used) {
      midi_close_port(&P[i]);
      P[i].used = 0;
    }
  publish();
  lock_give(&ports_lock);
}

#elif defined(__APPLE__)

static MIDIClientRef cm_client;
static MIDIPortRef cm_port;
static pthread_t cm_thread;
static dispatch_semaphore_t cm_ready;

static void cm_read(const MIDIPacketList *list, void *read_ref, void *src_ref) {
  (void)read_ref;
  int slot = (int)(intptr_t)src_ref;
  if (slot < 0 || slot >= MAXPORTS) return;
  const MIDIPacket *pk = &list->packet[0];
  for (UInt32 i = 0; i < list->numPackets; i++) {
    parse_bytes(&P[slot].parse, slot, pk->data, pk->length);
    pk = MIDIPacketNext(pk);
  }
}

static void midi_scan_os(void);

/*
 * CoreMIDI tells a client about devices coming and going on the run loop it was made on: this
 * thread's. It looks for them once a second too.
 */
static void *cm_main(void *arg) {
  (void)arg;
  if (!cm_client) {
    MIDIClientCreate(CFSTR("HO[LO] Engine"), NULL, NULL, &cm_client);
    MIDIInputPortCreate(cm_client, CFSTR("HO[LO] Engine in"), cm_read, NULL, &cm_port);
  }
  lock_take(&ports_lock);
  midi_scan_os();
  publish();
  lock_give(&ports_lock);
  dispatch_semaphore_signal(cm_ready);
  double last = now_us();
  while (midi_running) {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, false);
    if (now_us() - last < 1e6) continue;
    last = now_us();
    lock_take(&ports_lock);
    midi_scan_os();
    publish();
    lock_give(&ports_lock);
  }
  return NULL;
}

static void midi_start_os(void) {
  cm_ready = dispatch_semaphore_create(0);
  pthread_create(&cm_thread, NULL, cm_main, NULL);
  dispatch_semaphore_wait(cm_ready, dispatch_time(DISPATCH_TIME_NOW, 2000000000LL));
}

static void midi_scan_os(void) {
  if (!cm_port) return;
  for (int i = 0; i < MAXPORTS; i++) P[i].seen = 0;
  ItemCount n = MIDIGetNumberOfSources();
  for (ItemCount d = 0; d < n; d++) {
    MIDIEndpointRef src = MIDIGetSource(d);
    SInt32 offline = 0, uid = 0;
    MIDIObjectGetIntegerProperty(src, kMIDIPropertyOffline, &offline);
    if (offline) continue;
    MIDIObjectGetIntegerProperty(src, kMIDIPropertyUniqueID, &uid);
    char name[256] = "MIDI";
    CFStringRef cf = NULL;
    if (MIDIObjectGetStringProperty(src, kMIDIPropertyDisplayName, &cf) == noErr && cf) {
      CFStringGetCString(cf, name, sizeof name, kCFStringEncodingUTF8);
      CFRelease(cf);
    }
    char key[320];
    snprintf(key, sizeof key, "%d", (int)uid);
    int s = slot_for(key);
    if (s < 0) continue;
    mport *p = &P[s];
    p->seen = 1;
    snprintf(p->name, sizeof p->name, "%s", name);
    if (!p->open && MIDIPortConnectSource(cm_port, src, (void *)(intptr_t)s) == noErr) {
      p->src = src;
      p->open = 1;
    }
  }
  for (int i = 0; i < MAXPORTS; i++)
    if (P[i].used && !P[i].seen) {
      if (P[i].open) MIDIPortDisconnectSource(cm_port, P[i].src);
      P[i].used = 0;
    }
}

static void midi_stop_os(void) {
  pthread_join(cm_thread, NULL);
  lock_take(&ports_lock);
  for (int i = 0; i < MAXPORTS; i++)
    if (P[i].used) {
      if (P[i].open && cm_port) MIDIPortDisconnectSource(cm_port, P[i].src);
      P[i].used = 0;
    }
  publish();
  lock_give(&ports_lock);
}

#else /* Linux: the ALSA sequencer, through libasound found at run time */

typedef struct _snd_seq snd_seq_t;
typedef struct _snd_seq_client_info snd_seq_client_info_t;
typedef struct _snd_seq_port_info snd_seq_port_info_t;
typedef struct snd_midi_event snd_midi_event_t;
/* snd_seq_event_t: the type, the source address and, for decoding, the whole 28 bytes */
typedef struct {
  unsigned char type, flags, tag, queue;
  unsigned int time[2];
  unsigned char src_client, src_port, dst_client, dst_port;
  unsigned char data[12];
} seq_event;

static struct {
  void *lib;
  int (*open)(snd_seq_t **, const char *, int, int);
  int (*close)(snd_seq_t *);
  int (*set_client_name)(snd_seq_t *, const char *);
  int (*create_simple_port)(snd_seq_t *, const char *, unsigned int, unsigned int);
  int (*client_id)(snd_seq_t *);
  int (*connect_from)(snd_seq_t *, int, int, int);
  int (*disconnect_from)(snd_seq_t *, int, int, int);
  int (*event_input)(snd_seq_t *, seq_event **);
  int (*poll_descriptors)(snd_seq_t *, struct pollfd *, unsigned int, short);
  int (*client_info_malloc)(snd_seq_client_info_t **);
  void (*client_info_free)(snd_seq_client_info_t *);
  void (*client_info_set_client)(snd_seq_client_info_t *, int);
  int (*client_info_get_client)(const snd_seq_client_info_t *);
  const char *(*client_info_get_name)(snd_seq_client_info_t *);
  int (*query_next_client)(snd_seq_t *, snd_seq_client_info_t *);
  int (*port_info_malloc)(snd_seq_port_info_t **);
  void (*port_info_free)(snd_seq_port_info_t *);
  void (*port_info_set_client)(snd_seq_port_info_t *, int);
  void (*port_info_set_port)(snd_seq_port_info_t *, int);
  int (*port_info_get_port)(const snd_seq_port_info_t *);
  unsigned int (*port_info_get_capability)(const snd_seq_port_info_t *);
  const char *(*port_info_get_name)(const snd_seq_port_info_t *);
  int (*query_next_port)(snd_seq_t *, snd_seq_port_info_t *);
  int (*midi_event_new)(size_t, snd_midi_event_t **);
  void (*midi_event_free)(snd_midi_event_t *);
  void (*midi_event_no_status)(snd_midi_event_t *, int);
  long (*midi_event_decode)(snd_midi_event_t *, unsigned char *, long, const seq_event *);
} S;

static snd_seq_t *seq;
static int seq_port = -1;
static pthread_t seq_thread;
static atomic_int seq_rescan;

static int alsa_load(void) {
  if (S.lib) return 1;
  void *lib = dlopen("libasound.so.2", RTLD_NOW);
  if (!lib) return 0;
#define SYM(field, name)                    \
  *(void **)(&S.field) = dlsym(lib, name); \
  if (!S.field) return 0;
  SYM(open, "snd_seq_open")
  SYM(close, "snd_seq_close")
  SYM(set_client_name, "snd_seq_set_client_name")
  SYM(create_simple_port, "snd_seq_create_simple_port")
  SYM(client_id, "snd_seq_client_id")
  SYM(connect_from, "snd_seq_connect_from")
  SYM(disconnect_from, "snd_seq_disconnect_from")
  SYM(event_input, "snd_seq_event_input")
  SYM(poll_descriptors, "snd_seq_poll_descriptors")
  SYM(client_info_malloc, "snd_seq_client_info_malloc")
  SYM(client_info_free, "snd_seq_client_info_free")
  SYM(client_info_set_client, "snd_seq_client_info_set_client")
  SYM(client_info_get_client, "snd_seq_client_info_get_client")
  SYM(client_info_get_name, "snd_seq_client_info_get_name")
  SYM(query_next_client, "snd_seq_query_next_client")
  SYM(port_info_malloc, "snd_seq_port_info_malloc")
  SYM(port_info_free, "snd_seq_port_info_free")
  SYM(port_info_set_client, "snd_seq_port_info_set_client")
  SYM(port_info_set_port, "snd_seq_port_info_set_port")
  SYM(port_info_get_port, "snd_seq_port_info_get_port")
  SYM(port_info_get_capability, "snd_seq_port_info_get_capability")
  SYM(port_info_get_name, "snd_seq_port_info_get_name")
  SYM(query_next_port, "snd_seq_query_next_port")
  SYM(midi_event_new, "snd_midi_event_new")
  SYM(midi_event_free, "snd_midi_event_free")
  SYM(midi_event_no_status, "snd_midi_event_no_status")
  SYM(midi_event_decode, "snd_midi_event_decode")
#undef SYM
  S.lib = lib;
  return 1;
}

#define CAP_READ (1u << 0)
#define CAP_SUBS_READ (1u << 5)
#define CAP_NO_EXPORT (1u << 7)

/* Every port that sends MIDI (but the system's and our own), subscribed; gone ones let go. */
static void seq_scan(void) {
  int me = S.client_id(seq);
  snd_seq_client_info_t *ci;
  snd_seq_port_info_t *pi;
  S.client_info_malloc(&ci);
  S.port_info_malloc(&pi);
  lock_take(&ports_lock);
  for (int i = 0; i < MAXPORTS; i++) P[i].seen = 0;
  S.client_info_set_client(ci, -1);
  while (S.query_next_client(seq, ci) >= 0) {
    int client = S.client_info_get_client(ci);
    if (client == 0 || client == me) continue;
    S.port_info_set_client(pi, client);
    S.port_info_set_port(pi, -1);
    while (S.query_next_port(seq, pi) >= 0) {
      unsigned caps = S.port_info_get_capability(pi);
      if ((caps & (CAP_READ | CAP_SUBS_READ)) != (CAP_READ | CAP_SUBS_READ) || (caps & CAP_NO_EXPORT)) continue;
      int port = S.port_info_get_port(pi);
      const char *name = S.port_info_get_name(pi);
      char key[320];
      snprintf(key, sizeof key, "%s/%s", S.client_info_get_name(ci), name);
      int s = slot_for(key);
      if (s < 0) continue;
      mport *p = &P[s];
      p->seen = 1;
      snprintf(p->name, sizeof p->name, "%s", name);
      if (p->open && (p->client != client || p->port != port)) {
        S.disconnect_from(seq, seq_port, p->client, p->port);
        p->open = 0;
      }
      if (!p->open && S.connect_from(seq, seq_port, client, port) >= 0) {
        p->client = client;
        p->port = port;
        p->open = 1;
      }
    }
  }
  for (int i = 0; i < MAXPORTS; i++)
    if (P[i].used && !P[i].seen) {
      if (P[i].open) S.disconnect_from(seq, seq_port, P[i].client, P[i].port);
      P[i].used = 0;
    }
  publish();
  lock_give(&ports_lock);
  S.port_info_free(pi);
  S.client_info_free(ci);
}

static void *seq_main(void *arg) {
  (void)arg;
  snd_midi_event_t *dec = NULL;
  S.midi_event_new(16, &dec);
  S.midi_event_no_status(dec, 1);
  struct pollfd fds[4];
  int nfds = S.poll_descriptors(seq, fds, 4, POLLIN);
  double last_scan = 0;
  while (midi_running) {
    double now = now_us();
    if (atomic_exchange(&seq_rescan, 0) || now - last_scan > 1e6) {
      seq_scan();
      last_scan = now;
    }
    if (poll(fds, (nfds_t)nfds, 100) <= 0) continue;
    seq_event *ev = NULL;
    while (S.event_input(seq, &ev) >= 0 && ev) {
      unsigned char buf[16];
      long n = S.midi_event_decode(dec, buf, sizeof buf, ev);
      if (n >= 2 && buf[0] >= 0x80 && buf[0] < 0xf0) {
        int slot = -1;
        lock_take(&ports_lock);
        for (int i = 0; i < MAXPORTS; i++)
          if (P[i].used && P[i].open && P[i].client == ev->src_client && P[i].port == ev->src_port) slot = i;
        lock_give(&ports_lock);
        if (slot >= 0) midi_push(slot, (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) | (n > 2 ? (uint32_t)buf[2] << 16 : 0));
      }
      ev = NULL;
    }
  }
  S.midi_event_free(dec);
  return NULL;
}

static void midi_start_os(void) {
  if (seq || !alsa_load()) return;
  if (S.open(&seq, "default", 3 /* duplex */, 1 /* non-blocking */) < 0) {
    seq = NULL;
    return;
  }
  S.set_client_name(seq, "HO[LO] Engine");
  seq_port = S.create_simple_port(seq, "HO[LO] Engine in", (1u << 1) | (1u << 6), (1u << 1) | (1u << 20));
  seq_scan();
  pthread_create(&seq_thread, NULL, seq_main, NULL);
}

static void midi_scan_os(void) { atomic_store(&seq_rescan, 1); }
static void midi_rescan(void) { atomic_store(&seq_rescan, 1); }

static void midi_stop_os(void) {
  if (!seq) return;
  pthread_join(seq_thread, NULL);
  lock_take(&ports_lock);
  for (int i = 0; i < MAXPORTS; i++) P[i].used = 0;
  publish();
  lock_give(&ports_lock);
  S.close(seq);
  seq = NULL;
}

#endif

/* ---- Node-API helpers ---- */

static napi_value undef(napi_env env) {
  napi_value v;
  p_napi_get_undefined(env, &v);
  return v;
}
static napi_value num(napi_env env, double d) {
  napi_value v;
  p_napi_create_double(env, d, &v);
  return v;
}
static napi_value str(napi_env env, const char *s) {
  napi_value v;
  p_napi_create_string_utf8(env, s, (size_t)-1, &v);
  return v;
}
static napi_value jsbool(napi_env env, int b) {
  napi_value v;
  p_napi_get_boolean(env, b != 0, &v);
  return v;
}
static napi_value fail(napi_env env, const char *msg) {
  p_napi_throw_error(env, NULL, msg);
  return NULL;
}
static size_t args(napi_env env, napi_callback_info info, napi_value *argv, size_t max) {
  size_t n = max;
  p_napi_get_cb_info(env, info, &n, argv, NULL, NULL);
  return n;
}
static double arg_num(napi_env env, napi_value v, double fallback) {
  double d;
  return v && p_napi_get_value_double(env, v, &d) == 0 ? d : fallback;
}
static int opt_bool(napi_env env, napi_value obj, const char *key, int fallback) {
  napi_value v;
  bool b;
  if (!obj || p_napi_get_named_property(env, obj, key, &v) != 0) return fallback;
  return p_napi_get_value_bool(env, v, &b) == 0 ? b : fallback;
}
static void *typed(napi_env env, napi_value v, napi_typedarray_type want, size_t *length) {
  napi_typedarray_type type;
  void *data = NULL;
  napi_value ab;
  size_t off;
  if (!v || p_napi_get_typedarray_info(env, v, &type, length, &data, &ab, &off) != 0 || type != want) return NULL;
  return data;
}
static void set(napi_env env, napi_value obj, const char *key, napi_value v) {
  p_napi_set_named_property(env, obj, key, v);
}

/* ---- the calls ---- */

/* audioOpen({ exclusive, null }): the default output, at its own rate. */
static napi_value js_audio_open(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {NULL};
  args(env, info, argv, 1);
  int exclusive = opt_bool(env, argv[0], "exclusive", 0);
  int null_backend = opt_bool(env, argv[0], "null", 0);
  if (A.dev_ok) return fail(env, "The sound device is already open");
  if (A.ctx_ok && A.ctx_null != null_backend) {
    ma_context_uninit(&A.ctx);
    A.ctx_ok = 0;
  }
  if (!A.ctx_ok) {
    ma_context_config cc = ma_context_config_init();
    cc.threadPriority = ma_thread_priority_realtime;
    ma_backend nul[1] = {ma_backend_null};
    ma_result r = ma_context_init(null_backend ? nul : NULL, null_backend ? 1 : 0, &cc, &A.ctx);
    if (r != MA_SUCCESS) return fail(env, ma_result_description(r));
    A.ctx_ok = 1;
    A.ctx_null = null_backend;
  }
  ma_device_config dc = ma_device_config_init(ma_device_type_playback);
  dc.playback.format = ma_format_f32;
  dc.playback.channels = 2;
  dc.sampleRate = 0; /* the device's own */
  dc.dataCallback = on_audio;
  dc.notificationCallback = on_notification;
  dc.performanceProfile = ma_performance_profile_low_latency;
  dc.noFixedSizedCallback = MA_TRUE;
  dc.noPreSilencedOutputBuffer = MA_TRUE;
  dc.periodSizeInFrames = BLOCK;
  dc.periods = 2;
  dc.wasapi.usage = ma_wasapi_usage_pro_audio;
  dc.wasapi.noAutoConvertSRC = MA_TRUE;
  int bluetooth = 0;
#if defined(_WIN32)
  if (!null_backend) bluetooth = default_is_bluetooth(&A.ctx);
  if (exclusive && !null_backend && !bluetooth) {
    /* one buffer of the device's shortest period (ask for less and WASAPI doubles it) */
    dc.playback.shareMode = ma_share_mode_exclusive;
    uint32_t p = exclusive_period(&A.ctx);
    if (p) dc.periodSizeInFrames = p;
    dc.periods = 1;
  }
#else
  (void)exclusive; /* only WASAPI has an exclusive mode */
#endif
  atomic_store(&A.w, 0);
  atomic_store(&A.r, 0);
  atomic_store(&A.demand, 0);
  atomic_store(&A.cushion, 0);
  atomic_store(&A.alive, 0);
  atomic_store(&A.underruns, 0);
  atomic_store(&A.late, 0);
  atomic_store(&A.lost, 0);
  atomic_store(&default_changed, 0);
  atomic_store(&A.clock, 0.0);
  A.clock_set = 0;
  atomic_store(&Marks.head, 0);
  atomic_store(&Marks.tail, 0);
  atomic_store(&Lat.n, 0);
  ma_result r = ma_device_init(&A.ctx, &dc, &A.dev);
  if (r != MA_SUCCESS) return fail(env, ma_result_description(r));
  A.dev_ok = 1;
  A.rate = A.dev.sampleRate;
  A.period = A.dev.playback.internalPeriodSizeInFrames;
  A.buffer = A.period * (A.dev.playback.internalPeriods ? A.dev.playback.internalPeriods : 1);
#if defined(_WIN32)
  if (A.ctx.backend == ma_backend_wasapi && A.dev.wasapi.actualBufferSizeInFramesPlayback)
    A.buffer = A.dev.wasapi.actualBufferSizeInFramesPlayback;
  if (A.ctx.backend == ma_backend_wasapi) notifier_start(&A.ctx);
  timeBeginPeriod(1);
#endif
  double period_us = (double)A.period * 1e6 / A.rate;
  A.budget_us = period_us * 0.6 > 500 ? period_us * 0.6 : 500;
  A.buffer_us = (double)A.buffer * 1e6 / A.rate;
  r = ma_device_start(&A.dev);
  if (r != MA_SUCCESS) {
    ma_device_uninit(&A.dev);
    A.dev_ok = 0;
    return fail(env, ma_result_description(r));
  }
  napi_value out;
  p_napi_create_object(env, &out);
  set(env, out, "rate", num(env, A.rate));
  set(env, out, "period", num(env, A.period));
  set(env, out, "buffer", num(env, A.buffer));
  set(env, out, "exclusive", jsbool(env, A.dev.playback.shareMode == ma_share_mode_exclusive));
  set(env, out, "backend", str(env, ma_get_backend_name(A.ctx.backend)));
  set(env, out, "name", str(env, A.dev.playback.name));
  set(env, out, "bluetooth", jsbool(env, bluetooth));
  return out;
}

static napi_value js_audio_close(napi_env env, napi_callback_info info) {
  (void)info;
  atomic_store(&Ms.on, 0);
  atomic_store(&In.recording, 0);
  capture_close(IN_TRACKS | IN_MEASURE);
  if (A.dev_ok) {
    A.dev_ok = 0;
    ma_device_uninit(&A.dev);
#if defined(_WIN32)
    timeEndPeriod(1);
#endif
  }
  ev_set(&A.render_ev);
  return undef(env);
}

static uint32_t render_want(void) {
  uint32_t fill = ring_fill();
  uint32_t d = atomic_load(&A.demand), c = atomic_load(&A.cushion);
  uint32_t target = d > c ? d : c;
  return target > fill ? target - fill : 0;
}

/* renderWait(ms): frames to render now (0 when the time ran out first). */
static napi_value js_render_wait(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {NULL};
  args(env, info, argv, 1);
  uint32_t want = render_want();
  if (!want && A.dev_ok) {
    ev_wait(&A.render_ev, arg_num(env, argv[0], 5) * 1000.0);
    want = render_want();
  }
  return num(env, want);
}

/* renderWrite(left, right): one block, after the last. */
static napi_value js_render_write(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {NULL, NULL};
  args(env, info, argv, 2);
  size_t nl = 0, nr = 0;
  float *l = typed(env, argv[0], napi_float32_array, &nl);
  float *r = typed(env, argv[1], napi_float32_array, &nr);
  if (!l || !r || nl != nr) return fail(env, "renderWrite takes two Float32Arrays of one length");
  uint64_t w = atomic_load(&A.w);
  if (w - atomic_load(&A.r) + nl > RING_FRAMES) return jsbool(env, 0);
  for (size_t i = 0; i < nl; i++) {
    uint32_t at = (uint32_t)((w + i) & (RING_FRAMES - 1)) * 2;
    A.ring[at] = l[i];
    A.ring[at + 1] = r[i];
  }
  atomic_store(&A.w, w + nl);
  atomic_store(&A.alive, 1);
  ev_set(&A.ready_ev);
  return jsbool(env, 1);
}

/*
 * audioStatus(out): [frames ready, underruns, the device's clock (the frame it takes at time 0: it
 * takes frame clock + t·rate at t µs), 1 once that clock is running, lost (the device went away),
 * now (µs), late callbacks, the frames a callback waits for, 1 when the system's default output has
 * changed under an exclusive stream].
 */
static napi_value js_audio_status(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {NULL};
  args(env, info, argv, 1);
  size_t n = 0;
  double *out = typed(env, argv[0], napi_float64_array, &n);
  if (!out || n < 9) return fail(env, "audioStatus takes a Float64Array(9)");
  out[0] = ring_fill();
  out[1] = (double)atomic_load(&A.underruns);
  out[2] = atomic_load(&A.clock);
  out[3] = A.clock_set;
  out[4] = atomic_load(&A.lost);
  out[5] = now_us();
  out[6] = (double)atomic_load(&A.late);
  out[7] = atomic_load(&A.demand);
  out[8] = atomic_load(&default_changed);
  return undef(env);
}

static napi_value js_set_cushion(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {NULL};
  args(env, info, argv, 1);
  double c = arg_num(env, argv[0], 0);
  atomic_store(&A.cushion, (unsigned)(c < 0 ? 0 : c > RING_FRAMES / 2 ? RING_FRAMES / 2 : c));
  return undef(env);
}

/* noteMark(frame, arrived µs): a note played live, rendered at that frame. */
static napi_value js_note_mark(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {NULL, NULL};
  args(env, info, argv, 2);
  unsigned head = atomic_load(&Marks.head);
  if (head - atomic_load(&Marks.tail) >= MARKS) return undef(env);
  Marks.frame[head % MARKS] = (uint64_t)arg_num(env, argv[0], 0);
  Marks.t[head % MARKS] = arg_num(env, argv[1], 0);
  atomic_store(&Marks.head, head + 1);
  return undef(env);
}

/* noteLatencies(out): the last notes' time from the cable to the speakers, µs; returns how many. */
static napi_value js_note_latencies(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {NULL};
  args(env, info, argv, 1);
  size_t n = 0;
  double *out = typed(env, argv[0], napi_float64_array, &n);
  if (!out) return fail(env, "noteLatencies takes a Float64Array");
  unsigned total = atomic_load(&Lat.n);
  unsigned count = total < LATENCIES ? total : LATENCIES;
  if (count > n) count = (unsigned)n;
  for (unsigned i = 0; i < count; i++) out[i] = Lat.us[(total - 1 - i) % LATENCIES];
  return num(env, count);
}

/* The default input, opened for a user (audio tracks, measuring) if it isn't open yet. */
static const char *capture_open(int user) {
  if (!A.dev_ok) return "The sound device isn't open";
  if (In.ok) {
    In.users |= user;
    return NULL;
  }
  ma_device_config dc = ma_device_config_init(ma_device_type_capture);
  dc.capture.format = ma_format_f32;
  dc.capture.channels = 2; /* a mono microphone comes in on both */
  dc.sampleRate = A.rate;  /* the engine's: miniaudio converts if the input's own differs */
  dc.dataCallback = on_capture;
  dc.performanceProfile = ma_performance_profile_low_latency;
  dc.noFixedSizedCallback = MA_TRUE;
  dc.periodSizeInFrames = BLOCK;
  dc.wasapi.usage = ma_wasapi_usage_pro_audio;
  ma_result r = ma_device_init(&A.ctx, &dc, &In.dev);
  if (r != MA_SUCCESS) return ma_result_description(r);
  In.buffer = In.dev.capture.internalPeriodSizeInFrames * In.dev.capture.internalPeriods;
  atomic_store(&In.w, 0);
  atomic_store(&In.r, 0);
  r = ma_device_start(&In.dev);
  if (r != MA_SUCCESS) {
    ma_device_uninit(&In.dev);
    return ma_result_description(r);
  }
  In.ok = 1;
  In.users = user;
  return NULL;
}

static void capture_close(int user) {
  In.users &= ~user;
  if (In.users || !In.ok) return;
  ma_device_uninit(&In.dev);
  In.ok = 0;
}

/* inputOpen(): the default input for audio tracks. */
static napi_value js_input_open(napi_env env, napi_callback_info info) {
  (void)info;
  const char *err = capture_open(IN_TRACKS);
  if (err) return fail(env, err);
  atomic_store(&In.r, atomic_load(&In.w));
  atomic_store(&In.recording, 1);
  return undef(env);
}

static napi_value js_input_close(napi_env env, napi_callback_info info) {
  (void)info;
  atomic_store(&In.recording, 0);
  capture_close(IN_TRACKS);
  return undef(env);
}

/*
 * inputRead(left, right): the next block of input, true when there was one (else the block is
 * silence). More than a few blocks waiting means the input ran ahead: it's caught up, so what's
 * recorded keeps a steady delay.
 */
static napi_value js_input_read(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {NULL, NULL};
  args(env, info, argv, 2);
  size_t nl = 0, nr = 0;
  float *l = typed(env, argv[0], napi_float32_array, &nl);
  float *rr = typed(env, argv[1], napi_float32_array, &nr);
  if (!l || !rr || nl != nr) return fail(env, "inputRead takes two Float32Arrays of one length");
  uint64_t w = atomic_load(&In.w);
  uint64_t r = atomic_load(&In.r);
  uint64_t keep = nl + In.buffer + BLOCK;
  if (w - r > keep) r = w - keep;
  if (w - r < nl) {
    memset(l, 0, nl * sizeof(float));
    memset(rr, 0, nr * sizeof(float));
    atomic_store(&In.r, r);
    return jsbool(env, 0);
  }
  for (size_t i = 0; i < nl; i++) {
    uint32_t at = (uint32_t)((r + i) & (IN_FRAMES - 1)) * 2;
    l[i] = In.ring[at];
    rr[i] = In.ring[at + 1];
  }
  atomic_store(&In.r, r + nl);
  return jsbool(env, 1);
}

/* measureStart(): clicks instead of the engine's sound, and the default input listening. */
static napi_value js_measure_start(napi_env env, napi_callback_info info) {
  (void)info;
  Ms.frame = 0;
  Ms.click_at = 0;
  Ms.noise = 0;
  atomic_store(&Ms.click_us, 0.0);
  atomic_store(&Ms.armed, 0);
  atomic_store(&Ms.count, 0);
  const char *err = capture_open(IN_MEASURE);
  if (err) return fail(env, err);
  atomic_store(&Ms.on, 1);
  return undef(env);
}

/* measureStop(): { times: [ms…] each click took to be heard, input: the input's buffer in ms }. */
static napi_value js_measure_stop(napi_env env, napi_callback_info info) {
  (void)info;
  atomic_store(&Ms.on, 0);
  napi_value out, list;
  p_napi_create_object(env, &out);
  int c = atomic_load(&Ms.count);
  p_napi_create_array_with_length(env, (size_t)c, &list);
  for (int i = 0; i < c; i++) p_napi_set_element(env, list, (uint32_t)i, num(env, Ms.rt[i]));
  set(env, out, "times", list);
  set(env, out, "input", num(env, In.ok && A.rate ? (double)In.buffer * 1000.0 / A.rate : 0));
  capture_close(IN_MEASURE);
  return out;
}

/* boost(): the calling thread (the worker that renders) as close to the audio thread's priority as the OS allows. */
static napi_value js_boost(napi_env env, napi_callback_info info) {
  (void)info;
#if defined(_WIN32)
  /* Windows may run a background app's threads slowly to save power (EcoQoS), and coarsen its timers: not this one's */
  typedef BOOL(WINAPI * set_info_fn)(HANDLE, int, LPVOID, DWORD);
  set_info_fn set_info = (set_info_fn)(void *)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "SetProcessInformation");
  if (set_info) {
    struct {
      ULONG version, control, state;
    } throttle = {1, 0x1 | 0x4, 0}; /* execution speed and timer resolution: never throttled */
    set_info(GetCurrentProcess(), 4 /* ProcessPowerThrottling */, &throttle, sizeof throttle);
  }
  DWORD task = 0;
  HANDLE h = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  if (h) {
    AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH);
    return str(env, "MMCSS Pro Audio");
  }
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
  return str(env, "time critical");
#elif defined(__APPLE__)
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
  return str(env, "user interactive");
#else
  struct sched_param sp;
  sp.sched_priority = sched_get_priority_min(SCHED_FIFO) + 10;
  if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp) == 0) return str(env, "SCHED_FIFO");
  return str(env, "normal");
#endif
}

static napi_value js_now(napi_env env, napi_callback_info info) {
  (void)info;
  return num(env, now_us());
}

static napi_value js_midi_open(napi_env env, napi_callback_info info) {
  (void)info;
  if (!midi_running) {
    midi_running = 1;
    midi_start_os();
  }
  return undef(env);
}

static napi_value js_midi_close(napi_env env, napi_callback_info info) {
  (void)info;
  if (midi_running) {
    midi_running = 0;
    midi_stop_os();
  }
  lock_take(&Q.lock);
  Q.tail = Q.head;
  lock_give(&Q.lock);
  return undef(env);
}

/*
 * midiScan(): [{ slot, name, open }] for every MIDI input there is, as the MIDI thread last found
 * them (it opens new ones as they come, once a second).
 */
static napi_value js_midi_scan(napi_env env, napi_callback_info info) {
  (void)info;
  if (!midi_running) return fail(env, "MIDI isn't open");
#if defined(__linux__)
  midi_rescan();
#endif
  static int count;
  static struct {
    int slot, open;
    char name[256];
  } copy[MAXPORTS];
  lock_take(&snap_lock);
  count = Snap.count;
  memcpy(copy, Snap.p, sizeof copy);
  lock_give(&snap_lock);
  napi_value list;
  p_napi_create_array_with_length(env, (size_t)count, &list);
  for (int i = 0; i < count; i++) {
    napi_value o;
    p_napi_create_object(env, &o);
    set(env, o, "slot", num(env, copy[i].slot));
    set(env, o, "name", str(env, copy[i].name));
    set(env, o, "open", jsbool(env, copy[i].open));
    p_napi_set_element(env, list, (uint32_t)i, o);
  }
  return list;
}

/* midiRead(out): [slot, status | d1 << 8 | d2 << 16, arrived µs] each; returns how many. */
static napi_value js_midi_read(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {NULL};
  args(env, info, argv, 1);
  size_t n = 0;
  double *out = typed(env, argv[0], napi_float64_array, &n);
  if (!out) return fail(env, "midiRead takes a Float64Array");
  uint32_t count = 0;
  lock_take(&Q.lock);
  while (Q.tail != Q.head && (count + 1) * 3 <= n) {
    uint32_t i = Q.tail % MIDIQ;
    out[count * 3] = Q.q[i].slot;
    out[count * 3 + 1] = Q.q[i].word;
    out[count * 3 + 2] = Q.q[i].t;
    Q.tail++;
    count++;
  }
  lock_give(&Q.lock);
  return num(env, count);
}

/* ---- the module ---- */

/*
 * The thread that loaded us is going (a worker terminated, the app quitting): the device and MIDI
 * stop with it, so no audio or MIDI thread is left running into code being torn down.
 */
static void cleanup(void *arg) {
  (void)arg;
  atomic_store(&Ms.on, 0);
  atomic_store(&In.recording, 0);
  capture_close(IN_TRACKS | IN_MEASURE);
  if (A.dev_ok) {
    A.dev_ok = 0;
    ma_device_uninit(&A.dev);
#if defined(_WIN32)
    timeEndPeriod(1);
#endif
  }
  if (midi_running) {
    midi_running = 0;
    midi_stop_os();
  }
#if defined(_WIN32)
  notifier_stop();
#endif
  if (A.ctx_ok) {
    ma_context_uninit(&A.ctx);
    A.ctx_ok = 0;
  }
}

static void define(napi_env env, napi_value exports, const char *name, napi_callback fn) {
  napi_value f;
  p_napi_create_function(env, name, (size_t)-1, fn, NULL, &f);
  p_napi_set_named_property(env, exports, name, f);
}

static int ready;

HOLO_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
#define HOLO_LOAD(ret, name, params)                \
  p_##name = (name##_fn)find_napi(#name); \
  if (!p_##name) return NULL;
  HOLO_NAPI_CALLS(HOLO_LOAD)
#undef HOLO_LOAD
  if (!ready) {
    ready = 1;
#if defined(_WIN32)
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    qpc_to_us = 1e6 / (double)f.QuadPart;
#elif defined(__APPLE__)
    mach_timebase_info_data_t tb;
    mach_timebase_info(&tb);
    mach_to_us = (double)tb.numer / (double)tb.denom / 1000.0;
#endif
    ev_init(&A.render_ev);
    ev_init(&A.ready_ev);
  }
  p_napi_add_env_cleanup_hook(env, cleanup, NULL);
  define(env, exports, "audioOpen", js_audio_open);
  define(env, exports, "audioClose", js_audio_close);
  define(env, exports, "renderWait", js_render_wait);
  define(env, exports, "renderWrite", js_render_write);
  define(env, exports, "audioStatus", js_audio_status);
  define(env, exports, "setCushion", js_set_cushion);
  define(env, exports, "noteMark", js_note_mark);
  define(env, exports, "noteLatencies", js_note_latencies);
  define(env, exports, "inputOpen", js_input_open);
  define(env, exports, "inputClose", js_input_close);
  define(env, exports, "inputRead", js_input_read);
  define(env, exports, "measureStart", js_measure_start);
  define(env, exports, "measureStop", js_measure_stop);
  define(env, exports, "boost", js_boost);
  define(env, exports, "now", js_now);
  define(env, exports, "midiOpen", js_midi_open);
  define(env, exports, "midiClose", js_midi_close);
  define(env, exports, "midiScan", js_midi_scan);
  define(env, exports, "midiRead", js_midi_read);
  return exports;
}

HOLO_EXPORT int32_t node_api_module_get_api_version_v1(void) { return 8; }
