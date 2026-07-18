import * as Dialog from '@radix-ui/react-dialog';
import { CalendarDays, Menu, ShieldCheck, UsersRound, X } from 'lucide-react';
import { useRef, useState, type PropsWithChildren } from 'react';
import { Button } from './ui';

export type AppPage = 'today' | 'prospects';

const navigation = [
  { page: 'today' as const, label: 'Today', icon: CalendarDays },
  { page: 'prospects' as const, label: 'Prospects', icon: UsersRound },
];

function Navigation({
  activePage,
  onNavigate,
}: {
  activePage: AppPage;
  onNavigate?: (page: AppPage) => void;
}) {
  return (
    <nav aria-label="Primary navigation" className="navigation-list">
      {navigation.map(({ page, label, icon: Icon }) => (
        <button
          aria-current={activePage === page ? 'page' : undefined}
          className={
            activePage === page
              ? 'navigation-list__item navigation-list__item--active'
              : 'navigation-list__item'
          }
          key={page}
          onClick={() => onNavigate?.(page)}
          type="button"
        >
          <Icon aria-hidden="true" size={17} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span aria-hidden="true" className="brand__mark">
        SF
      </span>
      <span>
        <strong>SiteForge OS</strong>
        <small>Modernisation ops</small>
      </span>
    </div>
  );
}

function Guardrail() {
  return (
    <div className="guardrail">
      <ShieldCheck aria-hidden="true" size={18} />
      <p>No invented claims. Uncertain facts are review-only until approved.</p>
    </div>
  );
}

export function AppShell({
  activePage = 'today',
  children,
  onNavigate,
}: PropsWithChildren<{ activePage?: AppPage; onNavigate?: (page: AppPage) => void }>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <Navigation activePage={activePage} onNavigate={onNavigate} />
        <Guardrail />
      </aside>

      <header className="mobile-header">
        <Dialog.Root onOpenChange={setMenuOpen} open={menuOpen}>
          <Dialog.Trigger asChild>
            <Button
              aria-label="Open navigation menu"
              className="mobile-menu-trigger"
              ref={menuTriggerRef}
              size="compact"
              variant="quiet"
            >
              <Menu aria-hidden="true" size={20} />
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="navigation-overlay" />
            <Dialog.Content
              aria-describedby={undefined}
              className="navigation-drawer"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                menuTriggerRef.current?.focus();
              }}
            >
              <Dialog.Title className="sr-only">Navigation</Dialog.Title>
              <div className="drawer-header">
                <Brand />
                <Dialog.Close asChild>
                  <Button aria-label="Close navigation menu" size="compact" variant="quiet">
                    <X aria-hidden="true" size={20} />
                  </Button>
                </Dialog.Close>
              </div>
              <Navigation
                activePage={activePage}
                onNavigate={(page) => {
                  onNavigate?.(page);
                  setMenuOpen(false);
                }}
              />
              <Guardrail />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Brand />
      </header>

      <main>{children}</main>
    </div>
  );
}
