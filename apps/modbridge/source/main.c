// modbridge: lets ns2jb-modloader's PC installer drive FS through the modified kaiHEN
// (switch2-scripts mods-ro). TCP server on port 5501, one client at a time.
// Frame: request  u32 op, u32 len, payload[len]
//        response u32 status (0 = ok, else a Result), u32 len, payload[len]
// See DESIGN.md. Scratch memory and handles belong to this app's process; the PC
// builds CMIF messages in scratch and asks us to send them.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <switch.h>
#include <kaihen.h>

#define PORT 5501
#define HEN_GET_FS_PROCESS 64
#define HELPER_QUERY 0x524f0010
#define HELPER_READ 0x524f0026
#define HELPER_WRITE 0x524f0028
#define MAX_SCRATCH 8
#define MAX_PAYLOAD 0x500000

enum {
    OpHello = 1,      // -> u32 ro:dmnt, u32 FS process, u32 FS root, u32 0, u64 FS pid
    OpAlloc = 2,      // u64 size -> u64 address (page aligned, zeroed)
    OpFree = 3,       // u64 address
    OpMemRead = 4,    // u64 address, u64 length -> bytes (scratch only)
    OpMemWrite = 5,   // u64 address, bytes (scratch only)
    OpSend = 6,       // u32 handle, u32 0, u64 address, u64 size -> u32 transport result
    OpClose = 7,      // u32 handle -> u32 result
    OpFsRead = 8,     // u64 address, u64 length -> bytes
    OpFsWrite = 9,    // u64 address, u64 length, expected[length], replacement[length]
    OpFsQuery = 10,   // u64 address -> u64 addr, size, u32 type, attr, perm, 0
};

static FILE* g_log;
static void out(const char* fmt, ...) {
    va_list a;
    va_start(a, fmt);
    vprintf(fmt, a);
    va_end(a);
    if (g_log) {
        va_start(a, fmt);
        vfprintf(g_log, fmt, a);
        va_end(a);
        fflush(g_log);
    }
    consoleUpdate(NULL);
}

typedef struct { u64 v[4]; } In32;
typedef struct { u64 v[13]; } QueryOut;
typedef struct { u64 v[8]; } Out64;
typedef struct { u64 v[10]; } Out80;

static Service g_hen, g_dmnt;
static Handle g_fs = INVALID_HANDLE, g_root = INVALID_HANDLE;
static u64 g_fs_pid;
static struct { u64 address, size; } g_scratch[MAX_SCRATCH];
static u8* g_io;

static Result fsQuery(u64 address, QueryOut* q) {
    In32 in = {{0, address, 0, 0}};
    return serviceDispatchInOut(&g_dmnt, HELPER_QUERY, in, *q, .in_num_handles = 1, .in_handles = {g_fs});
}

/// Reads FS memory block by block (the RO command stays inside one memory block).
static Result fsRead(u64 address, u8* buffer, u64 length) {
    while (length) {
        QueryOut q = {};
        Result rc = fsQuery(address, &q);
        if (R_FAILED(rc)) return rc;
        const u64 end = q.v[4] + q.v[5];
        u64 n = end - address < length ? end - address : length;
        if (n > 0x400000) n = 0x400000;
        Out64 r = {};
        In32 in = {{g_fs_pid, address, n, 0}};
        rc = serviceDispatchInOut(&g_dmnt, HELPER_READ, in, r,
            .buffer_attrs = {SfBufferAttr_HipcMapAlias | SfBufferAttr_Out}, .buffers = {{buffer, n}},
            .in_num_handles = 1, .in_handles = {g_fs});
        if (R_FAILED(rc)) return rc;
        address += n; buffer += n; length -= n;
    }
    return 0;
}

static Result fsWrite(u64 address, const u8* expected, const u8* replacement, u64 length) {
    static u8 pair[0x20000];
    while (length) {
        QueryOut q = {};
        Result rc = fsQuery(address, &q);
        if (R_FAILED(rc)) return rc;
        const u64 end = q.v[4] + q.v[5];
        u64 n = end - address < length ? end - address : length;
        if (n > 0x10000) n = 0x10000;
        memcpy(pair, expected, n);
        memcpy(pair + n, replacement, n);
        Out80 r = {};
        In32 in = {{g_fs_pid, address, n, 0}};
        rc = serviceDispatchInOut(&g_dmnt, HELPER_WRITE, in, r,
            .buffer_attrs = {SfBufferAttr_HipcMapAlias | SfBufferAttr_In}, .buffers = {{pair, 2 * n}},
            .in_num_handles = 1, .in_handles = {g_fs});
        if (R_FAILED(rc)) return rc;
        address += n; expected += n; replacement += n; length -= n;
    }
    return 0;
}

