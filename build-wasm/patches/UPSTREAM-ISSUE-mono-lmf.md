# Draft upstream issue — dotnet/runtime (Mono interpreter / wasm)

**Status: DRAFT — not yet filed.** Post to https://github.com/dotnet/runtime/issues
once approved. Companion to `004-mono-interp-lmf-gc-fuse.patch` (our local
mitigation). Update this file with the issue URL after filing.

---

**Title:** [mono][wasm] Infinite loop in `interp_mark_no_ref_slots` during nursery GC — cyclic/dangling interpreter LMF chain (single-threaded browser-wasm, gsharedvt)

**Description:**

On single-threaded browser-wasm (`net10.0`, `LLVMOnlyInterp` — LLVM-AOT with
interpreter fallback), a long-running interpreter workload can permanently hard-freeze
inside a nursery (sgen) collection. The main thread spins forever in
`interp_mark_no_ref_slots` walking the interpreter LMF list.

**Root cause (as diagnosed):** the LMF chain becomes cyclic or dangles into reused
C-stack memory — a stale `previous_lmf` pointer left behind when gsharedvt makes
interp→C transitions — so the `while (lmf)` walk in `interp_mark_no_ref_slots`
(src/mono/mono/mini/interp/interp.c) never terminates. With only one thread, the page
wedges permanently; the rAF loop never runs again. Real chains are at most a few
hundred frames deep.

**Repro context:** a large game client (ClassicUO under FNA) compiled to
single-threaded browser-wasm; the freeze reproduces consistently within ~1,000
frames of mixed AOT/interp execution with sustained allocation (the nursery
collection that lands while an interpreter frame with a gsharedvt transition is on
the stack hangs). We can provide the full client + a captured Chrome performance
trace showing the wedge inside `collect_nursery → sgen_client_scan_thread_data →
interp_mark_stack → interp_mark_no_ref_slots`.

**Mitigation we ship (attached patch):** a bounded guard — break the LMF walk after
64K iterations (and a defensive bound on the inner `InterpFrame->parent` walk), with
throttled telemetry. Provably safe for this marking pass: `interp_mark_no_ref_slots`
only *marks* no-ref slots, so terminating early conservatively over-pins; it never
under-marks. With the guard in place the same workload runs for hours; the guard
trips exactly once per session ("trip #1") confirming the cycle still forms.

The proper fix is presumably LMF lifetime/unlinking correctness around gsharedvt
interp→C transitions on wasm, which is beyond what we can safely patch downstream.

**Attachments to include when filing:** `004-mono-interp-lmf-gc-fuse.patch`, the
perf-trace screenshot, runtime version details (`dotnet 10.0.x`, emsdk pin).
