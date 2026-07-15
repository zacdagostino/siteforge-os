import * as Dialog from '@radix-ui/react-dialog';
import {
  BarChart3,
  ClipboardCheck,
  Command,
  FileText,
  LayoutPanelTop,
  Menu,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useState, type PropsWithChildren } from 'react';
import { Button } from './ui';

const navigation = [
  { href: '#command', label: 'Command', icon: Command },
  { href: '#pipeline', label: 'Pipeline', icon: LayoutPanelTop },
  { href: '#audit', label: 'Audit', icon: ClipboardCheck },
  { href: '#preview', label: 'Preview', icon: BarChart3 },
  { href: '#report', label: 'Report', icon: FileText },
  { href: '#commercial', label: 'Commercial', icon: LayoutPanelTop },
];

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary navigation" className="navigation-list">
      {navigation.map(({ href, label, icon: Icon }) => (
        <a href={href} key={href} onClick={onNavigate}>
          <Icon aria-hidden="true" size={17} />
          <span>{label}</span>
        </a>
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

export function AppShell({ children }: PropsWithChildren) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <Navigation />
        <Guardrail />
      </aside>

      <header className="mobile-header">
        <Brand />
        <Dialog.Root onOpenChange={setMenuOpen} open={menuOpen}>
          <Dialog.Trigger asChild>
            <Button aria-label="Open navigation menu" size="compact" variant="quiet">
              <Menu aria-hidden="true" size={20} />
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="navigation-overlay" />
            <Dialog.Content aria-describedby={undefined} className="navigation-drawer">
              <div className="drawer-header">
                <Dialog.Title>Navigation</Dialog.Title>
                <Dialog.Close asChild>
                  <Button aria-label="Close navigation menu" size="compact" variant="quiet">
                    <X aria-hidden="true" size={20} />
                  </Button>
                </Dialog.Close>
              </div>
              <Navigation onNavigate={() => setMenuOpen(false)} />
              <Guardrail />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </header>

      <main>{children}</main>
    </div>
  );
}
