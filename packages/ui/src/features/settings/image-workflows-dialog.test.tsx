import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { appError, type ImageProviderConfig, type ImageWorkflow } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { ImageWorkflowsDialog } from './image-workflows-dialog.tsx';
import { backend, callsTo, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const parsed: ImageWorkflow = {
  id: 'portrait',
  name: 'Portrait',
  graph: {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, sampler_name: 'euler' } },
    '6': { class_type: 'CLIPTextEncode', _meta: { title: 'Positive' }, inputs: { text: 'a cat' } },
    '7': { class_type: 'CLIPTextEncode', _meta: { title: 'Negative' }, inputs: { text: 'blurry' } },
  },
  map: { prompt: { node: '6', input: 'text' }, seed: { node: '3', input: 'seed' } },
};

const config = (workflows: ImageWorkflow[] = []): ImageProviderConfig => ({ id: 'comfy', type: 'comfyui', preset: 'comfyui', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', apiKey: '${secret:image-provider-comfy}', headers: {}, enabled: true, workflows });

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

function setup(workflows: ImageWorkflow[] = []) {
  resetBackend({ 'imageProviders.parseWorkflow': () => parsed, 'imageProviders.save': (draft: ImageProviderConfig) => draft });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ImageWorkflowsDialog config={config(workflows)} open onOpenChange={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const paste = async () => {
  fireEvent.change(await screen.findByLabelText('Import a workflow'), { target: { value: '{"3":{}}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Read workflow' }));
  return screen.findByRole('dialog', { name: 'Map Portrait' });
};

describe('importing a workflow', () => {
  it('reads pasted JSON, shows what it found, and saves it on the provider', async () => {
    setup();
    const dialog = await paste();
    expect(callsTo('imageProviders.parseWorkflow')).toEqual([{ text: '{"3":{}}', providerId: 'comfy' }]);
    expect(within(dialog).getByRole('combobox', { name: 'Prompt' }).textContent).toContain('Positive #6 · text');
    expect(within(dialog).getByRole('combobox', { name: 'Seed' }).textContent).toContain('KSampler #3 · seed');
    expect(within(dialog).getByRole('combobox', { name: 'Negative prompt' }).textContent).toContain('Not used');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('imageProviders.save')[0]).toMatchObject({ id: 'comfy', workflows: [parsed] }));
  });

  it('never sends the stored key back as a new one', async () => {
    setup();
    fireEvent.click(within(await paste()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('imageProviders.save')).toHaveLength(1));
    expect(callsTo('imageProviders.save')[0]).not.toHaveProperty('apiKey');
  });

  it('lets a person fix the mapping, with only inputs of the right kind', async () => {
    setup();
    const dialog = await paste();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Negative prompt' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toContain('Negative #7 · text');
    expect(options).not.toContain('KSampler #3 · seed');
    pick(screen.getByRole('option', { name: 'Negative #7 · text' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Headshots' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('imageProviders.save')[0]).toMatchObject({ workflows: [{ name: 'Headshots', map: { negative: { node: '7', input: 'text' } } }] }));
  });

  it('won’t save without a prompt input or a name', async () => {
    setup();
    const dialog = await paste();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Prompt' }));
    pick(await screen.findByRole('option', { name: 'Not used' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Choose which input takes the prompt.')).toBeTruthy();
    expect(callsTo('imageProviders.save')).toEqual([]);
  });

  it('says why a workflow can’t be read', async () => {
    setup();
    backend.handlers['imageProviders.parseWorkflow'] = () => {
      throw appError('invalid', 'Export with Save (API).');
    };
    fireEvent.change(await screen.findByLabelText('Import a workflow'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read workflow' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Export with Save (API).');
  });

  it('has nothing to read until something is pasted', async () => {
    setup();
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Read workflow' })).disabled).toBe(true);
  });
});

describe('dropping a file', () => {
  const drop = (file: File) => {
    const box = screen.getByLabelText('Import a workflow').closest('.relative')!;
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [file] } });
  };

  it('sends a JSON file as text', async () => {
    setup();
    await screen.findByLabelText('Import a workflow');
    drop(new File(['{"1":{}}'], 'flow.json', { type: 'application/json' }));
    await screen.findByRole('dialog', { name: 'Map Portrait' });
    expect(callsTo('imageProviders.parseWorkflow')).toEqual([{ text: '{"1":{}}', providerId: 'comfy' }]);
  });

  it('sends a PNG as base64', async () => {
    setup();
    await screen.findByLabelText('Import a workflow');
    drop(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    await screen.findByRole('dialog', { name: 'Map Portrait' });
    expect(callsTo('imageProviders.parseWorkflow')).toEqual([{ pngBase64: 'iVBORw==', providerId: 'comfy' }]);
  });

  it('turns away anything else', async () => {
    setup();
    await screen.findByLabelText('Import a workflow');
    drop(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Drop a PNG or JSON file.');
    expect(callsTo('imageProviders.parseWorkflow')).toEqual([]);
  });
});

describe('the list', () => {
  it('says what each workflow takes, and edits its mapping', async () => {
    setup([parsed]);
    const list = await screen.findByRole('list', { name: 'Workflows' });
    expect(within(list).getByText('Portrait')).toBeTruthy();
    expect(within(list).getByText('Prompt, Seed')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Edit the mapping of Portrait' }));
    expect(await screen.findByRole('dialog', { name: 'Map Portrait' })).toBeTruthy();
  });

  it('removes a workflow after asking', async () => {
    setup([parsed, { ...parsed, id: 'other', name: 'Other' }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Portrait' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Remove Portrait?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(callsTo('imageProviders.save')[0]).toMatchObject({ workflows: [{ id: 'other' }] }));
  });

  it('replaces a workflow imported again under the same id', async () => {
    setup([{ ...parsed, name: 'Old' }]);
    fireEvent.click(within(await paste()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('imageProviders.save')[0]).toMatchObject({ workflows: [{ id: 'portrait', name: 'Portrait' }] }));
  });
});
