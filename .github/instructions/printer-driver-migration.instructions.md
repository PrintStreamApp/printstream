---
applyTo: "apps/api/src/lib/printer*.ts,apps/api/src/lib/mqtt*.ts,apps/api/src/lib/camera*.ts,apps/api/src/lib/print-dispatcher.ts,apps/api/src/lib/printer-discovery.ts,apps/api/src/routes/printers*.ts,apps/api/src/routes/printer*.ts,apps/api/prisma/schema.prisma,apps/web/src/pages/PrintersView.tsx,packages/shared/src/printer*.ts,packages/shared/src/print-compatibility.ts"
description: "Automatically load the printer driver migration plan when working on printer transport, printer contracts, dispatch, discovery, camera, storage, or vendor capability code."
---

# Printer Driver Migration Instructions

- Treat `docs/printer-driver-migration-plan.md` as the human-readable source of truth for the rules below and keep this file aligned with it.
- Do not implement multi-vendor support opportunistically. Preserve the current Bambu path while creating clean boundaries only when requested or clearly needed.
- Future vendor work should proceed in this order: add vendor identity, isolate Bambu behind an API driver boundary, then split generic core contracts from vendor-specific details, then add a second vendor.
- Do not genericize shared printer status, AMS, external-spool, model, camera, or dispatch contracts before an API driver boundary exists.
- Phase 1 is the first safe schema slice: add `Printer.vendor` defaulting to `bambu`, add shared `printerVendorSchema`, and keep current Bambu columns and behavior unchanged.
- Phase 2 introduces API driver interfaces behind the existing Bambu implementation. Wrap current modules first; do not rewrite parsers before the seam is proven.
- Routes should eventually resolve a driver by printer vendor and delegate connection, status, commands, storage, camera, discovery, validation, and print start semantics to that driver.
- Keep core dispatch responsible for queueing, cancellation, retry bookkeeping, plugin print guards, and job-history metadata. Vendor-specific upload/start semantics belong in drivers.
- Keep the web UI capability-driven over time, but avoid forcing it to understand vendor transport details.
- Bambu-specific concepts should eventually move into explicit Bambu extension objects rather than being embedded in the universal contract.
- Deferred until the driver boundary exists: vendor-neutral model redesign, AMS shape redesign, generic dashboard rewrite, generic camera endpoints, and any second vendor implementation.