static bool inScratch(u64 address, u64 length) {
    for (int i = 0; i < MAX_SCRATCH; i++)
        if (g_scratch[i].address && address >= g_scratch[i].address && length <= g_scratch[i].size &&
            address - g_scratch[i].address <= g_scratch[i].size - length)
            return true;
    return false;
}

static Result openAll(void) {
    Service ro = {};
    Result rc = kaihenGetRoSession(&ro);
    if (R_SUCCEEDED(rc)) rc = kaihenOpenHomebrewSession(&ro, &g_hen);
    if (R_SUCCEEDED(rc))
        rc = serviceDispatch(&g_hen, HEN_GET_FS_PROCESS, .out_handle_attrs = {SfOutHandleAttr_HipcCopy},
                             .out_handles = &g_fs);
    if (R_SUCCEEDED(rc)) rc = henGetFilesystemRoot(&g_hen, &g_root);
    Handle sm_handle = INVALID_HANDLE, dmnt = INVALID_HANDLE;
    if (R_SUCCEEDED(rc)) rc = henGetServiceManager(&g_hen, &sm_handle);
    if (R_SUCCEEDED(rc)) {
        TipcService sm;
        tipcCreate(&sm, sm_handle);
        const SmServiceName name = smEncodeName("ro:dmnt");
        rc = tipcDispatchIn(&sm, 1, name, .out_handle_attrs = {SfOutHandleAttr_HipcMove}, .out_handles = &dmnt);
        tipcClose(&sm);
        if (R_SUCCEEDED(rc)) serviceCreate(&g_dmnt, dmnt);
    }
    QueryOut q = {};
    if (R_SUCCEEDED(rc)) rc = fsQuery(0, &q);
    if (R_SUCCEEDED(rc)) {
        g_fs_pid = q.v[0];
        if (q.v[1] != 0x0400000000000000ULL) rc = MAKERESULT(Module_Libnx, LibnxError_BadInput);
    }
    return rc;
}

static bool recvAll(int fd, void* buffer, size_t n) {
    u8* p = buffer;
    while (n) {
        const ssize_t got = recv(fd, p, n, 0);
        if (got <= 0) return false;
        p += got; n -= (size_t)got;
    }
    return true;
}

static bool sendAll(int fd, const void* buffer, size_t n) {
    const u8* p = buffer;
    while (n) {
        const ssize_t sent = send(fd, p, n, 0);
        if (sent <= 0) return false;
        p += sent; n -= (size_t)sent;
    }
    return true;
}

static bool reply(int fd, u32 status, const void* data, u32 len) {
    const u32 head[2] = {status, len};
    return sendAll(fd, head, sizeof(head)) && (!len || sendAll(fd, data, len));
}

