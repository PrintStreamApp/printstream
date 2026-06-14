import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import { Button } from '@mui/joy'

export type TableSortDirection = 'asc' | 'desc'

export function SortableTableHeader({
  label,
  active,
  direction,
  onClick,
  align = 'left'
}: {
  label: string
  active: boolean
  direction: TableSortDirection
  onClick: () => void
  align?: 'left' | 'right'
}) {
  const nextDirection = active && direction === 'asc' ? 'descending' : 'ascending'

  return (
    <Button
      size="sm"
      variant="plain"
      color={active ? 'primary' : 'neutral'}
      onClick={onClick}
      endDecorator={
        active
          ? (direction === 'asc' ? <ArrowUpwardRoundedIcon fontSize="small" /> : <ArrowDownwardRoundedIcon fontSize="small" />)
          : undefined
      }
      sx={{
        px: 0,
        minHeight: 'auto',
        maxWidth: '100%',
        fontWeight: 'lg',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        textAlign: align,
        '--Button-gap': '0.2rem'
      }}
      aria-label={`Sort by ${label.toLowerCase()} ${nextDirection}`}
    >
      {label}
    </Button>
  )
}