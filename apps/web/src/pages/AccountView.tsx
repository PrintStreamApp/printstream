import { CurrentAccountPanel } from '../components/CurrentAccountPanel'

/** Dedicated self-service account page for signed-in end users. */
export function AccountView() {
  return <CurrentAccountPanel showHeading showSectionNav />
}