import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CommandOutput } from './command-output';
import type { CommandOutputBlock } from '@/types/command-wire';

const block = (text: string, ansi?: string): CommandOutputBlock => ({
  text,
  ansi: ansi ?? text,
});

describe('CommandOutput', () => {
  it('renders command echo in the header', () => {
    render(<CommandOutput input="/help" blocks={[block('some output')]} />);
    expect(screen.getByText('/help')).toBeTruthy();
  });

  it('renders block text content', () => {
    render(<CommandOutput input="/cost" blocks={[block('Total: $0.01')]} />);
    expect(screen.getByText('Total: $0.01')).toBeTruthy();
  });

  it('renders multiple blocks in order', () => {
    render(
      <CommandOutput
        input="/tools"
        blocks={[block('Tool A'), block('Tool B'), block('Tool C')]}
      />,
    );
    expect(screen.getByText('Tool A')).toBeTruthy();
    expect(screen.getByText('Tool B')).toBeTruthy();
    expect(screen.getByText('Tool C')).toBeTruthy();
  });

  it('has a copy button', () => {
    render(<CommandOutput input="/help" blocks={[block('output')]} />);
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
  });

  it('has accessible region label', () => {
    render(<CommandOutput input="/debug" blocks={[block('debug info')]} />);
    expect(screen.getByRole('region', { name: /output for \/debug/i })).toBeTruthy();
  });

  it('renders empty blocks without crashing', () => {
    const { container } = render(<CommandOutput input="/noop" blocks={[]} />);
    expect(container.firstChild).toBeTruthy();
  });
});
