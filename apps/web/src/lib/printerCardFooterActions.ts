export interface PrinterCardFooterActionDescriptor {
	key: string
	optional?: boolean
}

interface SkipObjectsActionVisibilityOptions {
	/** Whether the printer's own state allows skipping at all (online, printing or paused, ...). */
	printerCanSkipObjects: boolean
	/**
	 * How many objects the active plate has, or **null when that is not yet known**: the list is
	 * still loading, the request failed, or the printer cannot report one (internal-storage models).
	 * Null and 0 are deliberately different: 0 means "we read the plate and found nothing", which is
	 * a failure the dialog explains, not a single-object plate.
	 */
	objectCount: number | null
}

/**
 * Whether the mid-print "Skip object" action belongs on the card.
 *
 * Hidden on a single-object plate, because skipping the only object is stopping the print with a
 * button that does not say so: the same `>= 2` rule the prepare-print pickers apply. It is hidden
 * ONLY on a definitive count: an unknown one keeps the action, so a slow or unsupported list
 * surfaces its own message instead of silently removing the control.
 */
export function shouldShowSkipObjectsAction({
	printerCanSkipObjects,
	objectCount
}: SkipObjectsActionVisibilityOptions): boolean {
	if (!printerCanSkipObjects) return false
	return objectCount !== 1
}

interface ResolveFooterOverflowKeysOptions {
	actions: readonly PrinterCardFooterActionDescriptor[]
	actionWidths: Readonly<Record<string, number>>
	rowWidth: number | null
	overflowButtonWidth: number
	gapPx: number
}

export function resolvePrinterCardFooterOverflowKeys({
	actions,
	actionWidths,
	rowWidth,
	overflowButtonWidth,
	gapPx
}: ResolveFooterOverflowKeysOptions): Set<string> {
	const overflowKeys = new Set<string>()
	if (rowWidth == null || actions.length === 0) return overflowKeys

	const measurableActions = actions.filter((action) => !action.optional || (actionWidths[action.key] ?? 0) > 0)
	if (
		measurableActions.length === 0
		|| !measurableActions.every((action) => (actionWidths[action.key] ?? 0) > 0)
	) {
		return overflowKeys
	}

	let visibleKeys = measurableActions.map((action) => action.key)
	const widthForKeys = (keys: readonly string[], includeOverflowMenu: boolean) => {
		const buttonsWidth = keys.reduce((total, key) => total + (actionWidths[key] ?? 0), 0)
		const gapCount = includeOverflowMenu ? keys.length : Math.max(0, keys.length - 1)
		return buttonsWidth + gapCount * gapPx + (includeOverflowMenu ? overflowButtonWidth : 0)
	}

	if (widthForKeys(visibleKeys, false) <= rowWidth) return overflowKeys

	while (visibleKeys.length > 0 && widthForKeys(visibleKeys, true) > rowWidth) {
		visibleKeys = visibleKeys.slice(0, -1)
	}

	const visibleKeySet = new Set(visibleKeys)
	for (const action of measurableActions) {
		if (!visibleKeySet.has(action.key)) overflowKeys.add(action.key)
	}

	return overflowKeys
}