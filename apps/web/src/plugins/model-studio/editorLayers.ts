/**
 * Stacking order for everything floating over the editor's 3D viewport.
 *
 * Its own module, and all three in one place, because the values are only meaningful RELATIVE to
 * each other: read apart, each is an arbitrary number next to `theme.zIndex.tooltip`, and the rule
 * that matters is the order. They start from the tooltip layer because the editor is a Joy `Modal`
 * (z-index 1300) and anything painted over the canvas has to clear it.
 *
 * The order, innermost first:
 *
 * 1. {@link VIEWPORT_AID_Z_INDEX} -- viewport aids that are read rather than used: the orientation
 *    cube, the rotation readout. Below the panels, because a panel is the task and an aid is not:
 *    sharing the panels' layer put the cube ON TOP of the boolean panel's text on a phone, where
 *    the panel is tall enough to reach the bottom-left corner, and whichever rendered later won.
 * 2. {@link TOOL_PANEL_Z_INDEX} -- the floating tool panels (cut, paint, text, measure, brim ears,
 *    variable layer height). They float over the canvas and over the aids, and under the chrome.
 * 3. {@link EDITOR_CHROME_Z_INDEX} -- the toolbar and the top strip. Above the panels, because the
 *    toolbar is how you LEAVE the tool you are in: a panel covering it is a dead end escapable only
 *    by guessing a keyboard shortcut. All of this sat on one layer, so the winner was whichever
 *    rendered later in `EditorView`, and the variable-layer-height bar duly painted over the tool
 *    rail, hiding every label the moment the rail was hovered and expanded.
 * 4. {@link EDITOR_POPUP_Z_INDEX} -- context menus and other poppers. Above the chrome, since they
 *    are transient, are often opened FROM the chrome, and are dismissed before anything else can be
 *    used. Raising the toolbar without also raising these would just move the bug: a right-click
 *    near the top-left corner, or a plate menu tall enough to reach the rail, would open underneath.
 *
 * Written as theme callbacks because that is what `sx` takes at each call site. The parameter is
 * structurally typed rather than importing Joy's `Theme`, which is a large type to pull in for one
 * field and is what the callback is handed either way.
 */

type ZIndexTheme = { zIndex: { tooltip: number } }

/** Viewport aids that are only read: under the panels, which are the thing being used. */
export const VIEWPORT_AID_Z_INDEX = (theme: ZIndexTheme) => theme.zIndex.tooltip - 1

/** Floating tool panels: over the canvas and the aids, under the chrome. */
export const TOOL_PANEL_Z_INDEX = (theme: ZIndexTheme) => theme.zIndex.tooltip

/** The toolbar and top strip: never the thing that gets covered. */
export const EDITOR_CHROME_Z_INDEX = (theme: ZIndexTheme) => theme.zIndex.tooltip + 1

/** Context menus and poppers: above everything, including the chrome they open from. */
export const EDITOR_POPUP_Z_INDEX = (theme: ZIndexTheme) => theme.zIndex.tooltip + 2
