# modbridge: run ns2jb-modloader 0.3.5 unchanged on the CivSwitchFS + modified kaiHEN boot

ML = ns2jb-modloader 0.3.5 ModLoader folder, EN = civ7-fs-kaihen/engine (commit 51a804c), RUN = fake run dir, S = basename(RUN).
Run as: `node load.cjs --run-dir RUN --keep-rpc` (skips ML's RO handoff: never replace/terminate kaiHEN's RO). Fresh S per attempt (ML/state/S must not exist).

## Pieces
1. kaiHEN RO (kaihen/patches), ro:dmnt helper commands must match EN ro/payload/process.c + main.c:
   - accept requests WITH send_pid (ML sends pid:true); copy handle = FS process; recv buffer only for bulk read.
   - reply with HIPC special header send_pid=1 (kernel inserts RO's PID; ML checks reply pid == Client.pid).
   - 0x524f0016 with send_pid = helper bulk read (<=2 MiB used, reply [4]=[5]=0,[6]=len); without send_pid = kaiHEN's own read (HEN).
   - extra for the bridge (FS only): 0x26 bulk read of ANY mapped FS page type (heap reads); 0x28 write: compare expected, write, verify readback (FS heap writes; ML memory.writeBytes up to 64 KiB, chunk it).
2. Console app modbridge.nro (hbmenu): TCP server, binary ops: HELLO (handles: ro:dmnt, FS process, FS root clone; FS pid), ALLOC/MEM_READ/MEM_WRITE (scratch >= 0x210000, page aligned, in app memory), SEND(h, addr, size) = svcSendSyncRequestWithUserBuffer, CLOSE(h), FS_READ(addr,len), FS_WRITE(addr, expected, new).
3. PC shim (Node): generates RUN with:
   - result.json {verified:true, rpc:{state:'listening'}} (no completed)
   - switch2/fs-execution-current.json {verified:true, file} -> proof {verified, session:S, identity{pid, programId:'0400000000000000'}, mapping.memory.address = FS .text base, notifier{object:E, backend:B, handle}}
   - switch2/ro/S-notifier-proof.json {identityVerified:true, E, B} (numbers); ML checks *(E+8)==B, u32 *(E+0x10)==1
   - switch2/ro/S-layout.json {table, count}: FS CMIF domain-entry table (0x30 stride, object ptr at +0x20)
   - switch2/current-acquisition.json {socketPath}: named pipe served by shim daemon; newline JSON request per connection, JSON reply then close; commands 'root-native-info' -> {session, worker:{joined:true}, notifiers:[notifierHandle], services:[]}, 'info'
   - switch2/ro/root/current-root.json {rootHandle}
   - modules: switch2/process/client.cjs {Client} (fake: handle=ro:dmnt, pid=RO pid, fsProcess(), memory=Memory(FS_READ,FS_WRITE), record/save/pending, close() keeps bridge handles), switch2/app/session.cjs {Session, live, u32, u64, check} (fake over bridge: base/bytes/write/read/readOwned/ipc/openService/close/cleanup/record, call('send',base,4096,h)), plus EN copies unchanged: shared/ipc.cjs, shared/domain.cjs, switch2/app/domain.cjs, switch2/app/filesystem.cjs, switch2/app/hash-code.json
   - discovery (port EN ro/objects.cjs:8-99, layout.cjs:19-35 on the fake session): notifier = fsp-srv cmd 510 on initialized non-domain root; vptr = qword in FS image == FSbase+0x1201b0, minus 0x20; heap scan for vptr with u32 +0x10 == 1, confirm by clone (refcount 2); domain table via ConvertToDomain on a clone.
## ML install sequence (for debugging)
capture (0x10, 0x16 of FS text, 0x10 on .data +0x11e12d0/+0x11ee960) -> Bridge.open (heap reads E+8/E+0x10, root-native-info, FS+0x1201b0 16 B, caves FS+0x24d100 1 KiB/+0x24d800 256 B, 0x15 cave page R-X) -> openSource (clone root, OpenSdCardFileSystem 18, domain id/table) -> native calls: hook FS+0x1201b0 with b cave (0x14), send cmd 0 on notifier -> reply 0x6dfe, read result, restore B at E+8, unhook -> allocations FS+0x694c0 / FS+0x215620(mgr FS+0x11ee960) -> heap writes, 0x12 code pages, publish -> inventory, SD report, resident: lfs_initialize, gateway at 0x24d100 + 0x14 hooks (permanent), lfs_activate.
