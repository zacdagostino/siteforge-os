import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Card, Eyebrow, StatusBadge } from './ui';

const meta = {
  title: 'SiteForge/Foundation',
  component: Button,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: {
    children: 'Run audit',
  },
};

export const Secondary: Story = {
  args: {
    children: 'Review record',
    variant: 'secondary',
  },
};

export const Disabled: Story = {
  args: {
    children: 'Awaiting URL',
    disabled: true,
  },
};

export const Statuses: Story = {
  render: () => (
    <Card className="storybook-stack">
      <Eyebrow>Review state</Eyebrow>
      <div className="storybook-row">
        <StatusBadge tone="success">Verified</StatusBadge>
        <StatusBadge tone="warning">Needs review</StatusBadge>
        <StatusBadge tone="danger">Blocked</StatusBadge>
      </div>
    </Card>
  ),
};
