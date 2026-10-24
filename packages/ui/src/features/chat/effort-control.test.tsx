import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortcutBindings, type Effort, type Mode, type ModelInfo } from '@atelier/protocol';
import { EffortControl } from './effort-control.tsx';

// The person's shortcuts are their preferences; here, the defaults.
vi.mock('../../lib/shortcuts.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShortcut: (id: keyof ReturnType<typeof shortcutBindings>) => shortcutBindings(undefined)[id],
}));

const opus: ModelInfo = {
  ref: 'anthropic/claude-opus-5-5',
  providerId: 'anthropic',
  modelId: 'claude-opus-5-5',
  displayName: 'Claude Opus 5.5',
  contextLength: 1_000_000,
  maxOutput: 128_000,
  capabilities: { tools: 'native', vision: true, pdf: true, reasoning: 'effort', caching: true },
  tier: 'full',
  source: 'catalog',
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  recommendedEffort: { code: 'medium', chat: 'medium', work: 'medium' },
  hidden: false,
  favorite: false,
  order: 0,
};

function Harness({ model = opus, mode = 'code', initial = null, ultracode, onChange }: { model?: ModelInfo; mode?: Mode; initial?: Effort | null; ultracode?: boolean; onChange?: (e: Effort) => void }) {
  const [effort, setEffort] = useState<Effort | null>(initial);
  return (
    <EffortControl
      model={model}
      mode={mode}
      effort={effort}
      ultracode={ultracode}
      onChange={(next) => {
        onChange?.(next);
        setEffort(next);
      }}
    />
  );
}

async function openSlider(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('slider', { name: 'Effort' });
}

/**
 * A WebGL2 stand-in that accepts every call and reports shaders and programs as compiled and linked; it counts the
 * contexts made, the frames drawn and the contexts released. `drop` loses the current context the way a GPU reset does.
 */
function fakeWebGl() {
  const draws = vi.fn();
  // One context at a time: a new one replaces whatever was lost or released.
  let lost = false;
  const loseContext = vi.fn(() => void (lost = true));
  const special: Record<PropertyKey, unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => lost,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
    drawArrays: draws,
  };
  const gl = new Proxy({}, { get: (_, key) => special[key] ?? (() => ({})) });
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => {
    lost = false;
    return type === 'webgl2' ? gl : null;
  }) as typeof HTMLCanvasElement.prototype.getContext);
  const drop = (canvas: HTMLCanvasElement) => {
    lost = true;
    canvas.dispatchEvent(new Event('webglcontextlost'));
  };
  return { contexts: () => getContext.mock.calls.length, getContext, draws, loseContext, drop };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.motion;
});

