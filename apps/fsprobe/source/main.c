// fsprobe: checks of the modified kaiHEN (switch2-scripts mods-ro branch).
//   A: read-only. HEN command 64 (FS process handle), ro:dmnt through HEN's SM
//      proxy, the ported ns2jb helper query/reads, and a capture of FS's code.
//   X: first FS write test. 16 bytes of zero padding at the end of FS's code
//      (never executed) are written, read back and restored, then 16 bytes of
//      live FS code are rewritten with their own bytes. Refuses any FS build but
//      the verified one (code size 0x24e000) and non-zero padding.
// Output: sdmc:/switch/fsprobe/ (log.txt, layout.txt, fs-*.bin).
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <switch.h>
#include <kaihen.h>

#define ROOT "sdmc:/switch/fsprobe"
#define HEN_GET_FS_PROCESS 64
#define HELPER_QUERY 0x524f0010
#define HELPER_SMALL_READ 0x524f0011
#define HELPER_PATCH16 0x524f0014
#define HELPER_BULK_READ 0x524f0026
#define KAIHEN_READ 0x524f0016
#define CHUNK 0x400000
#define MAX_BLOCKS 64
#define FS_TEXT_SIZE 0x24e000   // verified FS 23.0.1 build: 38/38 ns2jb-modloader fs-abi ranges
#define PAD_TEST_OFFSET 0x24df00 // inside FS text padding, outside the ranges the modloader uses

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
typedef struct { u64 v[8]; } In64;
typedef struct { u64 v[13]; } QueryOut;   // 104 bytes
typedef struct { u64 v[23]; } SmallOut;   // up to 56 + 128 bytes
typedef struct { u64 v[8]; } BulkOut;     // 64 bytes
typedef struct { u64 v[10]; } PatchOut;   // 80 bytes
typedef struct { u64 pid, address, size, reserved; } KaihenRead;
typedef struct { u64 addr, size; u32 type, perm; } Block;
typedef struct {
    Service hen, dmnt;
    Handle fs;
    u64 pid, program;
    Block blocks[MAX_BLOCKS];
    int n;
} Fs;

static Result query(Service* d, Handle fs, u64 address, QueryOut* r) {
    In32 in = {{0, address, 0, 0}};
    return serviceDispatchInOut(d, HELPER_QUERY, in, *r, .in_num_handles = 1, .in_handles = {fs});
}

static Result smallRead(Service* d, Handle fs, u64 pid, u64 address, u64 length, SmallOut* r) {
    In32 in = {{pid, address, length, 0}};
    // The reply is 56 + length bytes; request exactly that much.
    return serviceDispatchImpl(d, HELPER_SMALL_READ,
        &in, sizeof(in), r, 56 + length,
        (SfDispatchParams){.in_num_handles = 1, .in_handles = {fs}});
}

static Result patch16(Service* d, Handle fs, u64 pid, u64 address, const u8 expected[16], const u8 replacement[16],
                      PatchOut* r) {
    In64 in = {{pid, address, 16, 0}};
    memcpy(&in.v[4], expected, 16);
    memcpy(&in.v[6], replacement, 16);
    return serviceDispatchInOut(d, HELPER_PATCH16, in, *r, .in_num_handles = 1, .in_handles = {fs});
}

static Result kaihenRead(Service* d, Handle fs, u64 pid, u64 address, void* buf, u64 size) {
    KaihenRead in = {pid, address, size, 0};
    return serviceDispatchIn(d, KAIHEN_READ, in,
        .buffer_attrs = {SfBufferAttr_HipcMapAlias | SfBufferAttr_Out},
        .buffers = {{buf, size}},
        .in_num_handles = 1, .in_handles = {fs});
}

static Result bulkRead(Service* d, Handle fs, u64 pid, u64 address, void* buf, u64 size, BulkOut* r) {
    In32 in = {{pid, address, size, 0}};
    return serviceDispatchInOut(d, HELPER_BULK_READ, in, *r,
        .buffer_attrs = {SfBufferAttr_HipcMapAlias | SfBufferAttr_Out},
        .buffers = {{buf, size}},
        .in_num_handles = 1, .in_handles = {fs});
}

static Result openDmnt(Service* hen, Service* out_dmnt) {
    Handle sm_handle = INVALID_HANDLE, dmnt = INVALID_HANDLE;
    Result rc = henGetServiceManager(hen, &sm_handle);
    if (R_FAILED(rc)) return rc;
    TipcService sm;
    tipcCreate(&sm, sm_handle);
    const SmServiceName name = smEncodeName("ro:dmnt");
    rc = tipcDispatchIn(&sm, 1, name, .out_handle_attrs = {SfOutHandleAttr_HipcMove}, .out_handles = &dmnt);
    tipcClose(&sm);
    if (R_SUCCEEDED(rc)) serviceCreate(out_dmnt, dmnt);
    return rc;
}

