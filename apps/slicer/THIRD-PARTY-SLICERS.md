# Third-Party Slicer Engines — AGPL-3.0 Notice and Source Offer

The PrintStream slicer sidecar (`apps/slicer`) invokes an external slicing
engine to convert 3MF projects into G-code. That engine is **not** part of
PrintStream and is **not** an npm dependency — it is a separate program
downloaded unmodified from its publisher and executed as an independent
process (CLI), with data exchanged through files and standard I/O. See
[`docker/install-slicer-targets.mjs`](docker/install-slicer-targets.mjs),
[`docker/slicer-targets.mjs`](docker/slicer-targets.mjs), and
[`docker/bambu-studio-cli.sh`](docker/bambu-studio-cli.sh).

This file provides the attribution, license notice, and corresponding-source
offer required when the slicer container (which embeds these engines) is
distributed and when its slicing capability is offered to users over a network.

## Bundled engine: Bambu Studio

**Bambu Studio** is published by Bambu Lab under the **GNU Affero General
Public License, version 3 (AGPL-3.0)**. The PrintStream slicer image embeds
the following Bambu Studio releases, each downloaded **unmodified** from the
official Bambu Lab GitHub releases:

| Version    | Upstream release (binary)                                                       | Corresponding source (tag)                                      |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 2.6.0.51   | https://github.com/bambulab/BambuStudio/releases/tag/v02.06.00.51               | https://github.com/bambulab/BambuStudio/tree/v02.06.00.51      |
| 2.6.1.55   | https://github.com/bambulab/BambuStudio/releases/tag/v02.06.01.55               | https://github.com/bambulab/BambuStudio/tree/v02.06.01.55      |
| 2.7.0.55   | https://github.com/bambulab/BambuStudio/releases/tag/v02.07.00.55               | https://github.com/bambulab/BambuStudio/tree/v02.07.00.55      |
| 2.7.1.57   | https://github.com/bambulab/BambuStudio/releases/tag/v02.07.01.57               | https://github.com/bambulab/BambuStudio/tree/v02.07.01.57      |
| 2.7.1.62   | https://github.com/bambulab/BambuStudio/releases/tag/v02.07.01.62               | https://github.com/bambulab/BambuStudio/tree/v02.07.01.62      |
| 2.8.0.50 (beta) | https://github.com/bambulab/BambuStudio/releases/tag/v02.08.00.50           | https://github.com/bambulab/BambuStudio/tree/v02.08.00.50      |
| 2.8.1.55 (beta) | https://github.com/bambulab/BambuStudio/releases/tag/v02.08.01.55           | https://github.com/bambulab/BambuStudio/tree/v02.08.01.55      |

The slicer image also reads and re-emits Bambu Studio's bundled printer,
process, and filament presets (`resources/profiles/BBL`). Those profiles are
part of the same Bambu Studio source tree and are covered by the same
AGPL-3.0 terms and the same source pointers above.

### Corresponding source (AGPL §6) and network offer (AGPL §13)

Because PrintStream distributes these AGPL-3.0 binaries inside the slicer
container, and because it offers their slicing functionality to users over a
computer network, the complete corresponding source for each bundled version
is offered to all recipients and remote users. As the binaries are used
without modification, the corresponding source is the upstream source tree at
the exact release tag listed in the table above. A full source archive for any
listed version is also available at:

    https://github.com/bambulab/BambuStudio/archive/refs/tags/<tag>.tar.gz

(for example `.../refs/tags/v02.07.01.57.tar.gz`). The full text of the
AGPL-3.0 accompanies each upstream release and source tree as `LICENSE.txt`.

If PrintStream's own copy of Bambu Studio is ever patched, the modified source
(not just the upstream tag) must be published here and offered to remote users,
per AGPL §5 and §13.

## OrcaSlicer (supported, not currently bundled)

The slicer code can also drive **OrcaSlicer**, which is likewise licensed under
**AGPL-3.0** (https://github.com/SoftFever/OrcaSlicer). No OrcaSlicer release is
bundled in the image today. If an OrcaSlicer download target is added to
`docker/slicer-targets.mjs`, add a row for it above with its pinned version,
release URL, and corresponding-source tag — the same AGPL-3.0 obligations apply.

## Relationship to PrintStream's own license

PrintStream invokes these engines at arm's length as separate processes; it is
not a derivative work of them, and bundling them alongside PrintStream does not
place PrintStream's own source under the AGPL. PrintStream's own code is
licensed separately — see [`LICENSE`](../../LICENSE).

## Trademarks

"Bambu Studio", "Bambu Lab", and "OrcaSlicer" are the marks of their respective
owners. They are used here only to identify the bundled software accurately.
Their use does not imply any affiliation with or endorsement by those owners.
