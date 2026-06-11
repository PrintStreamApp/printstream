# Slicer Cover Rendering Investigation

This documents the May 2026 investigation into why PrintStream-sliced `.gcode.3mf` files keep stale embedded cover images instead of matching the filament-aware covers produced by the Bambu Studio UI.

## What was confirmed

- The stale white/yellow mismatch is real: PrintStream output was preserving preview assets that already existed in the source project instead of generating fresh covers.
- Bambu's real cover path is a separate CLI action: `--export-png`.
- `--export-png` cannot be combined with the normal slice/export flow, so a correct fix would require a second post-slice render pass.
- Synthetic or rewritten covers were explicitly rejected, so there is no fake-cover fallback.

## What was tried

- Headless `--export-png` through the slicer runtime using the same project/profile inputs as the successful slice flow.
- Additional runtime dependencies for the container, including OSMesa, GLEW, and a headless Weston/Wayland stack.
- Direct probes under the wrapper path, direct `xvfb-run`, Weston with software GL, and Weston with Xwayland.

## Final result

- The runtime moved from hard failures like `OSMesa: Library not found` to a nominally successful `result.json` response.
- Bambu still did not emit any PNG previews.
- The consistent terminal-side blocker was OpenGL thumbnail initialization, ending with messages like:
  - `Unable to init glew library`
  - `init opengl failed! skip thumbnail generating`
- Even with Xwayland available, the bundled binary still preferred the Wayland/GLFW path during `--export-png` probes.

## Current decision

- Do not ship the experimental runtime/image changes.
- Do not wire any cover-generation path into the slicer flow for now.
- Continue shipping the metadata fix for filament/process/printer naming separately.
- Treat embedded cover refresh as deferred work until there is a reproducible way to make Bambu's real thumbnail export succeed in a non-interactive runtime.

## If this is revisited

- Start from a full desktop-class X11 environment instead of the current headless container path.
- Reuse the original-source probe inputs from the investigation, especially the H2D project/profile combination that consistently reproduced the issue.
- Verify actual PNG files are written before attempting any code integration into the slice pipeline.
