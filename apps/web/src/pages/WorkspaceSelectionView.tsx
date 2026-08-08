import ApartmentRoundedIcon from '@mui/icons-material/ApartmentRounded'
import BusinessRoundedIcon from '@mui/icons-material/BusinessRounded'
import CreditCardRoundedIcon from '@mui/icons-material/CreditCardRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import { Card, CardContent, Chip, Stack, Typography } from '@mui/joy'
import type { CustomerSummary, WorkspaceSummary } from '@printstream/shared'
import { BILLING_SCOPE_LABEL } from '../lib/billingScope'
import type { ReactNode } from 'react'
import { BrandMark } from '../components/BrandMark'
import { CONTEXT_CHOOSER_TITLE } from '../lib/workspaceRoute'

/** Section heading in the chooser, separating scopes that are different things. */
function ChoiceGroupLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      level="body-xs"
      textColor="text.tertiary"
      sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', mt: 0.5 }}
    >
      {children}
    </Typography>
  )
}

/**
 * Signed-in chooser for the active scope.
 *
 * Three kinds of destination, and they are genuinely different things rather
 * than one list with flags: a WORKSPACE runs printers, a BILLING account holds
 * licences and the payment method, and the PLATFORM scope administers the
 * deployment. Billing sits above the workspaces because a customer with several
 * reaches it as often as any one of them, and below Platform because almost
 * nobody has that.
 *
 * The default title names none of the three, for the same reason the tab that
 * opens this page does not: the list holds cloud workspaces, the billing
 * context and (for an operator) the platform context, so naming it after one
 * mislabels the other two. The group heading below IS "Cloud workspaces" —
 * that one covers only the cards it sits above. Both strings come from
 * `workspaceRoute.ts` so the door and the room cannot disagree again.
 */
export function WorkspaceSelectionView({
  workspaceOptions,
  customerOptions = [],
  allowPlatformSelection = false,
  onPlatformSelect,
  onCustomerSelect,
  onWorkspaceSelect,
  selectionPending = false,
  title = CONTEXT_CHOOSER_TITLE,
  description
}: {
  workspaceOptions: ReadonlyArray<WorkspaceSummary>
  /** Empty unless the user was explicitly granted billing access, and in a public build. */
  customerOptions?: ReadonlyArray<CustomerSummary>
  allowPlatformSelection?: boolean
  onPlatformSelect?: () => void
  onCustomerSelect?: (customerId: string) => void
  onWorkspaceSelect: (workspaceId: string) => void
  selectionPending?: boolean
  title?: string
  description?: string
}) {
  return (
    <Stack
      justifyContent="center"
      sx={{
        /*
          Reserves the space the shell is NOT using, so the choices sit centred
          on an otherwise empty page.

          The subtracted constants cover `AppShell`'s chrome above and below this
          content: its own padding, the tab bar, the two 4-unit gaps in its
          content column, and the footer. They are deliberately GENEROUS — the
          previous 9rem/11rem were about the footer's height too small, which is
          what pushed this page past the viewport and put a scrollbar on a screen
          holding four cards.

          Under-reserving is the safe direction and costs nothing: the shell root
          is already `minHeight: 100vh` with `mt: auto` on the footer, so it
          fills the viewport and pins the footer regardless of what this asks
          for. Over-reserving is the only way to overflow. `100vh`, not `100dvh`,
          to match the shell root this is measuring against — mixing the two
          drifts by the mobile URL bar.
        */
        minHeight: {
          xs: 'calc(100vh - var(--app-top-inset, 0px) - var(--app-safe-bottom, 0px) - 16rem)',
          sm: 'calc(100vh - var(--app-top-inset, 0px) - 14rem)'
        },
        py: { xs: 2, sm: 4 }
      }}
    >
      <Stack spacing={2} sx={{ width: '100%', maxWidth: 460, mx: 'auto' }}>
        {/* Like sign-in, this stands outside the shell's chrome: no workspace is
            active yet, so the logo bar that normally carries the brand is not
            there. */}
        <BrandMark />
        <Stack spacing={0.75}>
          {/* `h3`, not `h2`: this is a page heading, and the conventions reserve
              `h2` for auth/setup/marketing heroes. Next to the brand mark above
              it, the hero size read as a second, louder title. */}
          <Typography level="h3">{title}</Typography>
          {description ? (
            <Typography level="body-sm" textColor="text.tertiary">
              {description}
            </Typography>
          ) : null}
        </Stack>

        <Stack spacing={1.25}>
          {/*
            Labelled for the same reason "Cloud workspaces" is: once both kinds
            are on screen the reader has to be able to tell them apart, and
            these two are the ones you ADMINISTER from rather than print in.
            Suppressed when neither is present, so a customer with only
            workspaces never sees a heading over nothing.
          */}
          {(allowPlatformSelection && onPlatformSelect) || (onCustomerSelect && customerOptions.length > 0) ? (
            <ChoiceGroupLabel>Administrative workspaces</ChoiceGroupLabel>
          ) : null}

          {allowPlatformSelection && onPlatformSelect ? (
            <WorkspaceChoiceCard
              icon={<ApartmentRoundedIcon />}
              title="Platform"
              bodyDescription="Manage workspaces and platform settings."
              selectionPending={selectionPending}
              onClick={onPlatformSelect}
            />
          ) : null}

          {/*
            No group heading and no per-account name: the card IS the scope, and
            almost everyone has exactly one. The account used to be titled by a
            display name copied off its owner at creation, which then went stale
            the moment they renamed themselves and told the reader nothing the
            card does not.
          */}
          {onCustomerSelect ? customerOptions.map((account) => (
            <WorkspaceChoiceCard
              key={account.id}
              icon={<CreditCardRoundedIcon />}
              title={BILLING_SCOPE_LABEL}
              bodyDescription="License keys, cloud plans, payment method, and invoices."
              selectionPending={selectionPending}
              onClick={() => onCustomerSelect(account.id)}
            />
          )) : null}

          {/*
            Labelled only when there is something above to distinguish them
            from: a user with one workspace and no billing access should not be
            given a heading over a single card.

            "Cloud workspaces" once there IS something above, because what is
            above is the account that also holds SELF-HOSTED licences. The
            distinction only exists where both are on screen.
          */}
          {(onCustomerSelect && customerOptions.length > 0) || allowPlatformSelection ? (
            <ChoiceGroupLabel>Cloud workspaces</ChoiceGroupLabel>
          ) : null}
          {workspaceOptions.map((workspace) => (
            <WorkspaceChoiceCard
              key={workspace.id}
              icon={<BusinessRoundedIcon />}
              title={workspace.name}
              inlineDescription={workspace.description?.trim() || undefined}
              userCount={workspace.userCount}
              printerCount={workspace.printerCount}
              selectionPending={selectionPending}
              onClick={() => onWorkspaceSelect(workspace.id)}
            />
          ))}

          {/*
            A real state, not an error: registration creates an ACCOUNT, so a new
            customer arrives here with nothing to enter yet. Points at the one
            place that can fix it rather than leaving a page with no next step.
          */}
          {workspaceOptions.length === 0 && onCustomerSelect && customerOptions.length > 0 ? (
            <Typography level="body-sm" textColor="text.tertiary" sx={{ textAlign: 'center', px: 2 }}>
              No cloud workspaces yet. Create one from {BILLING_SCOPE_LABEL}, or use your account for a
              self-hosted license instead.
            </Typography>
          ) : null}
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