static void closeFs(Fs* s) {
    if (serviceIsActive(&s->dmnt)) serviceClose(&s->dmnt);
    if (s->fs != INVALID_HANDLE) svcCloseHandle(s->fs);
    if (serviceIsActive(&s->hen)) serviceClose(&s->hen);
}

/// HEN, FS's handle, ro:dmnt and FS's code blocks; false (logged) on any failure.
static bool openFs(Fs* s) {
    memset(s, 0, sizeof(*s));
    s->fs = INVALID_HANDLE;
    Service ro = {};
    Result rc = kaihenGetRoSession(&ro);
    out("ldr:ro session: 0x%x\n", rc);
    if (R_SUCCEEDED(rc)) rc = kaihenOpenHomebrewSession(&ro, &s->hen);
    out("HEN homebrew session: 0x%x\n", rc);
    if (R_FAILED(rc)) return false;
    rc = serviceDispatch(&s->hen, HEN_GET_FS_PROCESS,
        .out_handle_attrs = {SfOutHandleAttr_HipcCopy}, .out_handles = &s->fs);
    out("HEN GetFilesystemProcess (64): 0x%x%s\n", rc,
        rc == 0xf601 || rc == 0x10601 ? "  <- stock HEN? copy the modified hen/main" : "");
    if (R_SUCCEEDED(rc)) rc = openDmnt(&s->hen, &s->dmnt);
    out("ro:dmnt via SM proxy: 0x%x\n", rc);
    if (R_FAILED(rc)) return false;

    FILE* layout = fopen(ROOT "/layout.txt", "w");
    u64 address = 0;
    for (int i = 0; i < 4096; i++) {
        QueryOut q = {};
        rc = query(&s->dmnt, s->fs, address, &q);
        if (R_FAILED(rc)) { out("query at 0x%lx: 0x%x  <- stock RO? copy the modified ro/main\n", address, rc); break; }
        s->pid = q.v[0]; s->program = q.v[1];
        const u64 addr = q.v[4], size = q.v[5];
        const u32 type = (u32)q.v[6], perm = (u32)q.v[7];
        if (layout && type) fprintf(layout, "0x%010lx +0x%08lx type %2u perm %u\n", addr, size, type, perm);
        if ((type == MemType_CodeStatic || type == MemType_CodeMutable) && s->n < MAX_BLOCKS)
            s->blocks[s->n++] = (Block){addr, size, type, perm};
        if (!size || addr + size <= address) break;
        address = addr + size;
    }
    if (layout) fclose(layout);
    out("FS pid %lu program %016lX, %d code block(s)\n", s->pid, s->program, s->n);
    return s->program == 0x0400000000000000ULL && s->n > 0;
}

static void capture(void) {
    Fs s;
    if (!openFs(&s)) { closeFs(&s); return; }
    for (int k = 0; k < s.n; k++)
        out("  0x%010lx +0x%08lx  %s  perm %u\n", s.blocks[k].addr, s.blocks[k].size,
            s.blocks[k].type == MemType_CodeStatic ? "static " : "mutable", s.blocks[k].perm);

    // The ported helper reads, cross-checked against kaiHEN's own read.
    SmallOut sm = {};
    Result rc = smallRead(&s.dmnt, s.fs, s.pid, s.blocks[0].addr, 16, &sm);
    out("helper small read (0x11) of first 16 bytes: 0x%x  %016lx %016lx\n", rc, sm.v[7], sm.v[8]);
    u8* buf = malloc(CHUNK);
    u8* check = malloc(0x1000);
    if (buf && check) {
        BulkOut b = {};
        Result r1 = kaihenRead(&s.dmnt, s.fs, s.pid, s.blocks[0].addr, buf, 0x1000);
        Result r2 = bulkRead(&s.dmnt, s.fs, s.pid, s.blocks[0].addr, check, 0x1000, &b);
        out("kaiHEN read 0x%x, helper bulk read (0x26) 0x%x, same bytes: %s\n", r1, r2,
            R_SUCCEEDED(r1) && R_SUCCEEDED(r2) && !memcmp(buf, check, 0x1000) ? "yes" : "NO");

        // Capture every code block to SD with kaiHEN's read.
        for (int k = 0; k < s.n; k++) {
            char path[128];
            snprintf(path, sizeof(path), ROOT "/fs-%010lx-t%u-p%u.bin", s.blocks[k].addr, s.blocks[k].type,
                     s.blocks[k].perm);
            FILE* f = fopen(path, "wb");
            if (!f) { out("cannot write %s\n", path); continue; }
            u64 done_bytes = 0;
            rc = 0;
            while (done_bytes < s.blocks[k].size && R_SUCCEEDED(rc)) {
                const u64 left = s.blocks[k].size - done_bytes, len = left < CHUNK ? left : CHUNK;
                rc = kaihenRead(&s.dmnt, s.fs, s.pid, s.blocks[k].addr + done_bytes, buf, len);
                if (R_SUCCEEDED(rc) && fwrite(buf, 1, len, f) != len) rc = MAKERESULT(Module_Libnx, LibnxError_IoError);
                done_bytes += len;
            }
            fclose(f);
            out("captured 0x%010lx (%lu bytes): 0x%x\n", s.blocks[k].addr, s.blocks[k].size, rc);
        }
    } else {
        out("out of memory\n");
    }
    free(buf);
    free(check);
    closeFs(&s);
}

