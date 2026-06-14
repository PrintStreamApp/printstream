import ApartmentRoundedIcon from '@mui/icons-material/ApartmentRounded'
import BusinessRoundedIcon from '@mui/icons-material/BusinessRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import { Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import type { TenantSummary } from '@printstream/shared'
import type { ReactNode } from 'react'

/** Signed-in chooser for selecting the active workspace context. */
export function WorkspaceSelectionView({
  tenantOptions,
  allowPlatformSelection = false,
  onPlatformSelect,
  onTenantSelect,
  selectionPending = false,
  title = 'Choose a workspace',
  description
}: {
  tenantOptions: ReadonlyArray<TenantSummary>
  allowPlatformSelection?: boolean
  onPlatformSelect?: () => void
  onTenantSelect: (tenantId: string) => void
  selectionPending?: boolean
  title?: string
  description?: string
}) {
  return (
    <Stack
      justifyContent="center"
      sx={{
        minHeight: {
          xs: 'calc(100dvh - var(--app-top-inset, 0px) - 11rem)',
          sm: 'calc(100dvh - var(--app-top-inset, 0px) - 9rem)'
        },
        py: { xs: 2, sm: 4 }
      }}
    >
      <Stack spacing={2} sx={{ width: '100%', maxWidth: 460, mx: 'auto' }}>
        <Stack spacing={0.75}>
          <Typography level="h2">{title}</Typography>
          {description ? (
            <Typography level="body-sm" textColor="text.tertiary">
              {description}
            </Typography>
          ) : null}
        </Stack>

        <Stack spacing={1.25}>
          {allowPlatformSelection && onPlatformSelect ? (
            <WorkspaceChoiceCard
              icon={<ApartmentRoundedIcon />}
              title="Platform"
              bodyDescription="Manage tenants and platform settings."
              selectionPending={selectionPending}
              onClick={onPlatformSelect}
            />
          ) : null}

          {tenantOptions.map((tenant) => (
            <WorkspaceChoiceCard
              key={tenant.id}
              icon={<BusinessRoundedIcon />}
              title={tenant.name}
              inlineDescription={tenant.description?.trim() || undefined}
              userCount={tenant.userCount}
              printerCount={tenant.printerCount}
              selectionPending={selectionPending}
              onClick={() => onTenantSelect(tenant.id)}
            />
          ))}
        </Stack>
      </Stack>
    </Stack>
  )
}

function WorkspaceChoiceCard({
  icon,
  title,
  inlineDescription,
  bodyDescription,
  userCount,
  printerCount,
  selectionPending,
  onClick
}: {
  icon: ReactNode
  title: string
  inlineDescription?: string
  bodyDescription?: string
  userCount?: number
  printerCount?: number
  selectionPending: boolean
  onClick: () => void
}) {
  return (
    <Card
      component="button"
      type="button"
      variant="outlined"
      disabled={selectionPending}
      onClick={onClick}
      sx={{
        textAlign: 'left',
        cursor: selectionPending ? 'default' : 'pointer',
        transition: 'background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease',
        '&:hover': selectionPending
          ? undefined
          : {
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
      <CardContent>
        <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="center">
          <Stack spacing={1.25} sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography level="title-lg" sx={{ display: 'inline-flex', alignItems: 'center' }}>
                {icon}
              </Typography>
              <Typography level="title-lg">{title}</Typography>
            </Stack>
            {inlineDescription ? (
              <Typography level="body-sm" textColor="text.tertiary">
                {inlineDescription}
              </Typography>
            ) : null}
            {userCount != null || printerCount != null ? (
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                {userCount != null ? <Chip size="sm" variant="soft">{formatCount(userCount, 'user')}</Chip> : null}
                {printerCount != null ? <Chip size="sm" variant="soft">{formatCount(printerCount, 'printer')}</Chip> : null}
              </Stack>
            ) : null}
            {bodyDescription ? (
              <Typography level="body-sm" textColor="text.tertiary">
                {bodyDescription}
              </Typography>
            ) : null}
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
      </CardContent>
    </Card>
  )
}

function formatCount(value: number, noun: string): string {
  return `${new Intl.NumberFormat().format(value)} ${noun}${value === 1 ? '' : 's'}`
}