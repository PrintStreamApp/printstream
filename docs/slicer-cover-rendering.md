# Slicer Cover Rendering (solved 2026-08)

How PrintStream-sliced `.gcode.3mf` files get real, filament-aware embedded cover images
(`Metadata/plate_N.png` + `_small`/`no_light`/`top`/`pick`) from BambuStudio's own renderer in
every headless runtime. Documents the May 2026 investigation that deferred this and the
August 2026 resolution that shipped it.

## The mechanism (why it never worked headless)

Read from the BambuStudio source (paths below are upstream-relative), the CLI's thumbnail path
fails on three independent layers, and all three had to be addressed:

1. **`glfwInit` needs Wayland, and only Wayland.** The bundled GLFW 3.3.7 is built with
   `GLFW_USE_WAYLAND=ON` (`deps/GLFW/GLFW.cmake`), which in GLFW 3.3.x is a *compile-time
   exclusive* platform choice. Xvfb/X11 can never satisfy it — the May attempts built on X11
   ("start from a full desktop-class X11 environment") were unwinnable from the start, and the
   one probe that got past `glfwInit` was the Weston one.
2. **The GL context is forced to OSMesa.** On `__linux__` the CLI hints
   `GLFW_CONTEXT_CREATION_API = GLFW_OSMESA_CONTEXT_API` (`BambuStudio.cpp`,
   `init_opengl_and_colors`), so GLFW dlopens `libOSMesa.so.8` and renders in pure software.
   The historical `OSMesa: Library not found` failures were this dlopen missing its library.
3. **The statically linked GLEW is a GLX build and can never initialise against an OSMesa
   context.** `glewInit()` → `glxewInit()` requires `glXGetCurrentDisplay() != NULL`, i.e. a
   *current GLX context* — which an OSMesa context never provides. This is the terminal
   `Unable to init glew library` / `init opengl failed! skip thumbnail generating` wall the May
   investigation died on. No package or display server fixes it; the binary's own GLEW/GLFW
   combination is self-contradictory headless. Additionally, with a glvnd `libGL` (any modern
   distro) the binary's direct GL 1.1 calls would dispatch through glvnd's "current context"
   (none) rather than the OSMesa context.

## The fix (three runtime pieces, owned by `bambu-studio-cli.sh`)

- **A private headless Weston** spawned per rendering invocation (`--slice`/`--export-png`
  only; unique socket + runtime dir, reaped on exit) satisfies `glfwInit`. Wayland is a
  socket protocol, so the arm64 image's native Weston serves the qemu-emulated x86-64
  client. It runs the **kiosk shell**, which still provides the xdg-shell GLFW needs but
  spawns none of desktop-shell's helper clients (`weston-keyboard`/`weston-desktop-shell`) —
  those would outlive weston as unreapable zombies under a non-reaping container PID 1.

- **`libosmesa6`** (native on amd64; in the x86-64 sysroot on arm64 — `build-x86-sysroot.mjs`)
  backs the software GL context.
- **`gl-osmesa-shim.so`** (`apps/slicer/docker/gl-osmesa-shim.c`, LD_PRELOAD, always x86-64)
  fakes the few GLX entry points `glxewInit` calls and routes all GL dispatch — GLEW's
  resolved pointers via an interposed `glXGetProcAddressARB`, plus the ~70 directly imported
  GL 1.1 symbols — through `OSMesaGetProcAddress`.

There is **no X server anywhere in the launch.** The CLI never initialises GTK in CLI mode
(verified: full slices, `--export-png`, and settings exports run with no `DISPLAY` at all,
matching the native app's launcher, which has always run the CLI bare). The Xvfb the wrapper
historically ran was based on the wrong "GL needs a display" premise and leaked one unreaped
Xvfb zombie per invocation through `xvfb-run`'s cleanup ordering.

With those in place the CLI's *normal slice flow* regenerates covers whenever its thumbnails
stage decides they are missing, and `--export-png <plate|0>` (a standalone action) renders
512x512 plate PNGs on demand. Verified end to end under qemu on arm64: a 2-plate H2D project
stripped of previews slices to a `.gcode.3mf` carrying freshly rendered
`plate/plate_small/no_light/top/pick` PNGs, ~5s of GL work per slice under emulation.

## The stale-cover half (why fresh renders were not enough)

BambuStudio only *regenerates* thumbnails when they are missing or when its
`filament_color_changed` check fires — and that check compares the project's colours against
`--filament-colour` CLI overrides. PrintStream rewrites colours *into* the project
(`output-metadata.ts`) before the CLI looks, so from where the CLI sits colours never change
and stale source covers were preserved verbatim (the original white/yellow mismatch).

The pipeline now mirrors Bambu's own rule on our side of the rewrite:
`metadataChangesFilamentColours` (output-metadata.ts) detects a real colour override, and
`prepareInputThreeMf` drops the source's plate preview entries (`isPlatePreviewEntry`) from
the prepared input copy. A GL-capable runtime re-renders them into the sliced output; a
runtime that cannot render leaves them missing and `backfillPlateThumbnails` restores the
originals from the *unprepared* input — exactly the pre-fix behaviour.

## Degradation contract

Every piece degrades to thumbnail-less slicing, never a failed slice: no weston / no shim /
no libOSMesa → the CLI logs its GL failure and exits 0, and the service backfills covers from
the input (editor saves also bake their own previews via `embedPlateThumbnails`). The
**native self-hosted app keeps this degraded path deliberately**:
`trimSysrootForHeadlessSlicing` strips libLLVM/gallium/libOSMesa (~180 MB of customer
download) and no weston ships there.

## Where the pieces live

- `apps/slicer/docker/gl-osmesa-shim.c` — the shim (mechanism documented in its header).
- `apps/slicer/docker/bambu-studio-cli.sh` — weston lifecycle + preload wiring, both arches.
- `apps/slicer/docker/build-x86-sysroot.mjs` — `libosmesa6` in the closure; `SYSROOT_REVISION`
  stamp forces existing dev/native sysroots to rebuild when the closure changes.
- `apps/slicer/Dockerfile` — `weston` (+`libosmesa6` on amd64) in the runtime; `glshim` build
  stage cross-compiles the shim on arm64.
- `.devcontainer/Dockerfile` + `scripts/dev/setup-slicer*.mjs` — dev parity (weston, cross
  compiler, per-boot shim compile into the slicer data dir).
- `apps/slicer/src/output-metadata.ts` / `index.ts` — the stale-preview strip.
