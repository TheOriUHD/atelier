import { describe, expect, it } from 'vitest';
import { IMAGE_PROVIDER_PRESETS } from '@atelier/protocol';
import { adapterDeps, imageInstance } from './__fixtures__/harness.ts';
import { createImageAdapter } from './index.ts';

describe('createImageAdapter', () => {
  it.each(['a1111', 'forge', 'sdnext', 'koboldcpp', 'drawthings', 'swarmui', 'invokeai', 'sd-server', 'localai'])('has an adapter for the %s preset', (id) => {
    const preset = IMAGE_PROVIDER_PRESETS.find((p) => p.id === id)!;
    const adapter = createImageAdapter(imageInstance(preset.type, preset.id, preset.baseUrl), adapterDeps({}).deps);
    expect(adapter.type).toBe(preset.type);
  });
});
