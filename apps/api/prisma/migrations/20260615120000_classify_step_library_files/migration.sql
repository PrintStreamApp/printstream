-- STEP (.step/.stp) is now a first-class library kind ('step') so it gets a recognized
-- type label and a server-tessellated 3D preview/thumbnail, matching how STL is treated.
-- Existing STEP uploads predate the kind and were stored as 'other'; reclassify them so
-- they pick up the new affordances. classifyLibraryFileKind only resolves 'step' for
-- non-gcode/3mf/stl names, so an 'other' row ending in .step/.stp is unambiguously STEP.
UPDATE "LibraryFile"
SET "kind" = 'step'
WHERE "kind" = 'other'
  AND (lower("name") LIKE '%.step' OR lower("name") LIKE '%.stp');

UPDATE "LibraryFileVersion"
SET "kind" = 'step'
WHERE "kind" = 'other'
  AND (lower("name") LIKE '%.step' OR lower("name") LIKE '%.stp');
