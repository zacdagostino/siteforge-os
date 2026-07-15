import type { Meta, StoryObj } from '@storybook/react-vite';
import { AppShell } from './AppShell';
import { Card, Eyebrow } from './ui';

const meta = {
  title: 'SiteForge/App shell',
  component: AppShell,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NavigationResponsive: Story = {
  render: () => (
    <AppShell>
      <Card className="storybook-shell-content">
        <Eyebrow>Work surface</Eyebrow>
        <h1>Responsive navigation shell</h1>
        <p>
          Desktop uses a persistent sidebar. Mobile exposes the same navigation in an accessible
          drawer.
        </p>
      </Card>
    </AppShell>
  ),
};