/// Handles one request; false when the connection is gone.
static bool serve(int fd, u32* count) {
    u32 head[2];
    if (!recvAll(fd, head, sizeof(head))) return false;
    const u32 op = head[0], len = head[1];
    if (len > MAX_PAYLOAD || !recvAll(fd, g_io, len)) return false;
    const u8* in = g_io;
    u64 a = len >= 8 ? *(const u64*)in : 0, b = len >= 16 ? *(const u64*)(in + 8) : 0;
    (*count)++;
    switch (op) {
    case OpHello: {
        struct { u32 dmnt, fs, root, zero; u64 pid; } h = {g_dmnt.session, g_fs, g_root, 0, g_fs_pid};
        return reply(fd, 0, &h, sizeof(h));
    }
    case OpAlloc: {
        const u64 size = (a + 0xfff) & ~0xfffULL;
        for (int i = 0; i < MAX_SCRATCH; i++)
            if (!g_scratch[i].address) {
                void* p = aligned_alloc(0x1000, size);
                if (!p) break;
                memset(p, 0, size);
                g_scratch[i].address = (u64)p;
                g_scratch[i].size = size;
                return reply(fd, 0, &g_scratch[i].address, 8);
            }
        return reply(fd, MAKERESULT(Module_Libnx, LibnxError_OutOfMemory), NULL, 0);
    }
    case OpFree:
        for (int i = 0; i < MAX_SCRATCH; i++)
            if (g_scratch[i].address == a) {
                free((void*)a);
                g_scratch[i].address = g_scratch[i].size = 0;
                return reply(fd, 0, NULL, 0);
            }
        return reply(fd, MAKERESULT(Module_Libnx, LibnxError_BadInput), NULL, 0);
    case OpMemRead:
        if (len != 16 || b > MAX_PAYLOAD || !inScratch(a, b)) return reply(fd, MAKERESULT(Module_Libnx, LibnxError_BadInput), NULL, 0);
        return reply(fd, 0, (const void*)a, (u32)b);
    case OpMemWrite:
        if (len < 8 || !inScratch(a, len - 8)) return reply(fd, MAKERESULT(Module_Libnx, LibnxError_BadInput), NULL, 0);
        memcpy((void*)a, in + 8, len - 8);
        return reply(fd, 0, NULL, 0);
    case OpSend: {
        const u32 handle = *(const u32*)in;
        const u64 address = *(const u64*)(in + 8), size = *(const u64*)(in + 16);
        if (len != 24 || !inScratch(address, size) || (address | size) & 0xfff)
            return reply(fd, MAKERESULT(Module_Libnx, LibnxError_BadInput), NULL, 0);
        const u32 result = svcSendSyncRequestWithUserBuffer((void*)address, size, handle);
        return reply(fd, 0, &result, 4);
    }
    case OpClose: {
        const u32 result = svcCloseHandle(*(const u32*)in);
        return reply(fd, 0, &result, 4);
    }
    case OpFsRead: {
        if (len != 16 || !b || b > MAX_PAYLOAD) return reply(fd, MAKERESULT(Module_Libnx, LibnxError_BadInput), NULL, 0);
        static u8 data[MAX_PAYLOAD];
        const Result rc = fsRead(a, data, b);
        return reply(fd, rc, R_SUCCEEDED(rc) ? data : NULL, R_SUCCEEDED(rc) ? (u32)b : 0);
    }
    case OpFsWrite:
        if (len < 16 || b > 0x200000 || len != 16 + 2 * b) return reply(fd, MAKERESULT(Module_Libnx, LibnxError_BadInput), NULL, 0);
        return reply(fd, fsWrite(a, in + 16, in + 16 + b, b), NULL, 0);
    case OpFsQuery: {
        QueryOut q = {};
        const Result rc = fsQuery(a, &q);
        struct { u64 addr, size; u32 type, attr, perm, zero; } m = {q.v[4], q.v[5], (u32)q.v[6], (u32)(q.v[6] >> 32), (u32)q.v[7], 0};
        return reply(fd, rc, &m, sizeof(m));
    }
    default:
        return reply(fd, MAKERESULT(Module_Libnx, LibnxError_NotFound), NULL, 0);
    }
}

int main(void) {
    consoleInit(NULL);
    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    PadState pad;
    padInitializeDefault(&pad);
    mkdir("sdmc:/switch/modbridge", 0777);
    g_log = fopen("sdmc:/switch/modbridge/log.txt", "a");
    out("modbridge 0.1   +: exit\n\n");
    g_io = malloc(MAX_PAYLOAD);
    Result rc = g_io ? openAll() : MAKERESULT(Module_Libnx, LibnxError_OutOfMemory);
    out("kaiHEN/ro:dmnt/FS: 0x%x  (FS pid %lu)\n", rc, g_fs_pid);
    if (R_SUCCEEDED(rc)) rc = socketInitializeDefault();
    int server = -1;
    if (R_SUCCEEDED(rc)) {
        server = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(PORT), .sin_addr = {INADDR_ANY}};
        const int on = 1;
        setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
        if (server < 0 || bind(server, (struct sockaddr*)&addr, sizeof(addr)) || listen(server, 1)) {
            out("socket setup failed\n");
            server = -1;
        } else {
            out("listening on port %d. Leave this open while the PC installs mods.\n", PORT);
        }
    }
    u32 count = 0;
    while (appletMainLoop()) {
        padUpdate(&pad);
        if (padGetButtonsDown(&pad) & HidNpadButton_Plus) break;
        if (server >= 0) {
            struct timeval tv = {0, 100000};
            fd_set set;
            FD_ZERO(&set);
            FD_SET(server, &set);
            if (select(server + 1, &set, NULL, NULL, &tv) > 0) {
                const int fd = accept(server, NULL, NULL);
                if (fd >= 0) {
                    out("PC connected\n");
                    while (serve(fd, &count)) {
                        if ((count & 0xff) == 0) out("  %u requests\n", count);
                    }
                    close(fd);
                    out("PC disconnected after %u requests\n", count);
                }
            }
        }
        consoleUpdate(NULL);
    }
    if (server >= 0) close(server);
    socketExit();
    // Handles the PC opened through us close with the process; keep the ones we own tidy.
    if (serviceIsActive(&g_dmnt)) serviceClose(&g_dmnt);
    if (g_root != INVALID_HANDLE) svcCloseHandle(g_root);
    if (g_fs != INVALID_HANDLE) svcCloseHandle(g_fs);
    if (serviceIsActive(&g_hen)) serviceClose(&g_hen);
    if (g_log) fclose(g_log);
    consoleExit(NULL);
    return 0;
}
