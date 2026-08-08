/**
 * The PrintStream logo, for the surfaces that stand alone.
 *
 * Sign-in and the scope chooser both render OUTSIDE the app's normal chrome:
 * the shell's logo bar only exists once you are in a workspace, so those two
 * screens carried no brand mark at all — a visitor's first and last view of the
 * product was an unlabelled card.
 *
 * Core, not `private/cloud`: both surfaces are core, and the public build ships
 * them. The private marketing pages have their own richer header
 * (`MarketingPageHeader`), which is a different thing — it also offers a way
 * back to the site.
 */
import { Box, Stack, Typography } from '@mui/joy'

export function BrandMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const logo = size === 'sm' ? 32 : 44
  return (
    <Stack
      direction="row"
      spacing={1.25}
      alignItems="center"
      justifyContent="center"
      // Decorative beside its own wordmark: the text below is the accessible
      // name, so announcing the image too would just repeat it.
      aria-hidden="true"
    >
      <Box
        component="img"
        src="/icon-512.png"
        alt=""
        sx={{ width: logo, height: logo, objectFit: 'contain' }}
      />
      <Typography level={size === 'sm' ? 'title-md' : 'title-lg'} sx={{ color: 'common.white' }}>
        PrintStream
      </Typography>
    </Stack>
  )
}
