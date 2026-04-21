import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FileTree } from '../src/components/FileTree';

describe('<FileTree />', () => {
  it('renders folders and files from a path list', () => {
    render(
      <FileTree
        source={['/repo/src/a.ts', '/repo/src/b.ts', '/repo/README.md']}
        defaultExpanded
      />
    );
    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByText(/repo\/?$/)).toBeInTheDocument();
    expect(screen.getByText('src/')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('parses Glob string output', () => {
    render(<FileTree source={'/r/x.ts\n/r/y.ts'} defaultExpanded />);
    expect(screen.getByText('x.ts')).toBeInTheDocument();
    expect(screen.getByText('y.ts')).toBeInTheDocument();
  });

  it('invokes onSelect when a file row is clicked', () => {
    const onSelect = vi.fn();
    render(<FileTree source={['/r/file.ts']} defaultExpanded onSelect={onSelect} />);
    fireEvent.click(screen.getByText('file.ts'));
    expect(onSelect).toHaveBeenCalledWith('/r/file.ts');
  });

  it('toggles directory open state on click', () => {
    render(<FileTree source={['/r/sub/a.ts']} defaultExpanded={false} />);
    // Collapsed by default: child file should not be visible.
    expect(screen.queryByText('a.ts')).toBeNull();
    fireEvent.click(screen.getByText(/r\/?$/));
    // Now we may need to also expand sub.
    const subBtn = screen.queryByText('sub/');
    if (subBtn) fireEvent.click(subBtn);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('shows "(no files)" placeholder for empty input', () => {
    render(<FileTree source={[]} />);
    expect(screen.getByText('(no files)')).toBeInTheDocument();
  });

  it('marks directory rows with aria-expanded', () => {
    render(<FileTree source={['/r/a.ts']} defaultExpanded />);
    const tree = screen.getByRole('tree');
    const dirItems = within(tree).getAllByRole('treeitem').filter((el) => el.hasAttribute('aria-expanded'));
    expect(dirItems.length).toBeGreaterThan(0);
  });
});
