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
