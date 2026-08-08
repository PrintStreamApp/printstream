/**
 * A link from the Account page to one of its spun-out pages (Billing,
 * Messages).
 *
 * Both used to render inline as stacked sections. They outgrew that — Billing
 * carries a plan, a promo notice, payment history, a self-hosted key and a
 * licence list; Messages is a conversation inbox — so each is now its own route
 * and Account points at it.
 *
 * Deliberately a card rather than a nav link: it keeps the icon, name, and
 * one-line description the section header used to carry, so the Account page
 * still says what lives behind each one rather than reducing them to two words.
 */
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded'
import { Box, Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import { type ReactNode } from 'react'
import { Link as RouterLink } from 'react-router-dom'

export function AccountDestinationCard({
  to,
  icon,
  title,
  description,
  count
}: {
  to: string
  icon: ReactNode
  title: string
  description: string
  /** Item count, matching the destination's own header. Hidden at zero. */
  count?: number | null
}) {
  return (
    <Card
      component={RouterLink}
      to={to}
      variant="outlined"
      sx={{
        textDecoration: 'none',
        // The whole card is the target, so the affordance has to be the card
        // rather than the title — a hover that only lit the text would make the
        // rest of it look inert.
        transition: 'border-color 120ms ease, background-color 120ms ease',
        '&:hover': { borderColor: 'primary.400', backgroundColor: 'background.level1' }
      }}
    >
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box sx={{ color: 'primary.300', display: 'inline-flex', '& svg': { fontSize: 22 } }}>{icon}</Box>
          <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="title-sm">{title}</Typography>
              {count != null && count > 0 ? (
                <Chip size="sm" variant="soft" color="neutral">{count}</Chip>
              ) : null}
            </Stack>
            <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
          </Stack>
          <Box sx={{ color: 'text.tertiary', display: 'inline-flex', '& svg': { fontSize: 20 } }}>
            <ChevronRightRoundedIcon />
          </Box>
        </Stack>
      </CardContent>
    </Card>
  )
}
