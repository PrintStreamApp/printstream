/**
 * Slot component for `orders.itemActions`. Adds an "Add to queue" action beside an
 * order item's Print / Mark-done buttons, linking the queued print back to its order
 * print so dispatching from the queue advances the order. Directly-printable files open
 * the add dialog; an unsliced project 3MF is sliced first, then queued. The request is
 * recorded in the shared module store; the always-mounted `orders.overlays` host
 * ({@link LibraryAddToQueueHost}) renders the flow, since the order card re-renders.
 *
 * Cross-plugin by contract: orders exposes the slot + context, the print-queue fills it —
 * neither imports the other.
 */
import { Button, IconButton, Tooltip } from '@mui/joy'
import PlaylistAddRounded from '@mui/icons-material/PlaylistAddRounded'
import { isDirectPrintableFileName } from '@printstream/shared'
import { requestAddToQueue, requestSliceThenQueue } from './libraryAddStore'

export function OrdersAddToQueueAction(props: Record<string, unknown>) {
  const libraryFileId = typeof props.libraryFileId === 'string' ? props.libraryFileId : null
  const fileName = typeof props.fileName === 'string' ? props.fileName : null
  const orderId = typeof props.orderId === 'string' ? props.orderId : null
  const orderPrintId = typeof props.orderPrintId === 'string' ? props.orderPrintId : null
  const plate = typeof props.plate === 'number' ? props.plate : undefined
  const disabled = Boolean(props.disabled)
  const variant = props.variant === 'button' ? 'button' : 'icon'

  if (!libraryFileId || !fileName || !orderId || !orderPrintId) return null
  const printable = isDirectPrintableFileName(fileName)
  // An unsliced project 3MF: a .3mf that isn't a directly-printable sliced output.
  const unslicedThreeMf = !printable && /\.3mf$/i.test(fileName)
  if (!printable && !unslicedThreeMf) return null

  const enqueue = () => {
    const context = { orderLink: { orderId, orderPrintId }, plate }
    if (printable) requestAddToQueue({ id: libraryFileId, name: fileName }, context)
    else requestSliceThenQueue({ id: libraryFileId, name: fileName }, context)
  }

  if (variant === 'button') {
    return (
      <Button
        size="sm"
        variant="soft"
        color="neutral"
        startDecorator={<PlaylistAddRounded />}
        disabled={disabled}
        onClick={enqueue}
      >
        Add to queue
      </Button>
    )
  }

  return (
    <Tooltip title="Add to queue">
      <span>
        <IconButton size="sm" variant="soft" color="neutral" aria-label="Add to queue" disabled={disabled} onClick={enqueue}>
          <PlaylistAddRounded />
        </IconButton>
      </span>
    </Tooltip>
  )
}
