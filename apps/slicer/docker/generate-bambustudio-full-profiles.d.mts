/**
 * Types for the profile flattener, so TypeScript consumers can import it.
 *
 * The implementation stays plain `.mjs`: it is build tooling the Docker image
 * runs directly with `node`, and it carries the include-merging invariant
 * documented in the slicer development notes. The native app's installer imports it
 * to flatten profiles on the customer's machine.
 */

/**
 * Bake BambuStudio's bundled presets into `machine_full/`/`process_full/`/
 * `filament_full/` under `outputDir`.
 *
 * @param profilesRoot the engine's `resources/profiles` directory
 * @param outputDir defaults to `profilesRoot` (in-place)
 */
export function generateFullProfiles(profilesRoot: string, outputDir?: string): Promise<void>
