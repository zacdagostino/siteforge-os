import * as Dialog from '@radix-ui/react-dialog';
import { CalendarDays, LogOut, Menu, Moon, Settings, Sun, UsersRound, X } from 'lucide-react';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Button } from './ui';

export type AppPage = 'today' | 'prospects' | 'settings';
type Theme = 'light' | 'dark';

const themeStorageKey = 'siteforge-os.theme';

const navigation = [
  { page: 'today' as const, label: 'Today', icon: CalendarDays },
  { page: 'prospects' as const, label: 'Prospects', icon: UsersRound },
  { page: 'settings' as const, label: 'Settings', icon: Settings },
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

function Brand({ hidden = false }: { hidden?: boolean }) {
  return (
    <div className={hidden ? 'brand brand--loading-hidden' : 'brand'}>
      <span>
        <strong>SiteForge OS</strong>
        <small>Modernisation ops</small>
      </span>
    </div>
  );
}

function preferredTheme(): Theme {
  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  } catch {
    // Appearance preference is optional; use the system setting when it cannot be stored.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function AppearanceControl({ theme, onThemeChange }: { theme: Theme; onThemeChange: () => void }) {
  const nextTheme = theme === 'light' ? 'dark' : 'light';

  return (
    <Button
      aria-label={`Switch to ${nextTheme} mode`}
      aria-pressed={theme === 'dark'}
      className="appearance-control"
      onClick={onThemeChange}
      variant="quiet"
    >
      {theme === 'light' ? (
        <Moon aria-hidden="true" size={18} />
      ) : (
        <Sun aria-hidden="true" size={18} />
      )}
      <span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
    </Button>
  );
}

function accountInitials(email: string) {
  const accountName = email.split('@')[0] || email;
  const words = accountName.split(/[._-]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function AccountControl({
  userEmail,
  onSignOut,
}: {
  userEmail?: string;
  onSignOut?: () => Promise<void>;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');

  if (!userEmail || !onSignOut) return null;
  const signOutAction = onSignOut;

  async function signOut() {
    setSigningOut(true);
    setError('');
    try {
      await signOutAction();
    } catch {
      setError('We could not sign you out. Please try again.');
      setSigningOut(false);
    }
  }

  return (
    <section aria-label="Account" className="account-control">
      <div className="account-control__identity" title={userEmail}>
        <span aria-hidden="true" className="account-control__avatar">
          {accountInitials(userEmail)}
        </span>
        <span className="account-control__email">{userEmail}</span>
      </div>
      <Button
        aria-label="Sign out"
        className="account-control__sign-out"
        disabled={signingOut}
        onClick={() => void signOut()}
        size="compact"
        variant="quiet"
      >
        <LogOut aria-hidden="true" size={18} />
        <span className="sr-only">{signingOut ? 'Signing out' : 'Sign out'}</span>
      </Button>
      {error ? (
        <p className="account-control__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function AppShell({
  activePage = 'today',
  children,
  contentKey,
  onNavigate,
  onSignOut,
  userEmail,
  isLoading = false,
}: PropsWithChildren<{
  activePage?: AppPage;
  /** Remounts the content transition when the active route or workspace section changes. */
  contentKey?: string;
  onNavigate?: (page: AppPage) => void;
  onSignOut?: () => Promise<void>;
  userEmail?: string;
  isLoading?: boolean;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const releaseStretchRef = useRef<number | undefined>(undefined);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // The selected appearance remains active for this session when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canScrollWithinTarget = (target: EventTarget | null, direction: number) => {
      let element = target instanceof HTMLElement ? target : null;
      while (element && element !== main) {
        const { overflowY } = window.getComputedStyle(element);
        const canContinue =
          direction < 0
            ? element.scrollTop > 0
            : element.scrollTop + element.clientHeight < element.scrollHeight - 1;
        if (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          element.scrollHeight > element.clientHeight &&
          canContinue
        ) {
          return true;
        }
        element = element.parentElement;
      }
      return false;
    };

    const stretchAtBoundary = (direction: number, force: number) => {
      const atTop = window.scrollY <= 0;
      const atBottom =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
      if ((direction < 0 && !atTop) || (direction > 0 && !atBottom)) return false;

      window.clearTimeout(releaseStretchRef.current);
      main.dataset.overscroll = direction < 0 ? 'top' : 'bottom';
      main.style.setProperty(
        '--overscroll-stretch',
        String(Math.min(0.012, Math.max(0.004, force))),
      );
      releaseStretchRef.current = window.setTimeout(() => {
        main.style.setProperty('--overscroll-stretch', '0');
      }, 80);
      return true;
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      const direction = Math.sign(event.deltaY);
      if (canScrollWithinTarget(event.target, direction)) return;
      if (stretchAtBoundary(direction, Math.abs(event.deltaY) / 5000)) event.preventDefault();
    };

    const onTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (startY === null || currentY === undefined) return;
      const distance = startY - currentY;
      if (Math.abs(distance) < 2) return;
      const direction = Math.sign(distance);
      if (canScrollWithinTarget(event.target, direction)) return;
      if (stretchAtBoundary(direction, Math.abs(distance) / 6000)) event.preventDefault();
    };
    const onTouchEnd = () => {
      touchStartYRef.current = null;
    };

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.clearTimeout(releaseStretchRef.current);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand hidden={isLoading} />
        <Navigation activePage={activePage} onNavigate={onNavigate} />
        <div className="navigation-footer">
          <AppearanceControl
            onThemeChange={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
            theme={theme}
          />
          <AccountControl onSignOut={onSignOut} userEmail={userEmail} />
        </div>
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
                <Brand hidden={isLoading} />
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
              <div className="navigation-footer">
                <AppearanceControl
                  onThemeChange={() =>
                    setTheme((current) => (current === 'light' ? 'dark' : 'light'))
                  }
                  theme={theme}
                />
                <AccountControl onSignOut={onSignOut} userEmail={userEmail} />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Brand hidden={isLoading} />
      </header>

      <main ref={mainRef}>
        <div className="page-transition" key={contentKey}>
          {children}
        </div>
      </main>
    </div>
  );
}
