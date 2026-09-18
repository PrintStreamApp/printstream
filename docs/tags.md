# Tags

Tags organize printers, library files, and inventory spools within one workspace.
Each kind has an independent tag catalog. Printer tags never appear on files or spools,
and editing or deleting one cannot affect those catalogs. Slicing presets do not have tags.

## Assign tags

Open an item's actions menu and choose **Assign tags**. To update several items,
use **Select**, select the items, and choose **Assign tags** in the selection actions.
A mixed checkbox means some selected items already have that tag. Checking it adds
that tag to every selected item; clearing it removes the tag from every selected item.
Tags you leave untouched keep their existing assignments.

You need the item's existing edit permission to assign tags or create a new tag.
Choose a name, display color, and optional group such as Location or Customer. New
tags default to an unused color chosen to stand apart from existing colors in that
entity catalog. You can override it; large catalogs naturally have less distinct colors. Groups keep
large lists of tags organized. Names and groups are completely freeform: for example,
a printer tag named **Phaetus Conch** in the **Nozzle** group can identify machines
with that nozzle. Names are unique within each entity type in a workspace, ignoring
case. The same name can exist independently for printers, files, and spools.
Editing a tag's name, color, or group, and permanently deleting a tag, requires
settings access because these changes affect every item using that tag.

## Find tagged items

Search includes tag names and groups. The **Filters** menu also provides a searchable,
grouped tag picker. Every selected tag must match, including tags from different groups. Other
filters still apply. Clearing the tag filter includes untagged items again.
Tag filters are remembered per workspace and view.

The same filters appear in library and printer pickers, inventory spool selectors,
and the queue's inventory material browser. In the material browser, a material
matches when at least one eligible inventory spool has every selected tag; excluding
loaded spools also excludes their tags from that match. Preset-only slicing choices
keep their existing filters.

Library tag filters run before the result limit. The folder/search scope still
applies, so use **All folders** when searching across folders. Folder and bridge
entries remain available while tags are selected so you can navigate to matching files.

Assignments follow the item rather than a saved file version. Recycling an item
preserves its tags for restoration. Permanently deleting an item clears its
assignments; deleting a tag removes it from every item without deleting any items.

## Job history

Job history search matches tag names and groups across all three independent catalogs.
Open **Filters** to choose **Printer tags**, **File tags**, or **Spool tags**.
A job must match every selected tag across these catalogs; search text, printer, and result
filters still apply. Clear filters removes all selections.
Jobs preserve historical tag copies, including names, groups, and colors. Print jobs
capture printer/file tags when accepted and mapped inventory-spool tags before upload,
including RFID spools and prints that later fail or are cancelled. External starts capture
the active spool slots reported when first observed; unknown slots are not guessed.
Slicing jobs capture source-file and target-printer tags when queued. Their generated
outputs retain those file tags, including on cache hits, so slice-and-print preserves
project tags even after the source project or slicing history is deleted.
Later assignment changes, tag edits, recycling, and permanent deletion do not rewrite
these copies. History filters offer the preserved versions even after live tags disappear.

Existing print jobs receive a one-time baseline of their recoverable assignments on
upgrade. Tags already removed and original file identities never recorded cannot be
reconstructed. Older slicing jobs without snapshots remain unknown rather than using
mutable current tags. Reprints are new jobs and capture current tags for known sources.

Tag chips sort naturally by group and then name (for example, Group 2 before Group 10).
The tag color control offers suggested distinct colors, preset swatches, a custom
color picker, and direct hex entry.
