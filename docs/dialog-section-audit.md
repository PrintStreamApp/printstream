# Dialog Section Audit

This audit tracks the dialog-section framing convention introduced for the web app.

## Convention

- Multi-section dialogs should render each major content group as a titled section, with the title outside an outlined `Sheet` or `Card`.
- Simple confirm, alert, prompt, and media-viewer dialogs are exempt when they only have one short body region.
- Prefer `apps/web/src/components/DialogSection.tsx` for the common `title + optional helper text + outlined section surface` pattern.

## Already aligned or close enough

- `apps/web/src/pages/LibraryView.tsx` - `SliceFileModal`
- `apps/web/src/pages/LibraryView.tsx` - `PrintModal`
- `apps/web/src/pages/LibraryView.tsx` - `MoveFilesDialog`
- `apps/web/src/pages/LibraryView.tsx` - `FileHistoryDialog`
- `apps/web/src/pages/PrintersView.tsx` - `PrinterSettingsDialog`
- `apps/web/src/pages/PrintersView.tsx` - `PrinterControlsDialog`
- `apps/web/src/pages/PrintersView.tsx` - `LibraryPickerModal`
- `apps/web/src/components/PrinterStorageModal.tsx` - `PrinterStorageModal`
- `apps/web/src/plugins/orders/OrdersView.tsx` - `TemplateLibraryFilePickerDialog`
- `apps/web/src/components/BackAwareModal.tsx` - behavior-only shell
- `apps/web/src/components/ScrollableDialog.tsx` - behavior-only shell
- `apps/web/src/components/DirectoryToolbar.tsx` - `DirectoryFiltersDialog` remains neutral because the child content owns the structure

## Simple dialogs likely exempt

- `apps/web/src/pages/LibraryView.tsx` - `CreateFolderModal`
- `apps/web/src/pages/LibraryView.tsx` - `RenameFileModal`
- `apps/web/src/pages/LibraryView.tsx` - `RenameFolderModal`
- `apps/web/src/pages/LibraryView.tsx` - `MoveFolderModal`
- `apps/web/src/pages/LibraryView.tsx` - printer sync dialog
- `apps/web/src/pages/LibraryView.tsx` - material picker dialog
- `apps/web/src/pages/PrintersView.tsx` - `PrinterSortModal`
- `apps/web/src/pages/PrintersView.tsx` - `CalibrationModal`
- `apps/web/src/pages/PrintersView.tsx` - `AmsSettingsModal`
- `apps/web/src/pages/PrintersView.tsx` - `PrinterAssistantDialog`
- `apps/web/src/pages/PrintersView.tsx` - `FilamentRecoveryDialog`
- `apps/web/src/pages/PrintersView.tsx` - local file upload progress gate
- `apps/web/src/components/ConfirmActionDialog.tsx` - `ConfirmActionDialog`
- `apps/web/src/components/PluginManagerSection.tsx` - uninstall plugin dialog
- `apps/web/src/components/PasskeyRegistrationDialog.tsx` - `PasskeyRegistrationDialog`
- `apps/web/src/components/ProviderRecentVerificationDialog.tsx` - `ProviderRecentVerificationDialog`
- `apps/web/src/components/TenantManagementSection.tsx` - create/edit tenant dialog
- `apps/web/src/components/AuthAccessSection.tsx` - delete group dialog
- `apps/web/src/components/AuthAccessSection.tsx` - delete user dialog
- `apps/web/src/components/AuthAccessSection.tsx` - created service-account token dialog
- `apps/web/src/plugins/auth-local/AuthLocalAccountSecuritySection.tsx` - email verification dialog
- `apps/web/src/plugins/auth-local/AuthLocalUserLifecycleSection.tsx` - invite sent dialog
- `apps/web/src/plugins/orders/OrdersView.tsx` - `EditOrderDialog`
- `apps/web/src/plugins/orders/OrdersView.tsx` - order color picker dialog
- `apps/web/src/components/PrinterJobMediaStrip.tsx` - media viewer dialogs
- `apps/web/src/components/JobHistoryMedia.tsx` - image viewer dialog
- `apps/web/src/pages/MarketingHomePage.tsx` - screenshot viewer modal

## Migration backlog

### Core product dialogs

- `apps/web/src/pages/PrintersView.tsx` - `PrinterViewsModal`
- `apps/web/src/pages/PrintersView.tsx` - `SkipObjectsModal`
- `apps/web/src/pages/PrintersView.tsx` - `AmsDryingModal`
- `apps/web/src/pages/PrintersView.tsx` - `AmsSlotEditModal`
- `apps/web/src/pages/PrintersView.tsx` - `ExternalSpoolEditModal`
- `apps/web/src/pages/PrintersView.tsx` - `PrinterFormModal`
- `apps/web/src/components/PrinterStorageModal.tsx` - `StoragePrintModal`

### Auth and administration dialogs

- `apps/web/src/components/AuthAccessSection.tsx` - `SupportAccessPermissionsDialog`
- `apps/web/src/components/AuthAccessSection.tsx` - `CreateAuthUserDialog`
- `apps/web/src/components/AuthAccessSection.tsx` - `AuthGroupEditorDialog`
- `apps/web/src/components/AuthAccessSection.tsx` - `AuthUserManagementDialog`
- `apps/web/src/components/AuthAccessSection.tsx` - `AuthServiceAccountEditorDialog`

### Plugin dialogs

- `apps/web/src/components/NotificationTemplatesPanel.tsx` - `TemplateEditorDialog`
- `apps/web/src/plugins/orders/OrdersView.tsx` - `TemplateDialog`
- `apps/web/src/plugins/orders/OrdersView.tsx` - `OrderDialog`
- `apps/web/src/plugins/firmware-updates/index.tsx` - `FirmwareUpdateDetailsDialog`

## Suggested rollout order

1. Migrate core printer and storage dialogs first because they are the most visible and closest to the new picker/slice/print reference.
2. Migrate auth and administration dialogs next because they already contain clear internal groupings that mostly need outer section titles.
3. Migrate plugin dialogs last unless a specific plugin screen is actively being redesigned.