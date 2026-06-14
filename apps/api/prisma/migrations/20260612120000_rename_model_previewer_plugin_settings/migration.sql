-- The "model-previewer" built-in plugin was renamed to "model-studio".
-- Plugin state (install/enable flags, tenant overrides, scoped settings) is
-- persisted in "Setting" under a "plugin:<name>:" key prefix, so carry the
-- existing rows over to the new name. The new prefix cannot collide: the
-- "model-studio" name did not exist before this rename.
UPDATE "Setting"
SET "key" = 'plugin:model-studio:' || substring("key" FROM length('plugin:model-previewer:') + 1)
WHERE "key" LIKE 'plugin:model-previewer:%';