static bool read16(Fs* s, u64 address, u8 bytes[16]) {
    SmallOut r = {};
    const Result rc = smallRead(&s->dmnt, s->fs, s->pid, address, 16, &r);
    if (R_SUCCEEDED(rc)) memcpy(bytes, &r.v[7], 16);
    return R_SUCCEEDED(rc);
}

static void printPatch(const char* what, Result rc, const PatchOut* p) {
    out("%s: 0x%x  map 0x%lx alias-perm 0x%lx expected-ok %lu readback-ok %lu unmap 0x%lx\n",
        what, rc, p->v[4], p->v[5], p->v[6], p->v[7], p->v[8]);
}

static void writeTest(void) {
    Fs s;
    if (!openFs(&s)) { closeFs(&s); return; }
    const Block* text = &s.blocks[0];
    if (text->type != MemType_CodeStatic || text->perm != Perm_X || text->size != FS_TEXT_SIZE) {
        out("FS code block is 0x%lx bytes perm %u, not the verified 0x%x/4: no writes.\n", text->size, text->perm,
            FS_TEXT_SIZE);
        closeFs(&s);
        return;
    }
    static const u8 zero[16] = {0};
    static const u8 pattern[16] = {0x1f, 0x20, 0x03, 0xd5, 0x1f, 0x20, 0x03, 0xd5,
                                   0x1f, 0x20, 0x03, 0xd5, 0x1f, 0x20, 0x03, 0xd5}; // 4x NOP
    u8 now[16];
    const u64 pad = text->addr + PAD_TEST_OFFSET;
    if (!read16(&s, pad, now) || memcmp(now, zero, 16)) {
        out("padding at 0x%lx is not readable zero bytes: no writes.\n", pad);
        closeFs(&s);
        return;
    }
    out("\n1) padding 0x%lx: write 4 NOPs, read back, restore zeros\n", pad);
    PatchOut p = {};
    Result rc = patch16(&s.dmnt, s.fs, s.pid, pad, zero, pattern, &p);
    printPatch("   write", rc, &p);
    const bool wrote = read16(&s, pad, now) && !memcmp(now, pattern, 16);
    out("   read back NOPs: %s\n", wrote ? "yes" : "NO");
    memset(&p, 0, sizeof(p));
    // Restore whatever is there now, so a partial write is undone too.
    const Result restore = patch16(&s.dmnt, s.fs, s.pid, pad, wrote ? pattern : now, zero, &p);
    printPatch("   restore", restore, &p);
    const bool restored = read16(&s, pad, now) && !memcmp(now, zero, 16);
    out("   padding back to zeros: %s\n", restored ? "yes" : "NO  <- reboot before anything else");
    if (R_FAILED(rc) || !wrote || !restored) {
        closeFs(&s);
        return;
    }

    out("\n2) live code 0x%lx: rewrite 16 bytes with their own bytes\n", text->addr);
    u8 live[16];
    if (!read16(&s, text->addr, live)) {
        out("   cannot read live code\n");
        closeFs(&s);
        return;
    }
    memset(&p, 0, sizeof(p));
    rc = patch16(&s.dmnt, s.fs, s.pid, text->addr, live, live, &p);
    printPatch("   identity patch", rc, &p);
    const bool same = read16(&s, text->addr, now) && !memcmp(now, live, 16);
    out("   live code unchanged: %s\n", same ? "yes" : "NO  <- reboot");
    out("\nWRITE TEST %s\n", R_SUCCEEDED(rc) && same ? "PASSED" : "FAILED");
    closeFs(&s);
}

int main(void) {
    consoleInit(NULL);
    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    PadState pad;
    padInitializeDefault(&pad);
    mkdir("sdmc:/switch", 0777);
    mkdir(ROOT, 0777);
    g_log = fopen(ROOT "/log.txt", "a");
    out("fsprobe 0.2\nA: read-only capture   X: FS write test   +: exit\n\n");
    while (appletMainLoop()) {
        padUpdate(&pad);
        const u64 k = padGetButtonsDown(&pad);
        if (k & HidNpadButton_Plus) break;
        if (k & HidNpadButton_A) { capture(); out("\nDone. Press + to exit.\n"); }
        if (k & HidNpadButton_X) { writeTest(); out("\nDone. Press + to exit.\n"); }
        consoleUpdate(NULL);
    }
    if (g_log) fclose(g_log);
    consoleExit(NULL);
    return 0;
}
