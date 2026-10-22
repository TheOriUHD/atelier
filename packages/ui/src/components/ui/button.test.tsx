import { fireEvent, render, screen } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button.tsx';
import { Icon } from './icon.tsx';
import { IconButton } from './icon-button.tsx';

function classesOf(element: Element) {
  return element.getAttribute('class')?.split(/\s+/) ?? [];
}

describe('Button', () => {
  it('defaults to a 32px secondary button of type "button"', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    expect(classesOf(button)).toEqual(
      expect.arrayContaining(['h-8', 'px-3', 'rounded-lg', 'text-body', 'bg-fill-secondary', 'inset-ring']),
    );
  });

  it.each([
    ['primary', ['bg-fill-primary', 'text-on-primary', 'font-medium', 'hover:bg-fill-primary-hover']],
    ['secondary', ['bg-fill-secondary', 'inset-ring-fill-secondary-ring', 'hover:bg-fill-secondary-hover']],
    ['ghost', ['bg-transparent', 'hover:bg-fill-ghost-hover']],
    ['danger', ['bg-danger', 'text-[color:white]']],
    ['brand', ['bg-accent', 'text-on-accent']],
  ] as const)('maps the %s variant to its tokens', (variant, expected) => {
    render(<Button variant={variant}>Go</Button>);
    expect(classesOf(screen.getByRole('button'))).toEqual(expect.arrayContaining([...expected]));
  });

  it.each([
    ['xs', ['h-6', 'px-2', 'rounded-sm', 'text-control-sm']],
    ['sm', ['h-7', 'px-2.5', 'rounded-md']],
    ['md', ['h-8', 'px-3', 'rounded-lg']],
    ['lg', ['h-10', 'px-4', 'rounded-xl']],
  ] as const)('maps size %s to height, padding and radius', (size, expected) => {
    render(<Button size={size}>Go</Button>);
    expect(classesOf(screen.getByRole('button'))).toEqual(expect.arrayContaining([...expected]));
  });

  it('renders a square for iconOnly', () => {
    render(
      <Button iconOnly size="sm" aria-label="Add">
        <Icon icon={Plus} />
      </Button>,
    );
    const classes = classesOf(screen.getByRole('button', { name: 'Add' }));
    expect(classes).toContain('size-7');
    expect(classes).not.toContain('px-2.5');
  });

  it('has press feedback, focus ring and the disabled opacity', () => {
    render(<Button disabled>Go</Button>);
    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(classesOf(button)).toEqual(expect.arrayContaining(['active:scale-99', 'focus-ring', 'disabled:opacity-40']));
  });

  it('renders leading and trailing icons as decorative', () => {
    const { container } = render(
      <Button leadingIcon={Plus} trailingIcon={Plus}>
        New
      </Button>,
    );
    const icons = container.querySelectorAll('svg');
    expect(icons).toHaveLength(2);
    icons.forEach((icon) => expect(icon.getAttribute('aria-hidden')).toBe('true'));
  });

  it('ignores presses and reports busy while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    // The spinner overlays the hidden content, so the width stays the same.
    expect(classesOf(button)).toContain('relative');
    expect(button.querySelector('.invisible')?.textContent).toBe('Save');
    expect(button.querySelector('.absolute svg')).not.toBeNull();
  });

  it('leaves positioning to the caller when not loading', () => {
    render(<Button className="absolute">Go</Button>);
    expect(classesOf(screen.getByRole('button'))).not.toContain('relative');
  });

  it('blocks presses when aria-disabled', () => {
    const onClick = vi.fn();
    render(
      <Button aria-disabled onClick={onClick}>
        Save
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('appends className last', () => {
    render(<Button className="w-full">Go</Button>);
    expect(classesOf(screen.getByRole('button')).at(-1)).toBe('w-full');
  });
});

describe('IconButton', () => {
  it('is a square ghost button named by its label', () => {
    render(<IconButton icon={Plus} label="New chat" />);
    const button = screen.getByRole('button', { name: 'New chat' });
    expect(classesOf(button)).toEqual(expect.arrayContaining(['size-8', 'bg-transparent']));
    expect(button.querySelector('svg')?.getAttribute('width')).toBe('16');
  });

  it('uses a 20px glyph when asked', () => {
    render(<IconButton icon={Plus} label="Attach" iconSize="md" />);
    expect(screen.getByRole('button', { name: 'Attach' }).querySelector('svg')?.getAttribute('width')).toBe('20');
  });
});
