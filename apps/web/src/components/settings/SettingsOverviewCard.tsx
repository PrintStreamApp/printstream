/** Shared large navigation card for top-level Settings destinations. */
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import { Card, Stack, Typography } from '@mui/joy'

export function SettingsOverviewCard({
  title,
  description,
  onAction
}: {
  title: string
  description: string
  onAction: () => void
}) {
  return (
    <Card
      component="button"
      type="button"
      variant="outlined"
      onClick={onAction}
      sx={{
        p: 2,
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
        '&:hover': {
          backgroundColor: 'background.level1',
          borderColor: 'primary.softColor'
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'focusVisible',
          outlineOffset: '2px'
        }
      }}
    >
      <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="center">
        <Stack spacing={0.4} sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-lg">{title}</Typography>
          <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
        </Stack>
        <Typography
          aria-hidden="true"
          level="title-lg"
          textColor="text.tertiary"
          sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
        >
          <KeyboardArrowRightRoundedIcon />
        </Typography>
      </Stack>
    </Card>
  )
}
