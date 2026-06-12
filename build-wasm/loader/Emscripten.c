// WASMFS filesystem glue + SDL3 flag-ABI shims for the single-threaded WASM build.
// Adapted from celeste-wasm loader/Emscripten.c, with the threaded bits
// (proxying/threading/thread-dump) removed — this build is single-threaded.
#include <emscripten/wasmfs.h>
#include <assert.h>
#include <stdio.h>
#include <unistd.h>
#include <stdint.h>

// --- OPFS + fetch filesystem mounts (called from managed CelesteBootstrap-style code) ---
int mount_opfs() {
	backend_t opfs = wasmfs_create_opfs_backend();
	int ret = wasmfs_create_directory("/libsdl", 0777, opfs);
	return ret;
}

// Sprint 11: mount /uo on the JS-file backend — file bytes live in
// JS-heap typed arrays OUTSIDE the wasm32 4GB address space, with fully
// synchronous read/write (no pthreads/asyncify, works on main thread
// and in workers alike). This is the heap-ceiling endgame: the ~1.6GB
// art set leaves the wasm heap. (The OPFS wasmfs backend was spiked
// first and is a dead end here: its real I/O requires pthread proxying
// — metadata ops half-work, the first data op kills the runtime.)
int mount_uo_jsstore() {
	backend_t js = wasmfs_create_js_file_backend();
	if (!js) return -1;
	return wasmfs_create_directory("/uo", 0777, js);
}

backend_t fetch_backend = NULL;

int mount_fetch(char *srcdir, char *dstdir) {
	if (!fetch_backend) fetch_backend = wasmfs_create_fetch_backend(srcdir);
	return wasmfs_create_directory(dstdir, 0777, fetch_backend);
}

int mount_fetch_file(char *path) {
	if (!fetch_backend) return -1;
	int ret = wasmfs_create_file(path, 0777, fetch_backend);
	if (ret >= 0)
		return close(ret);
	return ret;
}

// --- SDL3 flag-ABI shims ---
// FNA's P/Invoke surface still uses 32-bit window-flag ints in places; SDL3 widened
// the flags to uint64. These thunks bridge the ABI so FNA can drive SDL3 unchanged.
void *SDL_CreateWindow(char *title, int w, int h, uint64_t flags);
void *SDL__CreateWindow(char *title, int w, int h, unsigned int flags) {
	return SDL_CreateWindow(title, w, h, (uint64_t)flags);
}
uint64_t SDL_GetWindowFlags(void *window);
uint32_t SDL__GetWindowFlags(void *window) {
	return (uint32_t)SDL_GetWindowFlags(window);
}

// --- emscripten main-loop shims ---
// FNA declares these as DllImport("__Native"), which doesn't resolve as a static
// wasm lib. Expose them under named symbols (resolved like the SDL/zlib shims).
#include <emscripten.h>
// Declared in <emscripten/eventloop.h>; forward-declare to avoid header-path drift.
extern void emscripten_unwind_to_js_event_loop(void);
void wasm_set_main_loop(void (*func)(void), int fps, int simulate_infinite_loop) {
	emscripten_set_main_loop(func, fps, simulate_infinite_loop);
}
void wasm_cancel_main_loop(void) {
	emscripten_cancel_main_loop();
}
// Abandon the current C/.NET call stack and return to the JS event loop, keeping the
// wasm runtime alive (throws the emscripten "unwind" exception). FNA's emscripten path
// expects RunPlatformMainLoop to never return; single-threaded AOT can't register the
// per-frame reverse-pinvoke callback, so instead we unwind here and let JS drive frames
// via requestAnimationFrame -> ClassicUOLoader.TickFrame() on the still-alive game.
void wasm_unwind_to_js_event_loop(void) {
	emscripten_unwind_to_js_event_loop();
}

// --- zlib shim ---
// ClassicUO's native zlib P/Invoke (DllImport("zlib")) can't resolve a
// statically-linked lib in wasm, and its managed fallback throws "CRC mismatch"
// under the interpreter. libz.a IS linked into the bundle, so expose its
// uncompress() through a named shim (resolved like the SDL ones), with 32-bit
// length args to match wasm32's uLong.
extern int uncompress(unsigned char *dest, unsigned long *destLen,
                      const unsigned char *source, unsigned long sourceLen);
int wasm_uncompress(unsigned char *dest, int *destLen,
                    const unsigned char *source, int sourceLen) {
	unsigned long dl = (unsigned long)(*destLen);
	int ret = uncompress(dest, &dl, source, (unsigned long)sourceLen);
	*destLen = (int)dl;
	return ret;
}