describe('EffortControl', () => {
  it('offers independent thinking below Extra and hides it at Extra', async () => {
    const toggle = { ...opus, capabilities: { ...opus.capabilities, reasoning: 'toggle' as const } };
    const change = vi.fn();
    const view = render(<EffortControl model={toggle} mode="code" effort="low" onChange={() => {}} thinking onThinkingChange={change} />);
    await openSlider('Effort: Low');
    const thinking = screen.getByRole('switch', { name: 'Thinking' });
    expect(thinking.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(thinking);
    expect(change).toHaveBeenCalledWith(false);
    view.rerender(<EffortControl model={toggle} mode="code" effort="xhigh" onChange={() => {}} thinking={false} onThinkingChange={change} />);
    expect(screen.queryByRole('switch', { name: 'Thinking' })).toBeNull();
  });
  it('offers the model’s levels with Ultracode last in Code, starting at the Recommended one', async () => {
    render(<Harness />);
    const slider = await openSlider('Effort: Medium');
    expect(slider.getAttribute('aria-valuemax')).toBe('5');
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    expect(slider.getAttribute('aria-valuetext')).toBe('Medium (Recommended)');
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByText('Faster')).toBeTruthy();
    expect(screen.getByText('Smarter')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About effort' })).toBeTruthy();
  });

  it('shows the stops a provider fixes, under their own names and warnings, without Ultracode', async () => {
    const picker: ModelInfo = {
      ...opus,
      ref: 'chatgpt-chat/gpt-6',
      providerId: 'chatgpt-chat',
      modelId: 'gpt-6',
      displayName: 'GPT-6',
      effortLevels: undefined,
      recommendedEffort: { chat: 'medium', work: 'high', code: 'high' },
      effortStops: [
        { effort: 'low', label: 'Instant', help: 'Answers right away.' },
        { effort: 'medium', label: 'Medium' },
        { effort: 'high', label: 'High' },
        { effort: 'max', label: 'Pro', help: 'The most capable setting.', warning: 'Pro has a small weekly allowance.' },
      ],
    };
    render(<Harness model={picker} mode="code" />);
    const slider = await openSlider('Effort: High');
    expect(slider.getAttribute('aria-valuemax')).toBe('3');
    expect(slider.getAttribute('aria-valuetext')).toBe('High (Recommended)');
    fireEvent.keyDown(slider, { key: 'End' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Effort: Pro, high usage' })).toBeTruthy());
    const popup = screen.getByRole('dialog', { name: 'Effort' });
    expect(within(popup).getByRole('button', { name: 'Pro has a small weekly allowance.' })).toBeTruthy();
    expect(popup.textContent).not.toMatch(/Ultracode/);
    fireEvent.keyDown(slider, { key: 'Home' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Effort: Instant' })).toBeTruthy());
  });

  it('stops at Max outside Code, and offers every level on a model that doesn’t think at all', async () => {
    const { unmount } = render(<Harness mode="chat" />);
    expect((await openSlider('Effort: Medium')).getAttribute('aria-valuemax')).toBe('4');
    unmount();

    // No reasoning: the control is still there, Low to Max, and is by words alone.
    const { unmount: gone } = render(<Harness mode="chat" model={{ ...opus, capabilities: { ...opus.capabilities, reasoning: 'none' } }} />);
    const slider = await openSlider('Effort: Medium');
    expect(slider.getAttribute('aria-valuemax')).toBe('4');
    expect(screen.getByText('The model answers as it usually does.')).toBeTruthy();
    gone();
  });

  it('gives a thinking-switch model independent effort guidance and forced thinking at Extra and above', async () => {
    const switchModel: ModelInfo = { ...opus, ref: 'ollama/qwen3', providerId: 'ollama', modelId: 'qwen3', capabilities: { ...opus.capabilities, reasoning: 'toggle' }, effortLevels: undefined, tier: 'compact' };
    const changes: Effort[] = [];
    render(<Harness model={switchModel} mode="chat" onChange={(e) => changes.push(e)} />);
    // Medium to begin with: thinking on, the model's usual way. Low to Max, no Ultracode.
    const slider = await openSlider('Effort: Medium');
    expect(slider.getAttribute('aria-valuemax')).toBe('4');
    expect(screen.getByText('Thinking is controlled separately and is recommended. The model answers as it usually does.')).toBeTruthy();
    act(() => slider.focus());
    fireEvent.keyDown(slider, { key: 'End' });
    expect(changes).toEqual(['max']);
    expect(screen.getByRole('button', { name: /^Effort: Max/ })).toBeTruthy();
    expect(screen.getByText('Thinking is always on at this level. The model is asked to apply the most rigor it can and verify everything it can, then re-check its answer.')).toBeTruthy();
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(screen.getByText('Thinking is controlled separately and is recommended. The model is asked to answer directly and keep it short.')).toBeTruthy();
  });

  it('offers Ultracode in Code on a model with only a thinking switch, saying what the model is asked', async () => {
    const switchModel: ModelInfo = { ...opus, ref: 'ollama/qwen3', providerId: 'ollama', modelId: 'qwen3', capabilities: { ...opus.capabilities, reasoning: 'toggle', tools: 'prompted' }, effortLevels: undefined, tier: 'compact' };
    const changes: Effort[] = [];
    render(<Harness model={switchModel} onChange={(e) => changes.push(e)} />);
    const slider = await openSlider('Effort: Medium');
    expect(slider.getAttribute('aria-valuemax')).toBe('5');
    act(() => slider.focus());
    fireEvent.keyDown(slider, { key: 'End' });
    expect(changes).toEqual(['ultracode']);
    expect(slider.getAttribute('aria-valuetext')).toBe('Ultracode');
    expect(screen.getByText(/^Plans each task, .* Thinking is always on at this level\. The model is asked to work step by step, try more than one approach and check each claim\.$/)).toBeTruthy();
  });

  it('steps with the arrow keys and jumps to the ends with Home, End, PageUp and PageDown, committing each step', async () => {
    const changes: Effort[] = [];
    render(<Harness onChange={(e) => changes.push(e)} />);
    const slider = await openSlider('Effort: Medium');
    act(() => slider.focus());
    for (const key of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'End', 'ArrowRight', 'Home', 'ArrowDown', 'PageUp', 'PageDown']) fireEvent.keyDown(slider, { key });
    expect(changes).toEqual(['high', 'xhigh', 'high', 'ultracode', 'low', 'ultracode', 'low']);
    expect(slider.getAttribute('aria-valuetext')).toBe('Low');
    expect(screen.getByRole('button', { name: 'Effort: Low' })).toBeTruthy();
  });

  it('previews the level under a dragged thumb and commits it on release', async () => {
    const changes: Effort[] = [];
    render(<Harness onChange={(e) => changes.push(e)} />);
    const slider = await openSlider('Effort: Medium');
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 196, height: 24, right: 196, bottom: 24, x: 0, y: 0, toJSON: () => ({}) });
    // Six stops over 180px of travel: Extra sits at 8 + 3 × 36 = 116px.
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 118 });
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra');
    expect(slider.hasAttribute('data-dragging')).toBe(true);
    expect(changes).toEqual([]);
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: 118 });
    expect(changes).toEqual(['xhigh']);
    expect(slider.hasAttribute('data-dragging')).toBe(false);
  });

  it('says only the level and, at Max, its usage mark; hovering changes no text', async () => {
    const changes: Effort[] = [];
    render(<Harness onChange={(e) => changes.push(e)} />);
    const slider = await openSlider('Effort: Medium');
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 196, height: 24, right: 196, bottom: 24, x: 0, y: 0, toJSON: () => ({}) });
    const heading = () => screen.getByRole('dialog', { name: 'Effort' }).querySelector('.effort-level-name')!.textContent;
    expect(heading()).toContain('Medium');
    // Hovering over Max (the fifth stop, at 8 + 4 × 36px) changes nothing on screen.
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 152 });
    expect(heading()).toContain('Medium');
    expect(slider.getAttribute('aria-valuetext')).toBe('Medium (Recommended)');
    // Medium has no usage mark; hovering over Max doesn't put one there either.
    expect(screen.queryByRole('button', { name: /Max Usage/ })).toBeNull();
    // Chosen, Max is the level, with the warning mark beside its name (its text is the hover); no note under the slider.
    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 152 });
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: 152 });
    expect(changes).toEqual(['max']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Effort: Max, high usage' })).toBeTruthy());
    const popup = screen.getByRole('dialog', { name: 'Effort' });
    expect(within(popup).getByRole('button', { name: 'Max Usage, consumes 3.5X more Tokens' })).toBeTruthy();
    expect(popup.textContent).not.toMatch(/Applies from|sub-agents/);
    // Back below Max the mark is gone.
    fireEvent.keyDown(slider, { key: 'Home' });
    await waitFor(() => expect(within(popup).queryByRole('button', { name: /Usage/ })).toBeNull());
  });

  it('shows Ultracode in violet with a usage warning, and draws its field only with WebGL2 and without reduced motion', async () => {
    fakeWebGl();
    render(<Harness initial="ultracode" />);
    const chip = screen.getByRole('button', { name: 'Effort: Ultracode, high usage' });
    expect(chip.querySelector('.text-pro')?.textContent).toBe('Ultracode');
    const slider = await openSlider('Effort: Ultracode, high usage');
    expect(slider.hasAttribute('data-at-max')).toBe(true);
    expect(screen.queryByText('Uses far more tokens and takes much longer.')).toBeNull();
    expect(screen.queryByText('Up to 24 sub-agents per request.')).toBeNull();
    await waitFor(() => expect(document.querySelector('canvas[data-ultracode-field]')).toBeTruthy());
    expect(document.querySelector('[data-ultracode-base]')?.className).toContain('opacity-100');
    // It stays where it is when the value moves down (and fades out there): not inside the fill that follows the thumb.
    expect(document.querySelector('[data-slider-fill]')!.contains(document.querySelector('canvas[data-ultracode-field]'))).toBe(false);

    act(() => void (document.documentElement.dataset.motion = 'reduced'));
    await waitFor(() => expect(document.querySelector('canvas')).toBeNull());
    expect(document.querySelector('[data-ultracode-base]')).toBeNull();
    // The name stays violet.
    expect(screen.getAllByText('Ultracode').some((el) => el.closest('.text-pro'))).toBe(true);
  });

  describe('a provider’s last stop drawn like Ultracode', () => {
    const picker = (featured: Record<string, boolean> = { max: true }): ModelInfo => ({
      ...opus,
      ref: 'chatgpt-chat/gpt-6',
      providerId: 'chatgpt-chat',
      modelId: 'gpt-6',
      displayName: 'GPT-6',
      effortLevels: undefined,
      recommendedEffort: { chat: 'medium', work: 'high', code: 'high' },
      effortStops: [
        { effort: 'low', label: 'Instant', ...(featured.low ? { featured: true } : {}) },
        { effort: 'medium', label: 'Medium' },
        { effort: 'high', label: 'High' },
        { effort: 'max', label: 'Pro', warning: 'Pro has a small weekly allowance.', ...(featured.max ? { featured: true } : {}) },
      ],
    });

    it('shows Pro in violet with the charged field, like Ultracode, in any mode, and not on the stops before it', async () => {
      fakeWebGl();
      render(<Harness model={picker()} mode="chat" initial="max" ultracode={false} />);
      const chip = screen.getByRole('button', { name: 'Effort: Pro, high usage' });
      expect(chip.querySelector('.text-pro')?.textContent).toBe('Pro');
      const slider = await openSlider('Effort: Pro, high usage');
      await waitFor(() => expect(document.querySelector('canvas[data-ultracode-field]')).toBeTruthy());
      expect(document.querySelector('[data-ultracode-base]')?.className).toContain('opacity-100');
      // The name in the popover itself (not only the chip) is violet.
      expect(screen.getByRole('dialog', { name: 'Effort' }).querySelector('.effort-level-name .text-pro')?.textContent).toBe('Pro');
      // Off Pro the name is plain and the field cools down.
      fireEvent.keyDown(slider, { key: 'Home' });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Effort: Instant' })).toBeTruthy());
      expect(screen.getByRole('button', { name: 'Effort: Instant' }).querySelector('.text-pro')).toBeNull();
      await waitFor(() => expect(document.querySelector('[data-ultracode-base]')?.className).toContain('opacity-0'));
    });

    it('keeps the violet name and the mark, with no field, under reduced motion', async () => {
      fakeWebGl();
      document.documentElement.dataset.motion = 'reduced';
      render(<Harness model={picker()} mode="code" initial="max" />);
      await openSlider('Effort: Pro, high usage');
      expect(document.querySelector('canvas')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Effort' }).querySelector('.effort-level-name .text-pro')?.textContent).toBe('Pro');
      expect(within(screen.getByRole('dialog', { name: 'Effort' })).getByRole('button', { name: 'Pro has a small weekly allowance.' })).toBeTruthy();
      delete document.documentElement.dataset.motion;
    });

    it.each([['not flagged', {}, 'max'], ['flagged but not last', { low: true }, 'low']])('draws a stop that is %s like any other', async (_name, featured, initial) => {
      fakeWebGl();
      render(<Harness model={picker(featured)} mode="code" initial={initial as Effort} />);
      const chip = screen.getByRole('button', { name: new RegExp(`^Effort: ${initial === 'max' ? 'Pro' : 'Instant'}`) });
      expect(chip.querySelector('.text-pro')).toBeNull();
      await openSlider(chip.getAttribute('aria-label')!);
      expect(document.querySelector('canvas')).toBeNull();
    });

    it('keeps the mark mounted, and its focus, between two levels that both have one', async () => {
      // An ordinary model in Code: Max and Ultracode both carry the usage mark.
      render(<Harness mode="code" initial="max" />);
      const slider = await openSlider('Effort: Max, high usage');
      const dialog = screen.getByRole('dialog', { name: 'Effort' });
      const mark = within(dialog).getByRole('button', { name: 'Max Usage, consumes 3.5X more Tokens' });
      mark.focus();
      fireEvent.keyDown(slider, { key: 'End' });
      await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Ultracode Usage/ })).toBeTruthy());
      expect(within(dialog).getByRole('button', { name: /^Ultracode Usage/ })).toBe(mark);
      expect(document.activeElement).toBe(mark);
    });

    describe('the name’s cell glides to the new name’s width', () => {
      const animate = vi.fn();
      const cancel = vi.fn();
      // jsdom has no layout: a name is ten pixels a letter, the cell is as wide as the name it shows, and while a glide runs
      // (until it is cancelled) the cell is somewhere in between.
      let running = false;
      let equalWidths = false;
      const widthOf = (el: Element) => {
        if (equalWidths) return '30px';
        if (running) return '35px';
        const name = el.querySelector('[data-layer="0"]')?.textContent ?? el.textContent ?? '';
        return `${name.length * 10}px`;
      };
      afterEach(() => {
        vi.restoreAllMocks();
        animate.mockReset();
        cancel.mockReset();
        running = false;
        equalWidths = false;
        delete (Element.prototype as { animate?: unknown }).animate;
        delete document.documentElement.dataset.motion;
      });
      const setUp = () => {
        (Element.prototype as { animate?: unknown }).animate = animate.mockImplementation(() => {
          running = true;
          return { cancel: () => { running = false; cancel(); } };
        });
        const real = window.getComputedStyle.bind(window);
        vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
          const style = real(el, pseudo);
          return el.classList?.contains('effort-level-name') ? new Proxy(style, { get: (target, key) => (key === 'width' ? widthOf(el) : Reflect.get(target, key) instanceof Function ? (Reflect.get(target, key) as (...args: unknown[]) => unknown).bind(target) : Reflect.get(target, key)) }) : style;
        });
      };

      it('from the old width to the new one, over the name’s own time and curve, and starts over from where it is when the level changes again', async () => {
        setUp();
        render(<Harness model={picker()} mode="code" initial="high" />);
        const slider = await openSlider('Effort: High');
        expect(animate).not.toHaveBeenCalled();
        // High (40px) to Pro (30px).
        fireEvent.keyDown(slider, { key: 'End' });
        await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
        expect(animate).toHaveBeenLastCalledWith({ width: ['40px', '30px'] }, { duration: 200, easing: 'cubic-bezier(0.165, 0.84, 0.44, 1)' });
        // Changed again before it ended (the cell is at 35px): the first glide is cancelled and a new one starts from there,
        // to Instant (70px).
        fireEvent.keyDown(slider, { key: 'Home' });
        await waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(animate).toHaveBeenLastCalledWith({ width: ['35px', '70px'] }, expect.objectContaining({ duration: 200 }));
      });

      it('not at all under reduced motion, nor between names of the same width', async () => {
        setUp();
        document.documentElement.dataset.motion = 'reduced';
        render(<Harness model={picker()} mode="code" initial="high" />);
        const slider = await openSlider('Effort: High');
        fireEvent.keyDown(slider, { key: 'End' });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Effort: Pro, high usage' })).toBeTruthy());
        expect(animate).not.toHaveBeenCalled();
        delete document.documentElement.dataset.motion;
        equalWidths = true;
        fireEvent.keyDown(slider, { key: 'Home' });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Effort: Instant' })).toBeTruthy());
        expect(animate).not.toHaveBeenCalled();
      });
    });

    it('brings the warning mark in with the new name instead of leaving it standing where the old name ended', async () => {
      render(<Harness model={picker()} mode="code" initial="high" />);
      const slider = await openSlider('Effort: High');
      const dialog = screen.getByRole('dialog', { name: 'Effort' });
      // Opening the popover on a level without the mark replays nothing.
      expect(dialog.querySelector('.effort-warning-enter')).toBeNull();
      fireEvent.keyDown(slider, { key: 'End' });
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Pro has a small weekly allowance.' })).toBeTruthy());
      // The mark's wrapper plays the entrance with the name, and the old name leaves out of flow (effort.css).
      expect(within(dialog).getByRole('button', { name: 'Pro has a small weekly allowance.' }).closest('.effort-warning-enter')).toBeTruthy();
      expect(dialog.querySelector('.effort-level-name [data-leave]')).toBeTruthy();
    });
  });

  it('draws nothing once reduced motion turns on, even when the level comes back to Ultracode', async () => {
    const gl = fakeWebGl();
    render(<Harness initial="ultracode" />);
    const slider = await openSlider('Effort: Ultracode, high usage');
    await waitFor(() => expect(gl.draws).toHaveBeenCalled());
    // Off the stop, the field cools down and stops drawing.
    fireEvent.keyDown(slider, { key: 'Home' });
    await new Promise((r) => setTimeout(r, 1000));
    act(() => void (document.documentElement.dataset.motion = 'reduced'));
    await waitFor(() => expect(document.querySelector('canvas')).toBeNull());
    const drawn = gl.draws.mock.calls.length;
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuetext')).toBe('Ultracode');
    await new Promise((r) => setTimeout(r, 100));
    expect(gl.draws.mock.calls.length).toBe(drawn);
  });

  it('keeps one WebGL2 context across openings of the popover and releases it when the control goes away', async () => {
    const gl = fakeWebGl();
    const { unmount } = render(<Harness initial="ultracode" />);
    await openSlider('Effort: Ultracode, high usage');
    await waitFor(() => expect(document.querySelector('canvas[data-ultracode-field]')).toBeTruthy());
    const canvas = document.querySelector('canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Effort: Ultracode, high usage' }));
    await waitFor(() => expect(document.querySelector('canvas')).toBeNull());

    await openSlider('Effort: Ultracode, high usage');
    await waitFor(() => expect(document.querySelector('canvas[data-ultracode-field]')).toBe(canvas));
    expect(gl.contexts()).toBe(1);
    expect(gl.loseContext).not.toHaveBeenCalled();
    unmount();
    expect(gl.loseContext).toHaveBeenCalledTimes(1);
  });

  it('stops drawing when the GPU drops the context, falls back to the plain fill, and takes a new one on the next opening', async () => {
    const gl = fakeWebGl();
    render(<Harness initial="ultracode" />);
    await openSlider('Effort: Ultracode, high usage');
    await waitFor(() => expect(gl.draws).toHaveBeenCalled());
    act(() => gl.drop(document.querySelector('canvas')!));
    await waitFor(() => expect(document.querySelector('canvas')).toBeNull());
    expect(document.querySelector('[data-ultracode-base]')).toBeNull();
    const drawn = gl.draws.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(gl.draws.mock.calls.length).toBe(drawn);

    fireEvent.click(screen.getByRole('button', { name: 'Effort: Ultracode, high usage' }));
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
    await openSlider('Effort: Ultracode, high usage');
    await waitFor(() => expect(document.querySelector('canvas[data-ultracode-field]')).toBeTruthy());
    expect(gl.contexts()).toBe(2);
    await waitFor(() => expect(gl.draws.mock.calls.length).toBeGreaterThan(drawn));
  });

  it('tries for a context again on the next opening when there was none', async () => {
    const gl = fakeWebGl();
    gl.getContext.mockImplementationOnce(() => null);
    render(<Harness initial="ultracode" />);
    await openSlider('Effort: Ultracode, high usage');
    expect(document.querySelector('canvas')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Effort: Ultracode, high usage' }));
    await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
    await openSlider('Effort: Ultracode, high usage');
    await waitFor(() => expect(document.querySelector('canvas[data-ultracode-field]')).toBeTruthy());
  });

  it('draws nothing in the fill where WebGL2 is missing', async () => {
    render(<Harness initial="ultracode" />);
    await openSlider('Effort: Ultracode, high usage');
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.querySelector('[data-ultracode-base]')).toBeNull();
  });

  it('leaves Ultracode out when the admin switched it off, showing a session that chose it at Extra', async () => {
    render(<Harness initial="ultracode" ultracode={false} />);
    const slider = await openSlider('Effort: Extra');
    expect(slider.getAttribute('aria-valuemax')).toBe('4');
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra');
  });

  it('shows a session’s new level until its update settles, then what the session stored', async () => {
    let settle!: () => void;
    render(<EffortControl model={opus} mode="code" effort="high" onChange={() => new Promise<void>((r) => (settle = r))} />);
    const slider = await openSlider('Effort: High');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Effort: Extra' })).toBeTruthy();
    await act(async () => settle());
    expect(screen.getByRole('button', { name: 'Effort: High' })).toBeTruthy();
  });

  it('keeps showing the latest of two quick steps while the first one settles', async () => {
    const settles: (() => void)[] = [];
    render(<EffortControl model={opus} mode="code" effort="medium" onChange={() => new Promise<void>((r) => settles.push(r))} />);
    const slider = await openSlider('Effort: Medium');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Effort: Extra' })).toBeTruthy();
    await act(async () => settles[0]!());
    expect(screen.getByRole('button', { name: 'Effort: Extra' })).toBeTruthy();
    await act(async () => settles[1]!());
    expect(screen.getByRole('button', { name: 'Effort: Medium' })).toBeTruthy();
  });

  it('opens on Cmd/Ctrl+Shift+E with the slider focused', async () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'E', shiftKey: true, metaKey: true, ctrlKey: true });
    const slider = await screen.findByRole('slider', { name: 'Effort' });
    await waitFor(() => expect(document.activeElement).toBe(slider));
  });
});
